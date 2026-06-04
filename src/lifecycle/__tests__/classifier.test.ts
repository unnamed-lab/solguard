import { describe, it, expect } from "vitest";
import { classifyFailure } from "../classifier.js";
import type { ClassifierInput } from "../classifier.js";

function base(): ClassifierInput {
  return { bundleId: "b-1", currentSlot: 100 };
}

describe("FailureClassifier", () => {
  it("classifies simulation_failed when simulationError is present", () => {
    const result = classifyFailure({ ...base(), simulationError: "custom program error" });
    expect(result.type).toBe("simulation_failed");
    expect(result.evidence.simulationError).toBe("custom program error");
  });

  it("classifies compute_exceeded when simulation error mentions compute", () => {
    const result = classifyFailure({ ...base(), simulationError: "exceeded budget for compute units" });
    expect(result.type).toBe("compute_exceeded");
  });

  it("classifies compute_exceeded when computeError flag is set", () => {
    const result = classifyFailure({ ...base(), computeError: true });
    expect(result.type).toBe("compute_exceeded");
  });

  it("classifies compute_exceeded when error mentions exceeded CUs", () => {
    const result = classifyFailure({ ...base(), simulationError: "exceeded CUs" });
    expect(result.type).toBe("compute_exceeded");
  });

  it("classifies blockhash_expired when block height exceeds lastValid", () => {
    const result = classifyFailure({
      ...base(),
      lastValidBlockHeight: 100,
      currentBlockHeight: 150,
      blockhashFetchedAtSlot: 50,
    });
    expect(result.type).toBe("blockhash_expired");
    expect(result.evidence.last_valid_block_height).toBe(100);
    expect(result.evidence.current_block_height).toBe(150);
  });

  it("does not classify blockhash_expired when heights are equal", () => {
    const result = classifyFailure({
      ...base(),
      lastValidBlockHeight: 100,
      currentBlockHeight: 100,
    });
    expect(result.type).not.toBe("blockhash_expired");
  });

  it("classifies bundle_dropped_leader_skip when leader slot was skipped", () => {
    const result = classifyFailure({
      ...base(),
      leaderSlotSkipped: true,
      targetLeaderSlot: 150,
    });
    expect(result.type).toBe("bundle_dropped_leader_skip");
    expect(result.evidence.target_leader_slot).toBe(150);
  });

  it("classifies fee_too_low when tip < p50 under congestion", () => {
    const result = classifyFailure({
      ...base(),
      neverProcessed: true,
      tipLamports: 500,
      tipFloorP50: 2000,
      congestion: { congestionMultiplier: 2.0, windowSize: 64, skipRate: 0.1, p2cMsP50: 300, p2cMsP95: 800, sampleCount: 50 },
    });
    expect(result.type).toBe("fee_too_low");
    expect(result.evidence.tip_lamports).toBe(500);
    expect(result.evidence.tip_floor_p50).toBe(2000);
  });

  it("does not classify fee_too_low when congestion is low", () => {
    const result = classifyFailure({
      ...base(),
      neverProcessed: true,
      tipLamports: 500,
      tipFloorP50: 2000,
      congestion: { congestionMultiplier: 1.1, windowSize: 64, skipRate: 0.02, p2cMsP50: 100, p2cMsP95: 200, sampleCount: 50 },
    });
    expect(result.type).not.toBe("fee_too_low");
  });

  it("classifies bundle_dropped_leader_skip as fallback when neverProcessed", () => {
    const result = classifyFailure({
      ...base(),
      neverProcessed: true,
    });
    expect(result.type).toBe("bundle_dropped_leader_skip");
    expect(result.evidence.note).toContain("never processed");
  });

  it("classifies simulation_failed as default when no specific signal", () => {
    const result = classifyFailure(base());
    expect(result.type).toBe("simulation_failed");
  });

  it("includes detectedAtSlot and ts in failure record", () => {
    const result = classifyFailure({ ...base(), simulationError: "err" });
    expect(result.detectedAtSlot).toBe(100);
    expect(result.ts).toBeDefined();
  });

  it("prefers simulation_error over neverProcessed", () => {
    const result = classifyFailure({
      ...base(),
      neverProcessed: true,
      simulationError: "Instruction program error",
    });
    expect(result.type).toBe("simulation_failed");
  });

  it("prefers blockhash_expired over neverProcessed", () => {
    const result = classifyFailure({
      ...base(),
      neverProcessed: true,
      lastValidBlockHeight: 100,
      currentBlockHeight: 200,
    });
    expect(result.type).toBe("blockhash_expired");
  });
});
