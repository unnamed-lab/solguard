/** Normalized stream events emitted by the Stream Manager. */

export type Commitment = "processed" | "confirmed" | "finalized";

export interface SlotEvent {
  kind: "slot";
  slot: bigint;
  parent?: bigint;
  /** Slot status mapped to a commitment level. */
  status: Commitment;
  /** Local receive time (ms epoch) for latency-delta math. */
  ts: number;
}

export interface TxEvent {
  kind: "tx";
  signature: string;
  slot: bigint;
  isVote: boolean;
  failed: boolean;
  ts: number;
}

export type StreamEvent = SlotEvent | TxEvent;

export interface StreamMetrics {
  reconnects: number;
  droppedEvents: number;
  queueSize: number;
  enqueued: number;
  lastProcessedSlot: string;
  connected: boolean;
  lastEventAt: number;
}
