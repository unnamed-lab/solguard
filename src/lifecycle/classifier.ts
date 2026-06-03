import type { FailureClass, FailureRecord } from "./types.js";
import type { CongestionSnapshot } from "../network/congestion.js";

/**
 * Failure Classifier (plan §5.7, FR-18/19).
 *
 * Maps observed signals to one of five failure classes and attaches evidence.
 * Inputs come from the bundle context, the network oracle, the leader detector,
 * and any block-engine simulation error text.
 */

export interface ClassifierInput {
  bundleId: string;
  currentSlot: number;
  /** blockhash validity tracking */
  lastValidBlockHeight?: number;
  currentBlockHeight?: number;
  blockhashFetchedAtSlot?: number;
  /** leader-window context at submit time */
  targetLeaderSlot?: number;
  leaderSlotSkipped?: boolean;
  /** auction / tip context */
  tipLamports?: number;
  tipFloorP50?: number;
  neverProcessed?: boolean;
  /** network */
  congestion?: CongestionSnapshot;
  /** raw error text from simulation / status, if any */
  simulationError?: string | null;
  computeError?: boolean;
}

/**
 * Classify a failure. Order matters: we check the most specific, evidence-backed
 * signals first and fall back to congestion-driven heuristics.
 */
export function classifyFailure(input: ClassifierInput): FailureRecord {
  const ts = new Date().toISOString();
  const base = { detectedAtSlot: input.currentSlot, ts };

  // 1. Simulation failure — explicit rejection text wins.
  if (input.simulationError) {
    if (input.computeError || /compute|exceeded budget|exceeded CUs/i.test(input.simulationError)) {
      return mk("compute_exceeded", base, { simulationError: input.simulationError });
    }
    return mk("simulation_failed", base, { simulationError: input.simulationError });
  }
  if (input.computeError) {
    return mk("compute_exceeded", base, { reason: "compute budget exceeded" });
  }

  // 2. Expired blockhash — current block height passed lastValidBlockHeight.
  if (
    input.lastValidBlockHeight !== undefined &&
    input.currentBlockHeight !== undefined &&
    input.currentBlockHeight > input.lastValidBlockHeight
  ) {
    const ageSlots =
      input.blockhashFetchedAtSlot !== undefined
        ? input.currentSlot - input.blockhashFetchedAtSlot
        : undefined;
    return mk("blockhash_expired", base, {
      last_valid_block_height: input.lastValidBlockHeight,
      current_block_height: input.currentBlockHeight,
      blockhash_age_slots: ageSlots,
    });
  }

  // 3. Leader skip — the targeted Jito slot was skipped / produced by another.
  if (input.leaderSlotSkipped) {
    return mk("bundle_dropped_leader_skip", base, {
      target_leader_slot: input.targetLeaderSlot,
      observed_skip: true,
    });
  }

  // 4. Fee/tip too low — never processed under congestion while tip below median.
  if (
    input.neverProcessed &&
    input.tipLamports !== undefined &&
    input.tipFloorP50 !== undefined &&
    input.tipLamports < input.tipFloorP50 &&
    (input.congestion?.congestionMultiplier ?? 1) > 1.3
  ) {
    return mk("fee_too_low", base, {
      tip_lamports: input.tipLamports,
      tip_floor_p50: input.tipFloorP50,
      congestion_multiplier: input.congestion?.congestionMultiplier,
      skip_rate: input.congestion?.skipRate,
    });
  }

  // 5. Default: if it never processed, most likely a drop; otherwise sim-class.
  if (input.neverProcessed) {
    return mk("bundle_dropped_leader_skip", base, {
      target_leader_slot: input.targetLeaderSlot,
      note: "never processed; no specific signal — treated as drop",
      congestion_multiplier: input.congestion?.congestionMultiplier,
    });
  }
  return mk("simulation_failed", base, { note: "unclassified failure" });
}

function mk(
  type: FailureClass,
  base: { detectedAtSlot: number; ts: string },
  evidence: Record<string, unknown>,
): FailureRecord {
  return { type, evidence, ...base };
}
