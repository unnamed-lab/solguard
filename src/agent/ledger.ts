import { JsonlWriter } from "../util/jsonl.js";
import { logger } from "../util/log.js";
import type { AgentInput, AgentOutput } from "./contract.js";

const log = logger("ledger");

export interface DecisionLedgerEntry {
  ts: string;
  trigger: "real_failure" | "injected_fault";
  input_context: AgentInput;
  raw_reasoning: string;
  validated_decision: AgentOutput | null;
  guardrail_action: "accepted" | "re-prompted" | "rejected";
  executed_action: "retry" | "hold" | "abort";
  eventual_outcome: string;
}

export class DecisionLedger {
  private writer: JsonlWriter;

  constructor(logPath = "logs/decisions.jsonl") {
    this.writer = new JsonlWriter(logPath);
  }

  append(entry: DecisionLedgerEntry): void {
    try {
      this.writer.append(entry);
      log.info("logged agent decision to ledger", {
        action: entry.executed_action,
        rootCause: entry.validated_decision?.root_cause ?? "unknown",
        outcome: entry.eventual_outcome,
      });
    } catch (err) {
      log.error("failed to write to decision ledger", { err: String(err) });
    }
  }
}

let _ledger: DecisionLedger | undefined;
export function decisionLedger(): DecisionLedger {
  if (!_ledger) _ledger = new DecisionLedger();
  return _ledger;
}
