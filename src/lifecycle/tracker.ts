import { logger } from "../util/log.js";
import { JsonlWriter } from "../util/jsonl.js";
import { bridge } from "../events/bridge.js";
import type { SlotEvent, TxEvent, Commitment } from "../stream/events.js";
import type { SubmitResult } from "../bundle/submitter.js";
import type {
  FailureRecord,
  LifecycleEntry,
  Stage,
  StageStamp,
} from "./types.js";

const log = logger("lifecycle");

/**
 * Lifecycle Tracker (plan §5.6, FR-14/15).
 *
 * Tracks each bundle across submitted → processed → confirmed → finalized,
 * stamping {slot, ts} per stage and computing inter-stage deltas. Confirmation
 * is STREAM-PRIMARY (FR-16): a member signature appearing in the tx stream is
 * what advances stages; status-API reconciliation is secondary (see status.ts).
 *
 * Keyed by bundle, indexed by member signature so a stream tx event maps back
 * to its bundle in O(1).
 */

interface TrackedBundle {
  entry: LifecycleEntry;
  /** ms-epoch timestamps per stage for delta math */
  stageMs: Partial<Record<Stage, number>>;
  /** the signature whose stream updates we follow for stage progression */
  primarySig: string;
  done: boolean;
}

const stageOrder: Stage[] = ["submitted", "processed", "confirmed", "finalized"];

export class LifecycleTracker {
  private bundles = new Map<string, TrackedBundle>(); // bundleId → tracked
  private sigIndex = new Map<string, string>(); // signature → bundleId
  private landedSlot = new Map<number, Set<string>>(); // landing slot → bundleIds
  private writer: JsonlWriter;

  constructor(logPath = "logs/lifecycle.jsonl") {
    this.writer = new JsonlWriter(logPath);
  }

  /** Currently in-flight bundles (for the dashboard). */
  active(): LifecycleEntry[] {
    return [...this.bundles.values()].filter((b) => !b.done).map((b) => b.entry);
  }

  get(bundleId: string): LifecycleEntry | undefined {
    return this.bundles.get(bundleId)?.entry;
  }

  /** Register a freshly submitted bundle (stamps the `submitted` stage). */
  track(sub: SubmitResult, attempt: number, submittedSlot: number): void {
    const ts = new Date(sub.submittedAt).toISOString();
    const entry: LifecycleEntry = {
      bundle_id: sub.bundleId,
      signatures: sub.signatures,
      tip_lamports: sub.tipLamports,
      tip_account: sub.tipAccount,
      attempt,
      stages: { submitted: { slot: submittedSlot, ts } },
      deltas_ms: {},
      failure: null,
      confirmed_via: null,
    };
    const tracked: TrackedBundle = {
      entry,
      stageMs: { submitted: sub.submittedAt },
      primarySig: sub.signatures[0] ?? sub.bundleId,
      done: false,
    };
    this.bundles.set(sub.bundleId, tracked);
    for (const sig of sub.signatures) this.sigIndex.set(sig, sub.bundleId);
    log.info("tracking bundle", { bundleId: sub.bundleId, attempt, submittedSlot });

    bridge.emit("bundle_event", {
      bundleId: sub.bundleId,
      stage: "submitted",
      slot: submittedSlot,
      timestamp: ts,
      signatures: sub.signatures,
      tipLamports: sub.tipLamports,
      tipAccount: sub.tipAccount,
      attempt,
    });
  }

  /**
   * Feed a stream event. Tx events advance stages for matching bundles; slot
   * events alone don't advance a specific bundle but the commitment of the
   * slot a tx landed in is resolved via subsequent tx updates at higher
   * commitment levels.
   */
  onTxEvent(ev: TxEvent, commitment: Commitment): void {
    const bundleId = this.sigIndex.get(ev.signature);
    if (!bundleId) return;
    const tracked = this.bundles.get(bundleId);
    if (!tracked || tracked.done) return;
    const slot = Number(ev.slot);
    // remember where this bundle landed so slot-status events can promote it
    let set = this.landedSlot.get(slot);
    if (!set) {
      set = new Set();
      this.landedSlot.set(slot, set);
    }
    set.add(bundleId);
    this.advance(tracked, commitment, slot, ev.ts, "stream");
  }

  /**
   * Promote any bundle that landed in `slot` to `commitment` when the slot
   * itself reaches that commitment on the slot stream. This is how a tx seen at
   * `processed` becomes `confirmed`/`finalized` purely from the stream (FR-16).
   */
  onSlotStatus(slot: number, commitment: Commitment, tsMs: number): void {
    if (commitment === "processed") return; // processed handled by the tx event
    const ids = this.landedSlot.get(slot);
    if (!ids) return;
    for (const bundleId of ids) {
      const tracked = this.bundles.get(bundleId);
      if (tracked && !tracked.done) this.advance(tracked, commitment, slot, tsMs, "stream");
    }
  }

  /** Reconciliation hook (status.ts) — secondary to the stream. */
  reconcile(bundleId: string, commitment: Commitment, slot: number): void {
    const tracked = this.bundles.get(bundleId);
    if (!tracked || tracked.done) return;
    // only fill stages the stream hasn't already provided
    if (!tracked.entry.stages[commitment]) {
      this.advance(tracked, commitment, slot, Date.now(), "status_api");
    }
  }

  /** Record a classified failure and finalize the entry. */
  fail(bundleId: string, failure: FailureRecord): void {
    const tracked = this.bundles.get(bundleId);
    if (!tracked || tracked.done) return;
    tracked.entry.failure = failure;
    this.finish(tracked);
    log.warn("bundle failed", { bundleId, type: failure.type });

    bridge.emit("bundle_event", {
      bundleId,
      stage: "failed",
      slot: failure.detectedAtSlot,
      timestamp: failure.ts,
      failureType: failure.type,
      evidence: failure.evidence as Record<string, unknown>,
    });
  }

  private advance(
    tracked: TrackedBundle,
    commitment: Commitment,
    slot: number,
    tsMs: number,
    via: "stream" | "status_api",
  ): void {
    const stage = commitment as Stage; // processed|confirmed|finalized align with Stage
    if (tracked.entry.stages[stage]) return; // already stamped

    const stamp: StageStamp = { slot, ts: new Date(tsMs).toISOString() };
    tracked.entry.stages[stage] = stamp;
    tracked.stageMs[stage] = tsMs;

    if (stage === "confirmed" && tracked.entry.confirmed_via === null) {
      tracked.entry.confirmed_via = via;
    }

    this.recomputeDeltas(tracked);

    log.debug("stage advanced", { bundleId: tracked.entry.bundle_id, stage, slot, via });

    bridge.emit("bundle_event", {
      bundleId: tracked.entry.bundle_id,
      stage: stage as "processed" | "confirmed" | "finalized",
      slot,
      timestamp: new Date(tsMs).toISOString(),
      deltaMs: (() => {
        if (stage === "processed") return tracked.entry.deltas_ms.submitted_to_processed;
        if (stage === "confirmed") return tracked.entry.deltas_ms.processed_to_confirmed;
        if (stage === "finalized") return tracked.entry.deltas_ms.confirmed_to_finalized;
        return undefined;
      })(),
    });

    if (stage === "finalized") this.finish(tracked);
  }

  private recomputeDeltas(tracked: TrackedBundle): void {
    const m = tracked.stageMs;
    const d = tracked.entry.deltas_ms;
    if (m.submitted !== undefined && m.processed !== undefined)
      d.submitted_to_processed = m.processed - m.submitted;
    if (m.processed !== undefined && m.confirmed !== undefined)
      d.processed_to_confirmed = m.confirmed - m.processed;
    if (m.confirmed !== undefined && m.finalized !== undefined)
      d.confirmed_to_finalized = m.finalized - m.confirmed;
  }

  private finish(tracked: TrackedBundle): void {
    if (tracked.done) return;
    tracked.done = true;
    this.writer.append(tracked.entry);
    // keep the entry in-memory briefly for dashboard, but drop sig index
    for (const sig of tracked.entry.signatures) this.sigIndex.delete(sig);
    const landedAt = tracked.entry.stages.processed?.slot;
    if (landedAt !== undefined) this.landedSlot.get(landedAt)?.delete(tracked.entry.bundle_id);
  }

  /** For diagnostics / verification §8. */
  stageRank(stage: Stage): number {
    return stageOrder.indexOf(stage);
  }
}
