import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LifecycleTracker } from "../tracker.js";
import type { SubmitResult } from "../../bundle/submitter.js";

function fakeSubmit(overrides?: Partial<SubmitResult>): SubmitResult {
  return {
    bundleId: "bundle-1",
    signatures: ["sig1", "sig2"],
    tipLamports: 1000,
    tipAccount: "tip1",
    submittedAt: Date.now(),
    blockhash: "hash1",
    lastValidBlockHeight: 1000,
    ...overrides,
  };
}

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), "solguard-test-")), "lifecycle.jsonl");
}

describe("LifecycleTracker", () => {
  let tracker: LifecycleTracker;

  beforeEach(() => {
    tracker = new LifecycleTracker(tmpLog());
  });

  it("starts with no active bundles", () => {
    expect(tracker.active()).toHaveLength(0);
  });

  it("tracks a submitted bundle and stamps submitted stage", () => {
    const sub = fakeSubmit();
    tracker.track(sub, 1, 100);
    const entry = tracker.get("bundle-1");
    expect(entry).toBeDefined();
    expect(entry!.stages.submitted).toBeDefined();
    expect(entry!.stages.submitted!.slot).toBe(100);
    expect(entry!.failure).toBeNull();
  });

  it("lists tracked bundle as active", () => {
    tracker.track(fakeSubmit(), 1, 100);
    expect(tracker.active()).toHaveLength(1);
    expect(tracker.active()[0]!.bundle_id).toBe("bundle-1");
  });

  it("advances to processed on tx event", () => {
    tracker.track(fakeSubmit(), 1, 100);
    tracker.onTxEvent(
      { kind: "tx", signature: "sig1", slot: BigInt(150), isVote: false, failed: false, ts: 2000 },
      "processed",
    );
    const entry = tracker.get("bundle-1")!;
    expect(entry.stages.processed).toBeDefined();
    expect(entry.stages.processed!.slot).toBe(150);
  });

  it("advances to confirmed via slot status", () => {
    tracker.track(fakeSubmit(), 1, 100);
    tracker.onTxEvent(
      { kind: "tx", signature: "sig1", slot: BigInt(150), isVote: false, failed: false, ts: 2000 },
      "processed",
    );
    tracker.onSlotStatus(150, "confirmed", 3000);
    const entry = tracker.get("bundle-1")!;
    expect(entry.stages.confirmed).toBeDefined();
    expect(entry.stages.confirmed!.slot).toBe(150);
    expect(entry.confirmed_via).toBe("stream");
  });

  it("advances to finalized via slot status", () => {
    tracker.track(fakeSubmit(), 1, 100);
    tracker.onTxEvent(
      { kind: "tx", signature: "sig1", slot: BigInt(150), isVote: false, failed: false, ts: 2000 },
      "processed",
    );
    tracker.onSlotStatus(150, "confirmed", 3000);
    tracker.onSlotStatus(150, "finalized", 5000);
    const entry = tracker.get("bundle-1")!;
    expect(entry.stages.finalized).toBeDefined();
    expect(entry.stages.finalized!.slot).toBe(150);
  });

  it("removes from active when finalized", () => {
    tracker.track(fakeSubmit(), 1, 100);
    tracker.onTxEvent(
      { kind: "tx", signature: "sig1", slot: BigInt(150), isVote: false, failed: false, ts: 2000 },
      "processed",
    );
    tracker.onSlotStatus(150, "confirmed", 3000);
    tracker.onSlotStatus(150, "finalized", 5000);
    expect(tracker.active()).toHaveLength(0);
  });

  it("computes inter-stage deltas", () => {
    const base = Date.now();
    tracker.track(fakeSubmit({ submittedAt: base }), 1, 100);
    tracker.onTxEvent(
      { kind: "tx", signature: "sig1", slot: BigInt(150), isVote: false, failed: false, ts: base + 500 },
      "processed",
    );
    tracker.onSlotStatus(150, "confirmed", base + 1500);
    tracker.onSlotStatus(150, "finalized", base + 5000);
    const entry = tracker.get("bundle-1")!;
    expect(entry.deltas_ms.submitted_to_processed).toBeCloseTo(500, -2);
    expect(entry.deltas_ms.processed_to_confirmed).toBeDefined();
    expect(entry.deltas_ms.confirmed_to_finalized).toBeDefined();
  });

  it("does not double-stamp stages", () => {
    tracker.track(fakeSubmit(), 1, 100);
    tracker.onTxEvent(
      { kind: "tx", signature: "sig1", slot: BigInt(150), isVote: false, failed: false, ts: 2000 },
      "processed",
    );
    // second processed event should not re-stamp
    tracker.onTxEvent(
      { kind: "tx", signature: "sig1", slot: BigInt(151), isVote: false, failed: false, ts: 2500 },
      "processed",
    );
    const entry = tracker.get("bundle-1")!;
    expect(entry.stages.processed!.slot).toBe(150); // first one wins
  });

  it("ignores tx events for unknown signatures", () => {
    tracker.onTxEvent(
      { kind: "tx", signature: "unknown", slot: BigInt(100), isVote: false, failed: false, ts: 1000 },
      "processed",
    );
    // no crash
    expect(tracker.active()).toHaveLength(0);
  });

  it("marks failure via fail() and finalizes", () => {
    tracker.track(fakeSubmit(), 1, 100);
    tracker.fail("bundle-1", {
      type: "blockhash_expired",
      evidence: { last_valid_block_height: 100, current_block_height: 200 },
      detectedAtSlot: 150,
      ts: new Date().toISOString(),
    });
    const entry = tracker.get("bundle-1")!;
    expect(entry.failure).toBeDefined();
    expect(entry.failure!.type).toBe("blockhash_expired");
    expect(tracker.active()).toHaveLength(0);
  });

  it("reconcile fills gaps the stream skipped", () => {
    tracker.track(fakeSubmit(), 1, 100);
    tracker.reconcile("bundle-1", "confirmed", 200);
    const entry = tracker.get("bundle-1")!;
    expect(entry.stages.confirmed).toBeDefined();
    expect(entry.confirmed_via).toBe("status_api");
  });

  it("reconcile does not overwrite stream-provided stages", () => {
    tracker.track(fakeSubmit(), 1, 100);
    tracker.onTxEvent(
      { kind: "tx", signature: "sig1", slot: BigInt(150), isVote: false, failed: false, ts: 2000 },
      "processed",
    );
    tracker.onSlotStatus(150, "confirmed", 3000);
    // reconcile with a different slot should not overwrite
    tracker.reconcile("bundle-1", "confirmed", 999);
    const entry = tracker.get("bundle-1")!;
    expect(entry.stages.confirmed!.slot).toBe(150);
    expect(entry.confirmed_via).toBe("stream");
  });

  it("overwrites duplicate bundleId on second track", () => {
    tracker.track(fakeSubmit({ bundleId: "dup" }), 1, 100);
    tracker.track(fakeSubmit({ bundleId: "dup", signatures: ["sig3"] }), 1, 100);
    const entry = tracker.get("dup")!;
    expect(entry.signatures).toEqual(["sig3"]); // last one wins
  });

  it("stageRank returns correct order", () => {
    expect(tracker.stageRank("submitted")).toBe(0);
    expect(tracker.stageRank("processed")).toBe(1);
    expect(tracker.stageRank("confirmed")).toBe(2);
    expect(tracker.stageRank("finalized")).toBe(3);
  });

  it("returns undefined for unknown bundleId", () => {
    expect(tracker.get("nonexistent")).toBeUndefined();
  });
});
