import { config } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("tipfloor");

/**
 * Live tip-floor fetcher (plan §5.4, FR-8).
 *
 * Pulls recent landed-tip percentiles + EMA from Jito's tip_floor REST
 * endpoint and caches them (~60s TTL). These are the ONLY source of tip
 * magnitude in the system — the tip model multiplies a chosen percentile by
 * the congestion multiplier. Nothing here is a hardcoded tip value.
 */

export interface TipFloor {
  /** lamports */
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  ema: number;
  /** when this snapshot was fetched (ms epoch) */
  fetchedAt: number;
}

export type TipPercentileKey = "p25" | "p50" | "p75" | "p95" | "p99";

// Jito returns SOL-denominated floats; convert to lamports.
const LAMPORTS_PER_SOL = 1_000_000_000;

interface RawTipFloor {
  time: string;
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
  ema_landed_tips_50th_percentile: number;
}

export class TipFloorService {
  private cache?: TipFloor;
  constructor(
    private readonly url = config.jito.tipFloorUrl,
    private readonly ttlMs = 60_000,
  ) {}

  /** Cached tip floor; refetches when stale. */
  async get(): Promise<TipFloor> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) return this.cache;
    try {
      const fresh = await this.fetch();
      this.cache = fresh;
      return fresh;
    } catch (err) {
      if (this.cache) {
        log.warn("tip_floor refetch failed; serving stale", { err: String(err) });
        return this.cache;
      }
      throw err;
    }
  }

  private async fetch(): Promise<TipFloor> {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`tip_floor HTTP ${res.status}`);
    const json = (await res.json()) as RawTipFloor[];
    const row = json[0];
    if (!row) throw new Error("tip_floor returned empty array");
    const toLamports = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL);
    const tf: TipFloor = {
      p25: toLamports(row.landed_tips_25th_percentile),
      p50: toLamports(row.landed_tips_50th_percentile),
      p75: toLamports(row.landed_tips_75th_percentile),
      p95: toLamports(row.landed_tips_95th_percentile),
      p99: toLamports(row.landed_tips_99th_percentile),
      ema: toLamports(row.ema_landed_tips_50th_percentile),
      fetchedAt: Date.now(),
    };
    log.debug("tip_floor fetched", tf as unknown as Record<string, unknown>);
    return tf;
  }
}

let _svc: TipFloorService | undefined;
export function tipFloorService(): TipFloorService {
  if (!_svc) _svc = new TipFloorService();
  return _svc;
}
