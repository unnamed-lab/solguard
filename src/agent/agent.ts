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

export class AIAgentClient {
  private anthropic?: Anthropic;

  constructor() {
    const key = config.anthropic.apiKey;
    if (key) {
      this.anthropic = new Anthropic({ apiKey: key });
      log.info("AI agent client initialized with Anthropic SDK", { model: config.anthropic.model });
    } else {
      log.warn("ANTHROPIC_API_KEY is not set; running in local mock fallback mode");
    }
  }

  /**
   * Evaluates a failure event using the agent.
   * Runs the guardrail check and re-prompts if necessary (up to 3 attempts).
   * Logs the execution details into the decision ledger.
   */
  async decide(
    input: AgentInput,
    triggerType: "real_failure" | "injected_fault" = "real_failure",
  ): Promise<AgentOutput> {
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
    let attempts = 0;
    const maxAttempts = 3;

    // We keep a simple list of message inputs for the re-prompt chat history
    const inputContextJson = JSON.stringify(input, null, 2);
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: inputContextJson },
    ];

    while (attempts < maxAttempts) {
      attempts++;
      try {
        if (this.anthropic) {
          // Live path using Claude
          const systemPrompt = this.getSystemPrompt();
          const response = await this.anthropic.messages.create({
            model: config.anthropic.model,
            max_tokens: 1024,
            system: systemPrompt,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
          });

          const responseText = response.content
            .filter((c) => c.type === "text")
            .map((c) => (c as any).text)
            .join("\n");

          rawReasoning = responseText;
          decision = this.cleanAndParseJson(responseText);
        } else {
          // Local mock fallback path (grounded on input signals)
          const mockResponse = this.generateMockDecision(input);
          rawReasoning = JSON.stringify(mockResponse, null, 2);
          decision = mockResponse;
        }

        // Validate the structure of the JSON object
        const structErrors = validateAgentOutput(decision);
        if (structErrors.length > 0) {
          throw new Error(`JSON structure validation failed: ${structErrors.join("; ")}`);
        }

        // Run guardrail safety boundary validation checks
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
          content: `Your previous decision was invalid. Error detail:\n${String(err)}\n\nPlease correct your response parameters. Ensure they fit within active network conditions and Jito floors, and return ONLY raw valid JSON.`,
        });

        decision = null;
      }
    }

    if (!decision) {
      guardrailAction = "rejected";
      log.error("AI agent failed to generate a valid decision after multiple attempts");
      // Create a fallback safe "abort" decision instead of crashing the stack
      decision = {
        diagnosis: "AI Agent failed to construct a valid safety-compliant decision after multiple retries.",
        root_cause: input.failure?.type ?? "simulation_failed",
        action: "abort",
        params: {
          refresh_blockhash: false,
          new_tip_lamports: input.network.tip_floor.p25,
          tip_percentile_target: 25,
          submit_at_slot: input.network.current_slot,
          max_blockhash_age_slots: 60,
        },
        confidence: 0.0,
        expected_outcome: "Safety abort to prevent loss of funds or infinite loop.",
      };
    }

    // Append to decision ledger logs
    decisionLedger().append({
      ts: new Date().toISOString(),
      trigger: triggerType,
      input_context: input,
      raw_reasoning: rawReasoning,
      validated_decision: decision,
      guardrail_action: guardrailAction,
      executed_action: decision.action,
      eventual_outcome: decision.expected_outcome,
    });

    return decision;
  }

  private getSystemPrompt(): string {
    return `You are the SolGuard AI Decision Agent, an expert Solana Systems Architect.
Your task is to analyze transaction bundle failure context and decide on retries: retry, hold, or abort.

You MUST respond with a single JSON object. DO NOT wrap the JSON in markdown code blocks (like \`\`\`json ... \`\`\`) and do not output any other text. Output ONLY raw parseable JSON.

The JSON schema you MUST conform to:
{
  "diagnosis": "2-4 sentences referencing the actual input signals",
  "root_cause": "blockhash_expired | fee_too_low | compute_exceeded | bundle_dropped_leader_skip | simulation_failed",
  "action": "retry | hold | abort",
  "params": {
    "refresh_blockhash": boolean,
    "new_tip_lamports": number,
    "tip_percentile_target": number,
    "submit_at_slot": number,
    "max_blockhash_age_slots": number
  },
  "confidence": number,
  "expected_outcome": "string explanation"
}

Anti-Disqualification Rules:
1. "diagnosis" MUST refer to actual slots, skip rates, tips, and other input fields.
2. The tip parameters must be calibrated. Raising tip during high congestion, holding during skip spikes, and aborting repeated simulation errors.`;
  }

  private cleanAndParseJson(text: string): AgentOutput {
    let clean = text.trim();
    // remove markdown wrappers if the LLM leaked them
    if (clean.startsWith("```")) {
      const firstLineEnd = clean.indexOf("\n");
      const lastFence = clean.lastIndexOf("```");
      if (firstLineEnd !== -1 && lastFence !== -1) {
        clean = clean.substring(firstLineEnd, lastFence).trim();
      }
    }
    // strip the leading "json" from ```json if present
    if (clean.startsWith("json")) {
      clean = clean.substring(4).trim();
    }
    return JSON.parse(clean) as AgentOutput;
  }

  /**
   * Generates a high-fidelity local decision mirroring the logic a real
   * Claude client would generate, grounded on the input network parameters.
   */
  private generateMockDecision(input: AgentInput): AgentOutput {
    const failureType = input.failure?.type ?? "simulation_failed";
    const currentSlot = input.network.current_slot;
    const tf = input.network.tip_floor;

    // Normal base tip calculations
    const baseTip = tf.p50;
    const nextJitoSlot = input.network.next_jito_leader_slot;

    switch (failureType) {
      case "blockhash_expired": {
        // Blockhash age limit exceeded, require a refreshed blockhash and resubmit
        const targetTip = Math.min(config.tips.ceilingLamports, Math.max(tf.p25, Math.round(tf.p75 * (input.network.slot_skip_rate_64 > 0.1 ? 1.5 : 1.0))));
        return {
          diagnosis: `Blockhash has expired because slot age error occurred. Current slot ${currentSlot} exceeded validity limits of last valid blockheight. Recommending a retry with a refreshed blockhash and a target tip of ${targetTip} lamports (75th percentile).`,
          root_cause: "blockhash_expired",
          action: "retry",
          params: {
            refresh_blockhash: true,
            new_tip_lamports: targetTip,
            tip_percentile_target: 75,
            submit_at_slot: currentSlot + 1,
            max_blockhash_age_slots: 60,
          },
          confidence: 0.95,
          expected_outcome: "Land successfully in the next active slot using a refreshed confirmed blockhash.",
        };
      }
      case "fee_too_low": {
        // Tip was below median floor, escalate tip to win Jito auction
        const escalatedTip = Math.min(config.tips.ceilingLamports, Math.max(tf.p25, Math.round(tf.p95 * 1.1)));
        return {
          diagnosis: `The Jito tip of ${input.bundle.tip_lamports} lamports was below the median floor (${tf.p50} lamports) under a congestion multiplier. Recommending a tip escalation to ${escalatedTip} lamports targeting the 95th percentile to secure execution.`,
          root_cause: "fee_too_low",
          action: "retry",
          params: {
            refresh_blockhash: false,
            new_tip_lamports: escalatedTip,
            tip_percentile_target: 95,
            submit_at_slot: currentSlot + 1,
            max_blockhash_age_slots: 60,
          },
          confidence: 0.90,
          expected_outcome: "Secure bundle inclusion by outbidding competitor slots at the Jito auction.",
        };
      }
      case "bundle_dropped_leader_skip": {
        // Jito leader skipped slot or window missed, target next window
        const safeTip = Math.min(config.tips.ceilingLamports, Math.max(tf.p25, tf.p50));
        const submitSlot = nextJitoSlot > currentSlot ? nextJitoSlot : currentSlot + 1;
        return {
          diagnosis: `Target Jito leader slot was skipped or window closed. The stream reports slots_until_jito_leader as ${input.network.slots_until_jito_leader}. Recommending to hold and submit at slot ${submitSlot} for the next scheduled Jito leader.`,
          root_cause: "bundle_dropped_leader_skip",
          action: "retry",
          params: {
            refresh_blockhash: true,
            new_tip_lamports: safeTip,
            tip_percentile_target: 50,
            submit_at_slot: submitSlot,
            max_blockhash_age_slots: 60,
          },
          confidence: 0.88,
          expected_outcome: "Submit the bundle at the start of the next Jito validator schedule block.",
        };
      }
      case "compute_exceeded": {
        // Exceeded CUs, abort or require adjustments (out-of-scope for simple retry)
        return {
          diagnosis: `The transaction execution failed simulation because the requested compute budget was exceeded. Aborting submission to prevent further failures.`,
          root_cause: "compute_exceeded",
          action: "abort",
          params: {
            refresh_blockhash: false,
            new_tip_lamports: baseTip,
            tip_percentile_target: 50,
            submit_at_slot: currentSlot,
            max_blockhash_age_slots: 60,
          },
          confidence: 0.99,
          expected_outcome: "Terminate submission process and avoid wasting tips on invalid instructions.",
        };
      }
      case "simulation_failed":
      default: {
        return {
          diagnosis: `The bundle execution failed simulation checks with a custom program error. Safe to abort and inspect instructions.`,
          root_cause: "simulation_failed",
          action: "abort",
          params: {
            refresh_blockhash: false,
            new_tip_lamports: baseTip,
            tip_percentile_target: 50,
            submit_at_slot: currentSlot,
            max_blockhash_age_slots: 60,
          },
          confidence: 0.95,
          expected_outcome: "Halt transaction processing to investigate simulation failure.",
        };
      }
    }
  }
}

let _agent: AIAgentClient | undefined;
export function aiAgentClient(): AIAgentClient {
  if (!_agent) _agent = new AIAgentClient();
  return _agent;
}
