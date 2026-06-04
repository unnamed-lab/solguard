import { describe, it, expect } from "vitest";
import { CongestionOracle, percentile } from "../congestion.js";
import type { SlotEvent, Commitment } from "../../stream/events.js";

function slot(slot: number, status: Commitment, ts = slot * 100): SlotEvent {
  return { kind: "slot", slot: BigInt(slot), status, ts };
}

describe("CongestionOracle", () => {
  it("starts empty with a zero snapshot", () => {
    const o = new CongestionOracle(16);
    const s = o.snapshot();
    expect(s.windowSize).toBe(0);
    expect(s.skipRate).toBe(0);
    expect(s.congestionMultiplier).toBe(1);
  });

  it("ingests a single slot and tracks processed", () => {
    const o = new CongestionOracle(16);
    o.ingest(slot(1, "processed", 100));
    expect(o.snapshot().windowSize).toBe(1);
  });

  it("ingests same slot twice without duplication", () => {
    const o = new CongestionOracle(16);
    o.ingest(slot(1, "processed", 100));
    o.ingest(slot(1, "confirmed", 200));
    const s = o.snapshot();
    expect(s.windowSize).toBe(1);
  });

  it("evicts oldest when ring exceeds capacity", () => {
    const o = new CongestionOracle(4);
    for (let i = 1; i <= 6; i++) o.ingest(slot(i, "processed", i * 100));
    const s = o.snapshot();
    expect(s.windowSize).toBe(4);
  });

  it("computes skip rate correctly when all slots confirm", () => {
    const o = new CongestionOracle(16);
    // slots 1-16 processed then confirmed
    for (let i = 1; i <= 16; i++) {
      o.ingest(slot(i, "processed", i * 100));
      o.ingest(slot(i, "confirmed", i * 100 + 50));
    }
    // All non-recency-guarded candidates confirmed => skip rate 0
    const s = o.snapshot();
    expect(s.skipRate).toBe(0);
  });

  it("computes skip rate > 0 when slots are skipped", () => {
    const o = new CongestionOracle(16);
    for (let i = 1; i <= 16; i++) {
      o.ingest(slot(i, "processed", i * 100));
      // only confirm odd slots; evens remain unconfirmed → skip > 0
      if (i % 2 === 1) o.ingest(slot(i, "confirmed", i * 100 + 50));
    }
    const s = o.snapshot();
    expect(s.skipRate).toBeGreaterThan(0);
  });

  it("computes p2c deltas from processed→confirmed timestamps", () => {
    const o = new CongestionOracle(16);
    for (let i = 1; i <= 10; i++) {
      o.ingest(slot(i, "processed", i * 100));
      o.ingest(slot(i, "confirmed", i * 100 + 200));
    }
    const s = o.snapshot();
    // All deltas are 200ms
    expect(s.p2cMsP50).toBe(200);
    expect(s.p2cMsP95).toBe(200);
    expect(s.sampleCount).toBe(10);
  });

  it("multiplier is 1.0 when network is healthy", () => {
    const o = new CongestionOracle(16);
    for (let i = 1; i <= 16; i++) {
      o.ingest(slot(i, "processed", i * 100));
      o.ingest(slot(i, "confirmed", i * 100 + 50));
    }
    const s = o.snapshot();
    expect(s.congestionMultiplier).toBe(1);
  });

  it("multiplier increases with skip rate", () => {
    const o = new CongestionOracle(16);
    for (let i = 1; i <= 16; i++) {
      o.ingest(slot(i, "processed", i * 100));
      // only confirm a few, so skip rate > 0.15 triggers pressure
      if (i % 4 === 0) o.ingest(slot(i, "confirmed", i * 100 + 50));
    }
    const s = o.snapshot();
    expect(s.congestionMultiplier).toBeGreaterThan(1);
  });

  it("handles a real-world pattern: few skips moderate p2c", () => {
    const o = new CongestionOracle(64);
    // Simulate 64 slots: 48 confirm quickly, 8 skip, 8 pending
    for (let i = 1; i <= 64; i++) {
      o.ingest(slot(i, "processed", i * 100));
      if (i <= 48) o.ingest(slot(i, "confirmed", i * 100 + 400));
    }
    const s = o.snapshot();
    expect(s.windowSize).toBe(64);
    expect(s.sampleCount).toBeGreaterThan(0);
    expect(s.congestionMultiplier).toBeGreaterThanOrEqual(1);
    expect(s.congestionMultiplier).toBeLessThanOrEqual(3);
  });
});

describe("percentile helper", () => {
  it("returns 0 for empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("computes p50 correctly", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("computes p95 correctly", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
  });

  it("handles single-element array", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("clamps to valid index", () => {
    expect(percentile([10, 20], 0)).toBe(10);
    expect(percentile([10, 20], 100)).toBe(20);
  });
});
