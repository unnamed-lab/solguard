import { config } from "../config.js";
import type { AgentInput, AgentOutput } from "./contract.js";

export interface GuardrailResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates the AI agent decision against strict network safety boundaries (PRD §8, AGENT.md §5).
 * It returns an object containing a boolean flag and a list of specific error messages if any boundaries are violated.
 */
export function checkGuardrails(output: AgentOutput, input: AgentInput): GuardrailResult {
  const errors: string[] = [];

  // 1. Tip bounds: must be in [tip_floor.p25, TIP_CEILING_LAMPORTS]
  const p25 = input.network.tip_floor.p25;
  const ceiling = config.tips.ceilingLamports;
  const tip = output.params.new_tip_lamports;

  if (tip < p25) {
    errors.push(`new_tip_lamports (${tip}) is below the p25 floor (${p25})`);
  }
  if (tip > ceiling) {
    errors.push(`new_tip_lamports (${tip}) exceeds the safety ceiling (${ceiling})`);
  }

  // 2. submit_at_slot is in the future
  const currentSlot = input.network.current_slot;
  const submitSlot = output.params.submit_at_slot;

  if (submitSlot < currentSlot) {
    errors.push(`submit_at_slot (${submitSlot}) is in the past compared to current slot (${currentSlot})`);
  }
  // limit future window to 150 slots to ensure the blockhash doesn't expire before then
  if (submitSlot > currentSlot + 150) {
    errors.push(`submit_at_slot (${submitSlot}) is too far in the future (max is ${currentSlot + 150})`);
  }

  // 3. max_blockhash_age_slots <= 150 (legal blockhash validity window on Solana)
  const maxAge = output.params.max_blockhash_age_slots;
  if (maxAge > 150) {
    errors.push(`max_blockhash_age_slots (${maxAge}) exceeds Solana maximum of 150 slots`);
  }
  if (maxAge <= 0) {
    errors.push(`max_blockhash_age_slots (${maxAge}) must be positive`);
  }

  // 4. action and confidence validation (already covered by contract, but reinforce)
  if (!["retry", "hold", "abort"].includes(output.action)) {
    errors.push(`action must be retry, hold, or abort. Got "${output.action}"`);
  }

  if (output.confidence < 0 || output.confidence > 1) {
    errors.push(`confidence must be between 0 and 1. Got ${output.confidence}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
