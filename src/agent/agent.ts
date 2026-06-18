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
    return `You are the SolGuard AI Decision Agent, an expert Solana infrastructure engineer.
Your task is to analyze a Solana transaction bundle failure and decide what to do next.

You MUST respond with a single raw JSON object.
DO NOT wrap in markdown code blocks. DO NOT output any text before or after the JSON.
Output ONLY raw parseable JSON — nothing else.

The JSON schema you MUST follow exactly:
{
  "diagnosis": "2-4 sentences referencing the ACTUAL signals from the input (slots, skip rate, tip values, etc.)",
  "root_cause": "blockhash_expired | fee_too_low | compute_exceeded | bundle_dropped_leader_skip | simulation_failed",
  "action": "retry | hold | abort",
  "params": {
    "refresh_blockhash": boolean,
    "new_tip_lamports": number,
    "tip_percentile_target": number,
    "submit_at_slot": number,
    "max_blockhash_age_slots": number
  },
  "confidence": number between 0.0 and 1.0,
  "expected_outcome": "one sentence describing what you expect to happen"
}

Decision rules — your behavior MUST vary based on conditions:

1. RETRY: use when the failure is recoverable and network conditions are favorable.
   - blockhash_expired → refresh blockhash, target next Jito leader slot
   - fee_too_low → escalate tip to a higher percentile (p75 or p95)

2. HOLD: use when network conditions are unfavorable RIGHT NOW but may improve.
   - slot_skip_rate_64 > 0.15 → hold, do not submit into a skip spike
   - slots_until_jito_leader > 20 → hold until the window is closer

   For HOLD, set params as follows:
   - refresh_blockhash: true if the current blockhash will be stale by
     the time conditions improve (i.e. blockhash_age_slots + estimated
     wait > max_blockhash_age_slots), otherwise false.
   - new_tip_lamports: the tip you WOULD use if conditions improve to
     the point of resubmission — typically tip_floor.p50 or p75, not 0.
     This is a forward-looking estimate, not a submission.
   - submit_at_slot: your best estimate of the slot where conditions
     will be favorable again (e.g. current_slot + slots_until_jito_leader,
     or current_slot + a small buffer past the skip spike).
   - tip_percentile_target: the percentile you'd target on resubmission.
   - max_blockhash_age_slots: the max age you'd accept on resubmission
     (≤150).

   The orchestrator will re-evaluate at submit_at_slot rather than
   submitting immediately. HOLD is a "check back later" signal, not
   a cancellation.

3. ABORT: use when the failure is not recoverable by retrying.
   - compute_exceeded → abort, the instruction itself needs fixing
   - simulation_failed → abort, inspect the program error first
   - 3+ failed attempts with the same root cause → abort

Example — HOLD during a skip spike:
Given: current_slot=312901, slot_skip_rate_64=0.21, tip_floor.p50=5000,
       next_jito_leader_slot=312930, slots_until_jito_leader=29
{
  "diagnosis": "slot_skip_rate_64 is 0.21, well above the 0.15 hold threshold, indicating an active skip spike at slot 312901. The next Jito leader is 29 slots away at 312930. Submitting now risks landing during the spike. Holding until conditions stabilize near the next Jito window is safer than retrying immediately.",
  "root_cause": "bundle_dropped_leader_skip",
  "action": "hold",
  "params": {
    "refresh_blockhash": true,
    "new_tip_lamports": 5000,
    "tip_percentile_target": 50,
    "submit_at_slot": 312930,
    "max_blockhash_age_slots": 60
  },
  "confidence": 0.7,
  "expected_outcome": "Re-evaluate at slot 312930 when the skip spike has likely subsided and the next Jito leader is active."
}

Critical rules:
- Your diagnosis MUST reference actual numbers from the input (e.g. "slot_skip_rate_64 of 0.18 exceeds the 0.15 threshold").
- new_tip_lamports MUST be between tip_floor.p25 and the safety ceiling — except for ABORT, where this field is a forward-looking estimate and not validated.
- submit_at_slot MUST be greater than current_slot and within 150 slots — except for ABORT, where this field is not validated.
- max_blockhash_age_slots MUST be between 1 and 150 — except for ABORT, where this field is not validated.`;
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