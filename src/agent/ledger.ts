import { JsonlWriter } from "../util/jsonl.js";
import { logger } from "../util/log.js";
import { bridge } from "../events/bridge.js";
import type { AgentInput, AgentOutput } from "./contract.js";

const log = logger("ledger");

export interface DecisionLedgerEntry {
  ts: string;
  trigger: "real_failure" | "injected_fault";
  /** Provenance of the decision: live_model | local_mock | grounded_fallback | safe_abort. */
  decision_source: "live_model" | "local_mock" | "grounded_fallback" | "safe_abort";
  input_context: AgentInput;
  raw_reasoning: string;
  validated_decision: AgentOutput | null;
  guardrail_action: "accepted" | "re-prompted" | "rejected";
  executed_action: "retry" | "hold" | "abort";
  // Placeholder at decision time — updated after execution resolves.
  // Format: "landed @ slot 312915" | "retry failed: blockhash_expired"
  // | "aborted — compute_exceeded not recoverable"
  eventual_outcome: string;
}

export interface OutcomePatch {
  type: "outcome_patch";
  original_ts: string;
  bundle_id: string;
  resolved_at: string;
  eventual_outcome: string;
}

export class DecisionLedger {
  private writer: JsonlWriter;

  // In-memory map of ts → entry so we can look up the
  // original decision when the outcome arrives.
  private pending = new Map<string, DecisionLedgerEntry>();

  constructor(logPath = "logs/decisions.jsonl") {
    this.writer = new JsonlWriter(logPath);
  }

  /**
   * Appends a new decision entry to the ledger.
   * eventual_outcome is a placeholder at this point — call
   * updateOutcome() once the retry/hold/abort resolves.
   * Returns the entry's ts so the caller can reference it later.
   */
  append(entry: DecisionLedgerEntry): string {
    try {
      this.writer.append(entry);
      // Keep in memory so updateOutcome() can find it
      this.pending.set(entry.ts, entry);

      log.info("logged agent decision to ledger", {
        ts: entry.ts,
        action: entry.executed_action,
        rootCause: entry.validated_decision?.root_cause ?? "unknown",
        placeholderOutcome: entry.eventual_outcome,
      });

      bridge.emit("decision_event", {
        triggeredAt: entry.ts,
        trigger: entry.trigger,
        decision_source: entry.decision_source,
        input_context: entry.input_context,
        rawReasoning: entry.raw_reasoning,
        diagnosis: entry.validated_decision?.diagnosis,
        rootCause: entry.validated_decision?.root_cause,
        action: entry.executed_action,
        params: entry.validated_decision?.params
          ? {
              refreshBlockhash: entry.validated_decision.params.refresh_blockhash,
              newTipLamports: entry.validated_decision.params.new_tip_lamports,
              tipPercentileTarget: entry.validated_decision.params.tip_percentile_target,
              submitAtSlot: entry.validated_decision.params.submit_at_slot,
              maxBlockhashAgeSlots: entry.validated_decision.params.max_blockhash_age_slots,
            }
          : undefined,
        confidence: entry.validated_decision?.confidence,
        expected_outcome: entry.validated_decision?.expected_outcome,
        guardrail_action: entry.guardrail_action,
        executed_action: entry.executed_action,
        eventual_outcome: entry.eventual_outcome,
      });
    } catch (err) {
      log.error("failed to write to decision ledger", { err: String(err) });
    }

    return entry.ts;
  }

  /**
   * Called by the orchestrator after execution resolves.
   * Appends an outcome patch entry so the ledger has a real result.
   *
   * Example usage:
   *   const ts = decisionLedger().append({ ... });
   *   // ... execute the decision ...
   *   decisionLedger().updateOutcome(ts, bundleId, "landed @ slot 312915");
   *
   * @param originalTs  - the ts returned from append()
   * @param bundleId    - the bundle this decision was for
   * @param outcome     - what actually happened
   */
  updateOutcome(originalTs: string, bundleId: string, outcome: string): void {
    const patch: OutcomePatch = {
      type: "outcome_patch",
      original_ts: originalTs,
      bundle_id: bundleId,
      resolved_at: new Date().toISOString(),
      eventual_outcome: outcome,
    };

    try {
      this.writer.append(patch);
      this.pending.delete(originalTs);

      log.info("updated decision outcome in ledger", {
        original_ts: originalTs,
        bundleId,
        outcome,
      });
    } catch (err) {
      log.error("failed to write outcome patch to ledger", { err: String(err) });
    }
  }
}

let _ledger: DecisionLedger | undefined;
export function decisionLedger(): DecisionLedger {
  if (!_ledger) _ledger = new DecisionLedger();
  return _ledger;
}
