import { config } from "../config.js";
import type { TipFloor, TipPercentileKey } from "./tipFloor.js";

/**
 * Tip model (plan §5.4, FR-9).
 *
 *   tip = percentile(tip_floor, p) × congestion_multiplier
 *
 * The percentile `p` scales with congestion and urgency; the multiplier comes
 * from the Congestion Oracle. The result is clamped to
 * [tip_floor.p25, TIP_CEILING_LAMPORTS]. There are NO literal lamport
 * constants here — every magnitude is sourced from live tip_floor data or the
 * configured safety ceiling. (See scripts/check-no-hardcoded-tips.mjs.)
 */

export type Urgency = "low" | "normal" | "high";

export interface TipInputs {
  tipFloor: TipFloor;
  congestionMultiplier: number;
  urgency?: Urgency;
  /** override the percentile selection (e.g. the agent picked one) */
  percentileTarget?: TipPercentileKey;
}

export interface TipDecision {
  lamports: number;
  percentileKey: TipPercentileKey;
  basePercentileLamports: number;
  congestionMultiplier: number;
  ceilingLamports: number;
  clamped: boolean;
}

/**
 * Choose which tip_floor percentile to anchor on, based on congestion + urgency.
 * Calmer network / lower urgency → lower percentile; busier / urgent → higher.
 */
export function selectPercentile(congestionMultiplier: number, urgency: Urgency): TipPercentileKey {
  // base level from urgency
  let level = urgency === "low" ? 0 : urgency === "high" ? 2 : 1;
  // escalate with congestion
  if (congestionMultiplier >= 2.2) level += 2;
  else if (congestionMultiplier >= 1.5) level += 1;

  const ladder: TipPercentileKey[] = ["p25", "p50", "p75", "p95", "p99"];
  const idx = Math.min(ladder.length - 1, Math.max(0, level));
  return ladder[idx]!;
}

export function computeTip(inputs: TipInputs): TipDecision {
  const { tipFloor, congestionMultiplier } = inputs;
  const urgency = inputs.urgency ?? "normal";
  const percentileKey = inputs.percentileTarget ?? selectPercentile(congestionMultiplier, urgency);

  const basePercentileLamports = tipFloor[percentileKey];
  const raw = Math.round(basePercentileLamports * congestionMultiplier);

  const floor = tipFloor.p25; // never tip below the 25th percentile of landed tips
  const ceiling = config.tips.ceilingLamports;
  const clampedLamports = Math.min(ceiling, Math.max(floor, raw));

  return {
    lamports: clampedLamports,
    percentileKey,
    basePercentileLamports,
    congestionMultiplier,
    ceilingLamports: ceiling,
    clamped: clampedLamports !== raw,
  };
}
