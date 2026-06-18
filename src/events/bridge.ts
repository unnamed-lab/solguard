import { EventEmitter } from "node:events";
import type { TipFloor } from "../tips/tipFloor.js";

export interface TelemetryPayload {
  slot: number;
  /** percentage (0-100), e.g. 2.3 means 2.3% */
  skipRate: number;
  /** processed→confirmed p50 in ms */
  pcDelta: number;
  jitoLeaderSlot: number | null;
  /** included only when the tip floor snapshot changes */
  tipFloor?: TipFloor;
}

export interface BundlePayload {
  bundleId: string;
  stage: "submitted" | "processed" | "confirmed" | "finalized" | "failed";
  slot: number;
  timestamp: string;
  /** only on submitted */
  signatures?: string[];
  tipLamports?: number;
  tipAccount?: string;
  attempt?: number;
  /** only on stage transitions */
  deltaMs?: number;
  /** only on failed */
  failureType?: string;
  evidence?: Record<string, unknown>;
}

export interface DecisionPayload {
  triggeredAt: string;
  trigger: "real_failure" | "injected_fault";
  decision_source: string;
  input_context: unknown;
  rawReasoning: string;
  diagnosis?: string;
  rootCause?: string;
  action?: string;
  params?: {
    refreshBlockhash?: boolean;
    newTipLamports?: number;
    tipPercentileTarget?: number;
    submitAtSlot?: number;
    maxBlockhashAgeSlots?: number;
  };
  confidence?: number;
  expected_outcome?: string;
  guardrail_action?: string;
  executed_action?: string;
  eventual_outcome: string;
}

// TypeScript declaration merging for typed emit/on
declare interface SolGuardBridge {
  emit(event: "telemetry", data: TelemetryPayload): boolean;
  on(event: "telemetry", listener: (data: TelemetryPayload) => void): this;
  off(event: "telemetry", listener: (data: TelemetryPayload) => void): this;

  emit(event: "bundle_event", data: BundlePayload): boolean;
  on(event: "bundle_event", listener: (data: BundlePayload) => void): this;
  off(event: "bundle_event", listener: (data: BundlePayload) => void): this;

  emit(event: "decision_event", data: DecisionPayload): boolean;
  on(event: "decision_event", listener: (data: DecisionPayload) => void): this;
  off(event: "decision_event", listener: (data: DecisionPayload) => void): this;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class SolGuardBridge extends EventEmitter {}

export const bridge = new SolGuardBridge();
bridge.setMaxListeners(100);
