import Yellowstone, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import type { default as ClientClass, SubscribeUpdate, SubscribeRequest } from "@triton-one/yellowstone-grpc";
import type { ClientDuplexStream } from "@grpc/grpc-js";

const Client = (Yellowstone as unknown as { default: typeof ClientClass }).default;
import bs58 from "bs58";

import { config } from "../config.js";
import { logger } from "../util/log.js";
import { BoundedQueue } from "./queue.js";
import { SlotState } from "./state.js";
import { slotSubscribeRequest, txSubscribeRequest, pingRequest } from "./filters.js";
import type { Commitment, SlotEvent, StreamEvent, StreamMetrics, TxEvent } from "./events.js";

const log = logger("stream");

/** Map Yellowstone slot status enum → our commitment vocabulary. */
function mapSlotStatus(status: number | undefined): Commitment {
  // SubscribeUpdateSlotStatus: PROCESSED=0, CONFIRMED=1, FINALIZED=2 (CreatedBank/Dead also exist in newer protos)
  switch (status) {
    case CommitmentLevel.CONFIRMED:
      return "confirmed";
    case CommitmentLevel.FINALIZED:
      return "finalized";
    default:
      return "processed";
  }
}

/**
 * Stream Manager (plan §5.1). Owns a long-lived Yellowstone gRPC subscription
 * and turns it into a clean stream of normalized events on a bounded queue.
 *
 * Resilience guarantees:
 *  - reconnect with exponential backoff (FR-3)
 *  - resume with `fromSlot = lastProcessedSlot` after a drop (FR-3)
 *  - dedupe replayed (slot, status) / signatures within the replay window
 *  - reply to server pings to keep the stream alive (FR-4)
 *  - bounded queue with counted drops (FR-5 / NFR-2)
 */
export class StreamManager {
  readonly queue: BoundedQueue<StreamEvent>;
  private client: ClientClass;
  private stream?: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
  private state: SlotState;

  private pingTimer?: NodeJS.Timeout;
  private stopped = false;
  private reconnects = 0;
  private connected = false;
  private lastEventAt = 0;

  // dedupe: remember recently seen (slot|status) and signatures within window
  private seenSlots = new Set<string>();
  private seenSigs = new Set<string>();
  private seenOrder: string[] = [];

  // accounts whose transactions we want to follow (our signer pubkeys)
  private trackedAccounts: string[] = [];

  constructor(statePath = "state/slot.json") {
    this.queue = new BoundedQueue<StreamEvent>(config.stream.queueMax);
    this.state = new SlotState(statePath);
    this.client = new Client(config.yellowstone.url, config.yellowstone.xToken || undefined, {
      "grpc.max_receive_message_length": 64 * 1024 * 1024,
    });
  }

  /** Add signer accounts to follow for landing confirmation (FR-2). */
  trackAccounts(pubkeys: string[]): void {
    let changed = false;
    for (const k of pubkeys) {
      if (!this.trackedAccounts.includes(k)) {
        this.trackedAccounts.push(k);
        changed = true;
      }
    }
    if (changed && this.connected) void this.resubscribe();
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.state.flush();
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
    this.queue.close();
  }

  metrics(): StreamMetrics {
    return {
      reconnects: this.reconnects,
      droppedEvents: this.queue.dropped,
      queueSize: this.queue.size,
      enqueued: this.queue.enqueued,
      lastProcessedSlot: this.state.lastProcessedSlot.toString(),
      connected: this.connected,
      lastEventAt: this.lastEventAt,
    };
  }

  // ---- internals -----------------------------------------------------------

  private async connect(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        log.info("connecting", { url: config.yellowstone.url, fromSlot: this.state.lastProcessedSlot.toString() });
        this.stream = await this.client.subscribe();
        this.wireStream(this.stream);
        await this.resubscribe();
        this.connected = true;
        this.startPing();
        log.info("connected");
        return; // handlers take over; reconnect happens on error/end
      } catch (err) {
        attempt++;
        this.connected = false;
        const backoff = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
        log.error("connect failed; backing off", { attempt, backoffMs: backoff, err: String(err) });
        await sleep(backoff);
      }
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      try {
        this.stream?.write(pingRequest());
      } catch (err) {
        log.warn("ping write failed", { err: String(err) });
      }
    }, config.stream.pingIntervalMs);
  }

  private async resubscribe(): Promise<void> {
    if (!this.stream) return;
    const from = this.state.lastProcessedSlot > 0n ? this.state.lastProcessedSlot : undefined;
    await writeReq(this.stream, slotSubscribeRequest(from));
    if (this.trackedAccounts.length > 0) {
      await writeReq(this.stream, txSubscribeRequest(this.trackedAccounts));
    }
  }

  private wireStream(stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>): void {
    stream.on("data", (update: SubscribeUpdate) => this.onUpdate(update));
    stream.on("error", (err) => {
      log.error("stream error", { err: String(err) });
      this.onDisconnect();
    });
    stream.on("end", () => {
      log.warn("stream ended");
      this.onDisconnect();
    });
    stream.on("close", () => {
      log.warn("stream closed");
      this.onDisconnect();
    });
  }

  private reconnecting = false;
  private onDisconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    this.connected = false;
    this.reconnects++;
    if (this.pingTimer) clearInterval(this.pingTimer);
    const backoff = Math.min(30_000, 500 * 2 ** Math.min(this.reconnects, 6));
    log.warn("reconnecting", { reconnects: this.reconnects, backoffMs: backoff });
    setTimeout(() => {
      this.reconnecting = false;
      void this.connect();
    }, backoff);
  }

  private onUpdate(update: SubscribeUpdate): void {
    this.lastEventAt = Date.now();

    // server ping → reply to keep alive (FR-4)
    if (update.ping) {
      try {
        this.stream?.write(pingRequest());
      } catch {
        /* ignore */
      }
      return;
    }
    // our own pong ack — nothing to do
    if (update.pong) return;

    if (update.slot) {
      const slot = BigInt(update.slot.slot);
      const status = mapSlotStatus(update.slot.status);
      const key = `${slot}|${status}`;
      if (this.dedupe(key)) return; // replayed duplicate
      this.state.observe(slot);
      const ev: SlotEvent = {
        kind: "slot",
        slot,
        parent: update.slot.parent != null ? BigInt(update.slot.parent) : undefined,
        status,
        ts: this.lastEventAt,
      };
      this.queue.push(ev);
      return;
    }

    if (update.transaction) {
      const tx = update.transaction.transaction;
      const sig = tx?.signature ? bs58FromBytes(tx.signature) : undefined;
      if (!sig) return;
      const key = `tx|${sig}`;
      if (this.dedupe(key)) return;
      const ev: TxEvent = {
        kind: "tx",
        signature: sig,
        slot: BigInt(update.transaction.slot),
        isVote: tx?.isVote ?? false,
        failed: tx?.meta?.err != null,
        ts: this.lastEventAt,
      };
      this.queue.push(ev);
      return;
    }
  }

  /** Returns true if `key` was already seen (dedupe within replay window). */
  private dedupe(key: string): boolean {
    const set = key.startsWith("tx|") ? this.seenSigs : this.seenSlots;
    if (set.has(key)) return true;
    set.add(key);
    this.seenOrder.push(key);
    // bound memory: ~replay window × a few statuses per slot
    const cap = config.stream.replayWindowSlots * 8;
    while (this.seenOrder.length > cap) {
      const old = this.seenOrder.shift()!;
      (old.startsWith("tx|") ? this.seenSigs : this.seenSlots).delete(old);
    }
    return false;
  }
}

// ---- helpers ---------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Promisified single subscribe-request write. */
function writeReq(
  stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>,
  req: SubscribeRequest,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(req, (err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });
}

function bs58FromBytes(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}
