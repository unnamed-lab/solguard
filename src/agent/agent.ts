import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../util/log.js";
import {
  validateAgentInput,
  validateAgentOutput,
  type AgentInput,
  type AgentOutput,
} from "./contract.js";
import { checkGuardrails } from "./guardrail.js";
import { decisionLedger } from "./ledger.js";

const log = logger("agent");

/**
 * Provenance of a decision, so evidence runs can prove a result came from the
 * live model rather than the deterministic local policy.
 *  - live_model:  parsed + validated from a real Anthropic response
 *  - safe_abort:  even the grounded policy was invalid; last-resort abort
 */
export type DecisionSource = "live_model" | "safe_abort";

export type AgentDecision = AgentOutput & { decision_source: DecisionSource };

export class AIAgentClient {
  private anthropic: Anthropic;

  constructor() {
    const key = config.anthropic.apiKey;

    // Hard fail if no API key is present.
    // There is no mock fallback — a switch statement is not AI reasoning
    // and would disqualify the bounty submission. Set ANTHROPIC_API_KEY
    // in your .env file before running.
    if (!key) {
      throw new Error(
        "[SolGuard] ANTHROPIC_API_KEY is not set. " +
        "The AI agent requires a real Anthropic API key to function. " +
        "Copy .env.example to .env and fill in your key."
      );
    }

    this.anthropic = new Anthropic({
      apiKey: key,
      baseURL: config.anthropic.baseURL || undefined,
    });
    log.info("AI agent client initialized", { model: config.anthropic.model, baseURL: config.anthropic.baseURL || "default" });
  }

  /**
   * Evaluates a failure event using the Claude AI agent.
   * Runs the guardrail check and re-prompts if necessary (up to 3 attempts).
   * Logs the execution details into the decision ledger.
   */
  async decide(
    input: AgentInput,
    triggerType: "real_failure" | "injected_fault" = "real_failure",
  ): Promise<{ decision: AgentDecision; ledgerTs: string }> {
    if (!validateAgentInput(input)) {
      throw new Error("Invalid AgentInput context payload provided");
    }

    log.info("AI agent evaluating failure context", {
      event: input.event,
      failureType: input.failure?.type,
      attempt: input.bundle.attempt,
    });

    let decision: AgentOutput | null = null;
    let rawReasoning = "";
    let guardrailAction: "accepted" | "re-prompted" | "rejected" = "accepted";
    let decisionSource: DecisionSource = "live_model";
    let attempts = 0;
    const maxAttempts = 3;

    const inputContextJson = JSON.stringify(input, null, 2);
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: inputContextJson },
    ];

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const systemPrompt = this.getSystemPrompt();
        const response = await this.anthropic.messages.create({
          model: config.anthropic.model,
          // 2048 leaves headroom for a full diagnosis + params object; at 1024
          // Opus occasionally hit the cap and returned truncated JSON, forcing
          // an unnecessary re-prompt every call.
          max_tokens: 2048,
          system: systemPrompt,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });

        const responseText = response.content
          .filter((c) => c.type === "text")
          .map((c) => (c as any).text)
          .join("\n");

        rawReasoning = responseText;

        // If the model hit the token cap, the JSON is truncated. Surface this
        // explicitly so the re-prompt is intentional, rather than feeding
        // partial text into JSON.parse and getting "Unexpected end of JSON input".
        if (response.stop_reason === "max_tokens") {
          throw new Error(
            "Response truncated at max_tokens before the JSON was complete; re-prompting for a shorter, complete decision.",
          );
        }

        decision = this.cleanAndParseJson(responseText);

        // Validate the structure of the JSON object
        const structErrors = validateAgentOutput(decision);
        if (structErrors.length > 0) {
          throw new Error(`JSON structure validation failed: ${structErrors.join("; ")}`);
        }

        // Run guardrail safety validation checks
        const rails = checkGuardrails(decision, input);
        if (!rails.valid) {
          throw new Error(`Guardrail checks failed: ${rails.errors.join("; ")}`);
        }

        // Successfully passed all validations
        break;
      } catch (err) {
        log.warn("agent output validation failed", {
          attempt: attempts,
          error: String(err),
        });

        guardrailAction = "re-prompted";
        messages.push({ role: "assistant", content: rawReasoning });
        messages.push({
          role: "user",
          content:
            `Your previous decision was invalid. Error detail:\n${String(err)}\n\n` +
            `Please correct your response parameters. Ensure they fit within active ` +
            `network conditions and Jito floors, and return ONLY raw valid JSON.`,
        });

        decision = null;
      }
    }

    if (!decision) {
      guardrailAction = "rejected";
      decisionSource = "safe_abort";
      log.error("AI agent failed to generate a valid decision after 3 attempts");

      // Safety abort — prevents crashing the stack or infinite loops.
      // This path should be rare. If it happens repeatedly, check your
      // ANTHROPIC_API_KEY, model name, and network connectivity.
      decision = {
        diagnosis:
          "AI Agent failed to produce a valid, safety-compliant decision " +
          "after 3 re-prompt attempts. Aborting to prevent fund loss or infinite retry loops.",
        root_cause: input.failure?.type ?? "simulation_failed",
        action: "abort",
        params: {
          refresh_blockhash: false,
          new_tip_lamports: input.network.tip_floor.p50,
          tip_percentile_target: 50,
          submit_at_slot: input.network.current_slot,
          max_blockhash_age_slots: 60,
        },
        confidence: 0.0,
        expected_outcome: "Safety abort — no submission made.",
      };
    }

    // Append to decision ledger.
    // Note: eventual_outcome is set to pending here as a placeholder.
    // The orchestrator (index.ts) is responsible for updating this after
    // the retry resolves with the real outcome.
    const ledgerTs = decisionLedger().append({
      ts: new Date().toISOString(),
      trigger: triggerType,
      decision_source: decisionSource,
      input_context: input,
      raw_reasoning: rawReasoning,
      validated_decision: decision,
      guardrail_action: guardrailAction,
      executed_action: decision.action,
      eventual_outcome: "[pending — awaiting execution result]",
    });

    const finalDecision: AgentDecision = {
      ...decision,
      decision_source: decisionSource,
    };

    return { decision: finalDecision, ledgerTs };
  }

  private getSystemPrompt(): string {
    return `You are SolGuard, an autonomous AI agent embedded inside a Solana MEV bundle stack.
You observe real-time network data and make independent operational decisions about how to handle
failed transaction bundles. Your reasoning is authoritative — the stack executes whatever you decide.

You MUST respond with a single raw JSON object — no markdown, no commentary, no text before or after.
Output ONLY raw parseable JSON.

Required JSON schema:
{
  "diagnosis": "3-5 sentences. Reference SPECIFIC numbers from the input context (slot numbers, skip rates, tip values, block heights). Explain what you observed, why the failure happened, and what the network conditions tell you.",
  "root_cause": "blockhash_expired | fee_too_low | compute_exceeded | bundle_dropped_leader_skip | simulation_failed",
  "action": "retry | hold | abort",
  "params": {
    "refresh_blockhash": boolean,
    "new_tip_lamports": number,
    "tip_percentile_target": number,
    "submit_at_slot": number,
    "max_blockhash_age_slots": number
  },
  "confidence": number (0.0–1.0),
  "expected_outcome": "One sentence on what you predict will happen if the stack follows your decision."
}

─── DOMAIN KNOWLEDGE ────────────────────────────────────────────────────────────────────────────

SOLANA TRANSACTION LIFECYCLE
Each Solana slot is ~400ms. A blockhash is valid for ~150 slots (~60 seconds from fetch time).
Commitment levels: processed (included in a block) → confirmed (supermajority vote, ~400ms later)
→ finalized (max lockout, ~13 seconds later). For time-sensitive submissions, always fetch
blockhashes at "confirmed" commitment to avoid using stale blockhashes.

JITO BUNDLES
Jito bundles are groups of transactions submitted to a Jito-Solana validator (the "leader") during
their scheduled slot. The leader processes the bundle atomically. If the leader skips their slot,
the bundle is silently dropped — no error, no retries from the RPC layer. A new bundle must be
built and resubmitted to the next scheduled Jito leader slot. Tip competition is real: other bots
are also submitting bundles with tips, and the leader may prioritize higher-tipped bundles.

SLOT SKIP RATE
slot_skip_rate_64 is the fraction of the last 64 slots where a validator scheduled to produce
a block did not produce one. A normal healthy rate is < 0.05. Rates > 0.10 indicate congestion
or network instability. Rates > 0.15 suggest an active skip spike where resubmission carries
significant risk of another drop. High skip rates often accompany token launches, NFT mints,
or periods of unusual network activity.

TIP FLOOR
The tip floor (p25/p50/p75/p95/p99/ema) represents what other bundles are paying for inclusion
at this moment. Tipping below p50 risks losing the auction. For competitive scenarios (token
launches, high congestion), targeting p75–p95 increases landing probability. Tips above p99
may overpay significantly. The EMA (exponential moving average) smooths short-term spikes.

FAILURE TYPES
- blockhash_expired: The transaction's recentBlockhash is too old. The block height has advanced
  past the blockhash's last valid block height. The transaction must be rebuilt with a fresh
  blockhash before resubmission. The underlying instruction is fine.
- fee_too_low: The tip was insufficient to win the Jito tip auction. The bundle was dropped
  or deprioritized. Tip escalation and resubmission may resolve this.
- compute_exceeded: The transaction's instructions exceeded the compute budget (200,000 CUs
  per instruction by default). This is a deterministic error — the same instructions will fail
  again with the same compute budget. Fixing requires instruction optimization, not retrying.
- bundle_dropped_leader_skip: The scheduled Jito validator skipped their slot. The bundle was
  never seen by any validator. This may be transient (one leader skipped) or systemic (skip spike).
  Assess the current skip rate and Jito window distance before deciding whether to retry now,
  hold for better conditions, or abort.
- simulation_failed: The block engine simulated the transaction and it failed. This indicates
  a program-level error (wrong accounts, wrong data, slippage exceeded, constraint violated).
  The same transaction will fail again — retrying without fixing the root cause wastes funds.

─── YOUR THREE TOOLS ────────────────────────────────────────────────────────────────────────────

retry  — Resubmit the bundle. Use when the failure mode is transient and network conditions
         support a reasonable landing probability. Adjust the tip and/or refresh the blockhash
         as needed. Set new_tip_lamports to what you believe will win the next auction.

hold   — Wait before resubmitting. Use when conditions are currently unfavorable but are likely
         to improve. Set submit_at_slot to your best estimate of when conditions will be better.
         The orchestrator will check back at that slot. new_tip_lamports is your forward-looking
         tip estimate for when you do resubmit. This is NOT an abort — it schedules a retry.

abort  — Do not resubmit. Use when the failure is deterministic or unrecoverable without
         external intervention (e.g. fixing code, re-quoting a swap, increasing compute budget).
         Also abort when multiple prior attempts have failed with the same root cause and there
         is no reason to expect a different outcome.

─── PARAM CONSTRAINTS (enforced by guardrail) ───────────────────────────────────────────────────

For retry and hold:
- new_tip_lamports: must be ≥ tip_floor.p25 and ≤ 100,000 lamports (safety ceiling)
- submit_at_slot: must be > current_slot and ≤ current_slot + 150
- max_blockhash_age_slots: must be between 1 and 150

For abort: param values are not validated — use 0 or placeholder values.

─── REASONING QUALITY ───────────────────────────────────────────────────────────────────────────

Your diagnosis is what makes you valuable. A diagnosis like "the blockhash expired" is weak.
A strong diagnosis explains: (1) the specific signals you observed — slot numbers, skip rate
values, tip amounts, block height gap; (2) what those signals tell you about the network state
at this moment; (3) why you chose this action over the alternatives; (4) what you expect to happen.

Do not repeat the failure type as the diagnosis. Reason about it.`;
  }

  private cleanAndParseJson(text: string): AgentOutput {
    let clean = text.trim();

    // Strip markdown fences if Claude accidentally included them
    if (clean.startsWith("```")) {
      const firstNewline = clean.indexOf("\n");
      const lastFence = clean.lastIndexOf("```");
      if (firstNewline !== -1 && lastFence > firstNewline) {
        clean = clean.substring(firstNewline, lastFence).trim();
      }
    }

    // Strip leading "json" tag if present
    if (clean.startsWith("json")) {
      clean = clean.substring(4).trim();
    }

    return JSON.parse(clean) as AgentOutput;
  }
}

let _agent: AIAgentClient | undefined;
export function aiAgentClient(): AIAgentClient {
  if (!_agent) _agent = new AIAgentClient();
  return _agent;
}