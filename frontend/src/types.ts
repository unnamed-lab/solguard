export interface BundleStageInfo {
  slot: number;
  ts: string; // ISO string
}

export interface BundleFailure {
  type: string;
  evidence: any;
  detectedAtSlot: number;
  ts: string;
}

export interface BundleDeltas {
  submitted_to_processed?: number;
  processed_to_confirmed?: number;
  confirmed_to_finalized?: number;
}

export interface Bundle {
  bundleId: string;
  signatures: string[];
  stage: 'submitted' | 'processed' | 'confirmed' | 'finalized' | 'failed';
  tipLamports: number;
  tipAccount: string;
  attempt: number;
  stages: {
    submitted: BundleStageInfo;
    processed?: BundleStageInfo;
    confirmed?: BundleStageInfo;
    finalized?: BundleStageInfo;
  };
  deltas_ms: BundleDeltas;
  failure: BundleFailure | null;
  confirmed_via: string | null;
}

export interface TipFloorSnapshot {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  ema: number;
  fetchedAt: number;
}

export interface AgentDecisionParams {
  refresh_blockhash: boolean;
  new_tip_lamports: number;
  tip_percentile_target: number;
  submit_at_slot: number;
  max_blockhash_age_slots: number;
}

export type StreamEventType =
  | 'slot_processed'
  | 'slot_confirmed'
  | 'slot_finalized'
  | 'tx_seen'
  | 'jito_window'
  | 'rpc_fallback'
  | 'bundle_submitted'
  | 'bundle_landed';

export interface StreamEvent {
  id: string;
  type: StreamEventType;
  slot: number;
  ts: number;
  label: string;
  detail?: string;
  highlight?: boolean;
}

export interface AgentDecision {
  ts: string;
  trigger: 'real_failure' | 'injected_fault';
  decision_source: 'live_model' | 'local_mock' | 'grounded_fallback' | 'safe_abort';
  input_context: any;
  raw_reasoning: string;
  validated_decision: {
    diagnosis: string;
    root_cause: string;
    action: 'retry' | 'hold' | 'abort';
    params: AgentDecisionParams;
    confidence: number;
    expected_outcome: string;
  };
  guardrail_action: 'accepted' | 're-prompted' | 'rejected';
  executed_action: 'retry' | 'hold' | 'abort';
  eventual_outcome: string;
}
