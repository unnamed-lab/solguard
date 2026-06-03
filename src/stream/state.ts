import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Tiny durable store for `lastProcessedSlot` (FR-3). Persisted so that a
 * restart can resume the stream with `fromSlot` instead of losing slots.
 * Writes are throttled to avoid hammering disk on every slot.
 */
export class SlotState {
  private last = 0n;
  private lastFlushed = 0n;
  private lastFlushAt = 0;

  constructor(
    private readonly path: string,
    private readonly flushEveryMs = 1000,
  ) {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        this.last = BigInt(raw.lastProcessedSlot ?? 0);
        this.lastFlushed = this.last;
      } catch {
        /* corrupt/empty — start from 0 */
      }
    }
  }

  get lastProcessedSlot(): bigint {
    return this.last;
  }

  /** Advance the high-water mark (monotonic) and throttle-flush to disk. */
  observe(slot: bigint): void {
    if (slot > this.last) this.last = slot;
    const now = Date.now();
    if (now - this.lastFlushAt >= this.flushEveryMs && this.last !== this.lastFlushed) {
      this.flush();
    }
  }

  flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ lastProcessedSlot: this.last.toString() }));
    this.lastFlushed = this.last;
    this.lastFlushAt = Date.now();
  }
}
