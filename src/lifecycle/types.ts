/** Lifecycle data models (PRD §9). */

export type Stage = "submitted" | "processed" | "confirmed" | "finalized";

export interface StageStamp {
  slot: number;
  ts: string; // ISO timestamp
}

export type FailureClass =
  | "blockhash_expired"
  | "fee_too_low"
  | "compute_exceeded"
  | "bundle_dropped_leader_skip"
  | "simulation_failed";

export interface FailureRecord {
  type: FailureClass;
  evidence: Record<string, unknown>;
  detectedAtSlot: number;
  ts: string;
}

export interface LifecycleEntry {
  bundle_id: string;
  signatures: string[];
  tip_lamports: number;
  tip_account: string;
  attempt: number;
  stages: Partial<Record<Stage, StageStamp>>;
  deltas_ms: {
    submitted_to_processed?: number;
    processed_to_confirmed?: number;
    confirmed_to_finalized?: number;
  };
  failure: FailureRecord | null;
  confirmed_via: "stream" | "status_api" | null;
}
