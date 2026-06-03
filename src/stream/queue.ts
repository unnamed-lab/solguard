/**
 * Bounded queue with an explicit backpressure policy (FR-5 / NFR-2).
 *
 * A slow consumer must never exhaust memory. When the queue is full we
 * drop the OLDEST event and increment `dropped` — never silently. The
 * `dropped` counter is surfaced on the dashboard (NFR-3).
 *
 * Policy = "drop-oldest" keeps the freshest network state, which is what
 * the congestion oracle and agent care about. (Alternative "pause" policy
 * would back-pressure the gRPC read; drop-oldest is preferred for live
 * telemetry where stale slots are worthless.)
 */
export class BoundedQueue<T> {
  private buf: T[] = [];
  private waiters: Array<(v: T) => void> = [];
  private _dropped = 0;
  private _enqueued = 0;
  private closed = false;

  constructor(private readonly capacity: number) {}

  /** Push an item. Returns false if an old item had to be dropped. */
  push(item: T): boolean {
    if (this.closed) return true;
    this._enqueued++;

    // Hand directly to a waiting consumer if one exists.
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return true;
    }

    let dropped = false;
    if (this.buf.length >= this.capacity) {
      this.buf.shift(); // drop oldest
      this._dropped++;
      dropped = true;
    }
    this.buf.push(item);
    return !dropped;
  }

  /** Await the next item. Resolves immediately if buffered. */
  next(): Promise<T> {
    const item = this.buf.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }

  /** Async iterator so callers can `for await (const ev of queue)`. */
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (!this.closed) {
      yield await this.next();
    }
  }

  close() {
    this.closed = true;
  }

  get size(): number {
    return this.buf.length;
  }

  get dropped(): number {
    return this._dropped;
  }

  get enqueued(): number {
    return this._enqueued;
  }
}
