import { config } from "../config.js";
import type { AgentInput, AgentOutput } from "./contract.js";

export interface GuardrailResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates the AI agent decision against strict network safety boundaries
 * (PRD §8, AGENT.md §5).
 *
 * For "retry" and "hold" actions, all submission-related parameters
 * (tip, slot, blockhash age) are validated — these will be used to
 * actually submit or schedule a bundle.
 *
 * For "abort" actions, submission-related parameters are NOT validated.
 * Nothing is being submitted, so a tip of 0 or a stale submit_at_slot
 * is semantically correct and should not trigger a re-prompt. Forcing
 * Claude to fill these with "valid-looking" numbers it doesn't need
 * would itself be a form of dressed-up hardcoding.
 *
 * action and confidence are always validated, regardless of action type.
 */
export function checkGuardrails(output: AgentOutput, input: AgentInput): GuardrailResult {
  const errors: string[] = [];

  // --- Always validated, regardless of action ---

  if (!["retry", "hold", "abort"].includes(output.action)) {
    errors.push(`action must be retry, hold, or abort. Got "${output.action}"`);
  }

  if (output.confidence < 0 || output.confidence > 1) {
    errors.push(`confidence must be between 0 and 1. Got ${output.confidence}`);
  }

  // --- Submission-related checks: skip entirely for "abort" ---

  if (output.action === "abort") {
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // From here on, action is "retry" or "hold" — these parameters
  // will actually be used to submit or schedule a bundle.

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

  return {
    valid: errors.length === 0,
    errors,
  };
}