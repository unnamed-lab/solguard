import type { FailureRecord } from "../lifecycle/types.js";
import type { TipFloor } from "../tips/tipFloor.js";

export interface AgentInput {
  event: "bundle_failed" | "pre_submit_evaluation";
  failure: FailureRecord | null;
  bundle: {
    attempt: number;
    tip_lamports: number;
    tip_account: string;
    submitted_slot: number;
    target_leader_slot: number;
  };
  network: {
    current_slot: number;
    slot_skip_rate_64: number;
    processed_to_confirmed_ms_p50: number;
    tip_floor: TipFloor;
    next_jito_leader_slot: number;
    slots_until_jito_leader: number;
  };
  history: Array<{
    attempt: number;
    outcome: string;
  }>;
}

export interface AgentOutput {
  diagnosis: string;
  root_cause: string;
  action: "retry" | "hold" | "abort";
  params: {
    refresh_blockhash: boolean;
    new_tip_lamports: number;
    tip_percentile_target: number;
    submit_at_slot: number;
    max_blockhash_age_slots: number;
  };
  confidence: number;
  expected_outcome: string;
}

/** Validate that the agent input conforms to the contract. */
export function validateAgentInput(input: any): boolean {
  if (!input || typeof input !== "object") return false;
  if (input.event !== "bundle_failed" && input.event !== "pre_submit_evaluation") return false;
  if (!input.bundle || typeof input.bundle !== "object") return false;
  if (typeof input.bundle.attempt !== "number") return false;
  if (typeof input.bundle.tip_lamports !== "number") return false;
  if (typeof input.bundle.tip_account !== "string") return false;
  if (typeof input.bundle.submitted_slot !== "number") return false;
  if (typeof input.bundle.target_leader_slot !== "number") return false;

  if (!input.network || typeof input.network !== "object") return false;
  if (typeof input.network.current_slot !== "number") return false;
  if (typeof input.network.slot_skip_rate_64 !== "number") return false;
  if (typeof input.network.processed_to_confirmed_ms_p50 !== "number") return false;
  if (!input.network.tip_floor || typeof input.network.tip_floor !== "object") return false;
  if (typeof input.network.next_jito_leader_slot !== "number") return false;
  if (typeof input.network.slots_until_jito_leader !== "number") return false;

  if (!Array.isArray(input.history)) return false;

  return true;
}

/**
 * Validate that the parsed output object conforms to the strict output contract.
 * Returns an array of error messages; empty array means valid.
 */
export function validateAgentOutput(output: any): string[] {
  const errors: string[] = [];
  if (!output || typeof output !== "object") {
    errors.push("Output is not a JSON object");
    return errors;
  }

  if (typeof output.diagnosis !== "string" || output.diagnosis.trim().length === 0) {
    errors.push("diagnosis must be a non-empty string");
  }

  const validCauses = [
    "blockhash_expired",
    "fee_too_low",
    "compute_exceeded",
    "bundle_dropped_leader_skip",
    "simulation_failed",
  ];
  if (typeof output.root_cause !== "string" || !validCauses.includes(output.root_cause)) {
    errors.push(`root_cause must be one of: ${validCauses.join(", ")}`);
  }

  if (output.action !== "retry" && output.action !== "hold" && output.action !== "abort") {
    errors.push("action must be retry, hold, or abort");
  }

  if (!output.params || typeof output.params !== "object") {
    errors.push("params must be an object");
  } else {
    const p = output.params;
    if (typeof p.refresh_blockhash !== "boolean") {
      errors.push("params.refresh_blockhash must be a boolean");
    }
    if (typeof p.new_tip_lamports !== "number" || p.new_tip_lamports < 0) {
      errors.push("params.new_tip_lamports must be a non-negative number");
    }
    if (typeof p.tip_percentile_target !== "number") {
      errors.push("params.tip_percentile_target must be a number");
    }
    if (typeof p.submit_at_slot !== "number") {
      errors.push("params.submit_at_slot must be a number");
    }
    if (typeof p.max_blockhash_age_slots !== "number") {
      errors.push("params.max_blockhash_age_slots must be a number");
    }
  }

  if (typeof output.confidence !== "number" || output.confidence < 0 || output.confidence > 1) {
    errors.push("confidence must be a number between 0.0 and 1.0");
  }

  if (typeof output.expected_outcome !== "string" || output.expected_outcome.trim().length === 0) {
    errors.push("expected_outcome must be a non-empty string");
  }

  return errors;
}
