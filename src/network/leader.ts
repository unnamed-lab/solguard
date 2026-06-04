import { logger } from "../util/log.js";
import { connection } from "../solana/connection.js";
import { getNextScheduledLeader as jitoNextLeader, type NextScheduledLeader } from "../jito/grpc.js";

const log = logger("leader");

/**
 * Leader Window Detector (plan §5.3).
 *
 * Caches the leader schedule per epoch and queries the Jito block engine via
 * gRPC for the next scheduled Jito leader. Exposes `slotsUntilJitoLeader` and
 * `inSubmitWindow` so the pipeline only submits bundles when a Jito-Solana
 * leader is producing or imminent (FR-6, FR-7).
 *
 * Bundles are only processed while the scheduled Jito leader is up; leaders
 * rotate every 4 slots (~1.6s). We treat "imminent" as being within a small
 * lead of the next Jito leader slot.
 */

// A Jito leader holds 4 consecutive slots. We consider ourselves in the submit
// window from a few slots before the leader's first slot through their last.
const LEADER_SLOTS = 4;
const SUBMIT_LEAD_SLOTS = 2; // start submitting this many slots early

export interface LeaderWindow {
  currentSlot: number;
  nextJitoLeaderSlot: number;
  nextJitoLeaderIdentity: string;
  slotsUntilJitoLeader: number;
  inSubmitWindow: boolean;
  region?: string;
}

export class LeaderWindowDetector {
  private nextLeaderCache?: { value: NextScheduledLeader; at: number };
  private leaderSchedule?: { epoch: number; slots: Set<number> };
  private readonly cacheTtlMs: number;

  constructor(cacheTtlMs = 2000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /** Current submit-window view. Cached briefly to avoid hammering the engine. */
  async window(): Promise<LeaderWindow> {
    const next = await this.nextLeader();
    const slotsUntil = next.nextLeaderSlot - next.currentSlot;
    const inSubmitWindow =
      slotsUntil <= SUBMIT_LEAD_SLOTS && slotsUntil > -(LEADER_SLOTS);

    return {
      currentSlot: next.currentSlot,
      nextJitoLeaderSlot: next.nextLeaderSlot,
      nextJitoLeaderIdentity: next.nextLeaderIdentity,
      slotsUntilJitoLeader: slotsUntil,
      inSubmitWindow,
      region: next.nextLeaderRegion,
    };
  }

  private async nextLeader(): Promise<NextScheduledLeader> {
    const now = Date.now();
    if (this.nextLeaderCache && now - this.nextLeaderCache.at < this.cacheTtlMs) {
      return this.nextLeaderCache.value;
    }
    const value = await jitoNextLeader();
    this.nextLeaderCache = { value, at: now };
    return value;
  }

  /**
   * Cache the validator leader schedule for the current epoch (FR-6). Currently
   * used for cross-checking/diagnostics; the Jito next-leader endpoint is the
   * authoritative submit-window signal. Cached for the whole epoch.
   */
  async ensureLeaderSchedule(): Promise<void> {
    const conn = connection();
    const epochInfo = await conn.getEpochInfo();
    if (this.leaderSchedule?.epoch === epochInfo.epoch) return;
    const schedule = await conn.getLeaderSchedule();
    const slots = new Set<number>();
    if (schedule) {
      const epochStart = epochInfo.absoluteSlot - epochInfo.slotIndex;
      for (const indices of Object.values(schedule)) {
        for (const i of indices) slots.add(epochStart + i);
      }
    }
    this.leaderSchedule = { epoch: epochInfo.epoch, slots };
    log.info("leader schedule cached", { epoch: epochInfo.epoch, slots: slots.size });
  }
}
