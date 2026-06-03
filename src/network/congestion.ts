import { config } from "../config.js";
import { logger } from "../util/log.js";
import type { SlotEvent } from "../stream/events.js";

const log = logger("congestion");

/**
 * Congestion Oracle (plan §5.2).
 *
 * Consumes slot events (all commitment levels) and derives live network-health
 * telemetry:
 *  - skip rate: fraction of recent slots that never reached `confirmed`
 *  - processed→confirmed delta: ms between first `processed` and `confirmed`
 *    for a slot (p50/p95) — this answers README Q1
 *  - a single normalized `congestion_multiplier` consumed by the tip model and
 *    surfaced to the AI agent.
 *
 * Implemented as a ring buffer over the last N slots.
 */

interface SlotRecord {
  slot: bigint;
  processedAt?: number;
  confirmedAt?: number;
  finalizedAt?: number;
}

export interface CongestionSnapshot {
  /** number of slots currently tracked */
  windowSize: number;
  /** fraction [0,1] of tracked slots that reached processed but never confirmed */
  skipRate: number;
  /** processed→confirmed latency percentiles in ms */
  p2cMsP50: number;
  p2cMsP95: number;
  /** normalized multiplier in [1, MAX_MULTIPLIER] for the tip model */
  congestionMultiplier: number;
  /** samples backing the percentile numbers */
  sampleCount: number;
}

// Tunables for the multiplier. These are NOT tip values — they shape how
// aggressively the tip scales with congestion. (Tip itself = percentile × this.)
const MAX_MULTIPLIER = 3.0;
// A processed→confirmed delta at or below this (ms) is "healthy" (multiplier ~1).
const HEALTHY_P2C_MS = 600;
// Skip rate at or above this is "severe" and pushes the multiplier toward max.
const SEVERE_SKIP_RATE = 0.15;

export class CongestionOracle {
  private ring: SlotRecord[] = [];
  private index = new Map<string, SlotRecord>();
  private readonly capacity: number;

  constructor(capacity = config.congestion.ringSize) {
    this.capacity = capacity;
  }

  /** Feed a slot event. Only slot events are relevant. */
  ingest(ev: SlotEvent): void {
    const key = ev.slot.toString();
    let rec = this.index.get(key);
    if (!rec) {
      rec = { slot: ev.slot };
      this.index.set(key, rec);
      this.ring.push(rec);
      // evict oldest beyond capacity
      while (this.ring.length > this.capacity) {
        const old = this.ring.shift()!;
        this.index.delete(old.slot.toString());
      }
    }
    // stamp the first time we see each commitment level for this slot
    if (ev.status === "processed" && rec.processedAt === undefined) rec.processedAt = ev.ts;
    else if (ev.status === "confirmed" && rec.confirmedAt === undefined) rec.confirmedAt = ev.ts;
    else if (ev.status === "finalized" && rec.finalizedAt === undefined) rec.finalizedAt = ev.ts;
  }

  snapshot(): CongestionSnapshot {
    const recs = this.ring;
    const windowSize = recs.length;

    // skip rate: a slot is "skipped" if it was seen processed but, despite being
    // old enough that newer slots have confirmed, it never confirmed itself.
    // We approximate "old enough" as: not among the most recent few slots.
    const recencyGuard = 8; // don't penalize the freshest slots still in flight
    const candidates = recs.slice(0, Math.max(0, windowSize - recencyGuard));
    let skipped = 0;
    let consideredForSkip = 0;
    for (const r of candidates) {
      if (r.processedAt !== undefined) {
        consideredForSkip++;
        if (r.confirmedAt === undefined) skipped++;
      }
    }
    const skipRate = consideredForSkip > 0 ? skipped / consideredForSkip : 0;

    // processed→confirmed deltas
    const deltas: number[] = [];
    for (const r of recs) {
      if (r.processedAt !== undefined && r.confirmedAt !== undefined && r.confirmedAt >= r.processedAt) {
        deltas.push(r.confirmedAt - r.processedAt);
      }
    }
    const p2cMsP50 = percentile(deltas, 50);
    const p2cMsP95 = percentile(deltas, 95);

    const congestionMultiplier = this.computeMultiplier(skipRate, p2cMsP50);

    return {
      windowSize,
      skipRate,
      p2cMsP50,
      p2cMsP95,
      congestionMultiplier,
      sampleCount: deltas.length,
    };
  }

  /**
   * Blend latency and skip pressure into a single multiplier in
   * [1, MAX_MULTIPLIER]. Both signals are normalized to [0,1] and combined,
   * so either a latency spike or a skip spike raises the tip.
   */
  private computeMultiplier(skipRate: number, p2cMsP50: number): number {
    const latencyPressure = clamp01((p2cMsP50 - HEALTHY_P2C_MS) / (HEALTHY_P2C_MS * 4));
    const skipPressure = clamp01(skipRate / SEVERE_SKIP_RATE);
    // weight skip slightly higher — a skipping cluster is worse than slow votes
    const pressure = clamp01(0.45 * latencyPressure + 0.55 * skipPressure);
    return 1 + pressure * (MAX_MULTIPLIER - 1);
  }
}

// ---- helpers ---------------------------------------------------------------

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Nearest-rank percentile over an unsorted numeric array. Returns 0 if empty. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

export { percentile };
