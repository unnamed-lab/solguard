import { describe, it, expect } from "vitest";
import { validateAgentInput, validateAgentOutput, type AgentInput, type AgentOutput } from "../contract.js";
import { checkGuardrails } from "../guardrail.js";

function getValidInput(): AgentInput {
  return {
    event: "bundle_failed",
    failure: {
      type: "blockhash_expired",
      evidence: { blockhash_age_slots: 47, last_valid_slot: 312900 },
      detectedAtSlot: 312901,
      ts: new Date().toISOString(),
    },
    bundle: {
      attempt: 1,
      tip_lamports: 5000,
      tip_account: "96gYZGLnJYVFihjz5EPg5Q8pD8krrG1685mYdBt9Q7tb",
      submitted_slot: 312847,
      target_leader_slot: 312850,
    },
    network: {
      current_slot: 312901,
      slot_skip_rate_64: 0.04,
      processed_to_confirmed_ms_p50: 380,
      tip_floor: {
        p25: 1000,
        p50: 5000,
        p75: 12000,
        p95: 25000,
        p99: 50000,
        ema: 6200,
        fetchedAt: Date.now(),
      },
      next_jito_leader_slot: 312912,
      slots_until_jito_leader: 11,
    },
    history: [{ attempt: 1, outcome: "expired" }],
  };
}

function getValidOutput(): AgentOutput {
  return {
    diagnosis: "The slot age exceeded validity bounds. Attempting retry with refreshed parameters.",
    root_cause: "blockhash_expired",
    action: "retry",
    params: {
      refresh_blockhash: true,
      new_tip_lamports: 6000,
      tip_percentile_target: 50,
      submit_at_slot: 312905,
      max_blockhash_age_slots: 60,
    },
    confidence: 0.9,
    expected_outcome: "Land bundle in Jito block engine",
  };
}

describe("AgentContract", () => {
  it("validates correct input successfully", () => {
    expect(validateAgentInput(getValidInput())).toBe(true);
  });

  it("invalidates malformed input", () => {
    const badInput = getValidInput();
    delete (badInput as any).bundle;
    expect(validateAgentInput(badInput)).toBe(false);
  });

  it("validates correct output successfully", () => {
    const errs = validateAgentOutput(getValidOutput());
    expect(errs.length).toBe(0);
  });

  it("identifies structural failures in output", () => {
    const badOutput = getValidOutput();
    delete (badOutput as any).action;
    const errs = validateAgentOutput(badOutput);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toContain("action");
  });
});

describe("AgentGuardrails", () => {
  it("accepts safe parameters within guardrail bounds", () => {
    const input = getValidInput();
    const output = getValidOutput();
    const rails = checkGuardrails(output, input);
    expect(rails.valid).toBe(true);
    expect(rails.errors.length).toBe(0);
  });

  it("rejects tips below the p25 floor", () => {
    const input = getValidInput();
    const output = getValidOutput();
    output.params.new_tip_lamports = 500; // below p25 = 1000
    const rails = checkGuardrails(output, input);
    expect(rails.valid).toBe(false);
    expect(rails.errors.join(" ")).toContain("below the p25 floor");
  });

  it("rejects tips above the configured safety ceiling", () => {
    const input = getValidInput();
    const output = getValidOutput();
    output.params.new_tip_lamports = 500_000; // above default ceiling = 100_000
    const rails = checkGuardrails(output, input);
    expect(rails.valid).toBe(false);
    expect(rails.errors.join(" ")).toContain("exceeds the safety ceiling");
  });

  it("rejects submit slots in the past", () => {
    const input = getValidInput();
    const output = getValidOutput();
    output.params.submit_at_slot = 312700; // past compared to current 312901
    const rails = checkGuardrails(output, input);
    expect(rails.valid).toBe(false);
    expect(rails.errors.join(" ")).toContain("in the past");
  });

  it("rejects illegal blockhash age configurations", () => {
    const input = getValidInput();
    const output = getValidOutput();
    output.params.max_blockhash_age_slots = 200; // max Solana age is 150
    const rails = checkGuardrails(output, input);
    expect(rails.valid).toBe(false);
    expect(rails.errors.join(" ")).toContain("exceeds Solana maximum");
  });
});
