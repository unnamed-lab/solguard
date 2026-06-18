import { create } from 'zustand';
import type { Bundle, TipFloorSnapshot, AgentDecision, StreamEvent } from './types';

interface SolGuardState {
  // Mode selection
  isLiveMode: boolean;
  setLiveMode: (isLive: boolean) => void;

  // Network Telemetry
  slot: number;
  skipRate: number;
  pcDelta: number;
  skipHistory: number[];
  jitoLeaderSlot: number | null;
  networkStatus: 'healthy' | 'congested' | 'degraded';
  setSlot: (slot: number) => void;
  updateNetworkHealth: (skipRate: number, pcDelta: number, jitoLeaderSlot?: number | null) => void;

  // Bundle Feed
  bundles: Bundle[];
  selectedBundleId: string | null;
  landedCount: number;
  failedCount: number;
  setSelectedBundleId: (id: string | null) => void;
  addBundle: (bundle: Bundle) => void;
  updateBundleStage: (
    bundleId: string, 
    stage: 'processed' | 'confirmed' | 'finalized', 
    slot: number,
    ts: string,
    deltaMs?: number
  ) => void;
  failBundle: (bundleId: string, failure: Bundle['failure']) => void;
  clearBundles: () => void;

  // Tip Intelligence
  tipFloor: TipFloorSnapshot;
  recommendedPercentile: 'p25' | 'p50' | 'p75' | 'p95' | 'p99';
  recommendedLamports: number;
  setTipFloor: (snapshot: TipFloorSnapshot) => void;
  updateRecommendation: () => void;

  // AI Decision Ledger
  decisions: AgentDecision[];
  totalDecisions: number;
  addDecision: (decision: AgentDecision) => void;
  updateDecisionOutcome: (bundleId: string, outcome: string) => void;
  clearDecisions: () => void;

  // Yellowstone Stream Feed
  streamEvents: StreamEvent[];
  pushStreamEvent: (event: StreamEvent) => void;
  clearStreamEvents: () => void;
}

const initialTipFloor: TipFloorSnapshot = {
  p25: 1200,
  p50: 5000,
  p75: 18000,
  p95: 62000,
  p99: 150000,
  ema: 8400,
  fetchedAt: Date.now(),
};

export const useSolGuardStore = create<SolGuardState>((set, get) => ({
  // Mode
  isLiveMode: false,
  setLiveMode: (isLive) => set({ isLiveMode: isLive }),

  // Network Telemetry
  slot: 427200000,
  skipRate: 2.3,
  pcDelta: 385,
  skipHistory: Array.from({ length: 24 }, () => 1.5 + Math.random() * 2),
  jitoLeaderSlot: null,
  networkStatus: 'healthy',
  setSlot: (slot) => set({ slot }),
  updateNetworkHealth: (skipRate, pcDelta, jitoLeaderSlot = null) => {
    let networkStatus: 'healthy' | 'congested' | 'degraded' = 'healthy';
    if (skipRate > 9.0 || pcDelta > 600) {
      networkStatus = 'degraded';
    } else if (skipRate > 5.0 || pcDelta > 450) {
      networkStatus = 'congested';
    }
    
    set((state) => {
      const newHistory = [...state.skipHistory.slice(1), skipRate];
      return {
        skipRate,
        pcDelta,
        jitoLeaderSlot,
        networkStatus,
        skipHistory: newHistory,
      };
    });
    
    // Automatically update tip recommendation based on new congestion
    get().updateRecommendation();
  },

  // Bundle Feed
  bundles: [],
  selectedBundleId: null,
  landedCount: 0,
  failedCount: 0,
  setSelectedBundleId: (selectedBundleId) => set({ selectedBundleId }),
  addBundle: (bundle) => set((state) => {
    // Keep max 15 bundles in UI
    const newBundles = [bundle, ...state.bundles.slice(0, 14)];
    return { bundles: newBundles };
  }),
  updateBundleStage: (bundleId, stage, slot, ts, deltaMs) => set((state) => {
    const updated = state.bundles.map((b) => {
      if (b.bundleId === bundleId) {
        const stages = { ...b.stages, [stage]: { slot, ts } };
        const deltas_ms = { ...b.deltas_ms };
        
        if (stage === 'processed' && b.stages.submitted) {
          deltas_ms.submitted_to_processed = deltaMs ?? (new Date(ts).getTime() - new Date(b.stages.submitted.ts).getTime());
        }
        if (stage === 'confirmed' && stages.processed) {
          deltas_ms.processed_to_confirmed = deltaMs ?? (new Date(ts).getTime() - new Date(stages.processed.ts).getTime());
        }
        if (stage === 'finalized' && stages.confirmed) {
          deltas_ms.confirmed_to_finalized = deltaMs ?? (new Date(ts).getTime() - new Date(stages.confirmed.ts).getTime());
        }

        return {
          ...b,
          stage: stage === 'finalized' ? 'finalized' as const : stage === 'confirmed' ? 'confirmed' as const : 'processed' as const,
          stages,
          deltas_ms,
        };
      }
      return b;
    });

    const landedIncrement = stage === 'finalized' ? 1 : 0;

    return {
      bundles: updated,
      landedCount: state.landedCount + landedIncrement,
    };
  }),
  failBundle: (bundleId, failure) => set((state) => {
    const updated = state.bundles.map((b) => {
      if (b.bundleId === bundleId) {
        return {
          ...b,
          stage: 'failed' as const,
          failure,
        };
      }
      return b;
    });
    return {
      bundles: updated,
      failedCount: state.failedCount + 1,
    };
  }),
  clearBundles: () => set({ bundles: [], landedCount: 0, failedCount: 0, selectedBundleId: null }),

  // Tip Intelligence
  tipFloor: initialTipFloor,
  recommendedPercentile: 'p50',
  recommendedLamports: initialTipFloor.p50,
  setTipFloor: (tipFloor) => {
    set({ tipFloor });
    get().updateRecommendation();
  },
  updateRecommendation: () => set((state) => {
    const { skipRate, pcDelta, tipFloor } = state;
    let percentile: 'p25' | 'p50' | 'p75' | 'p95' | 'p99' = 'p50';
    if (skipRate > 9.0 || pcDelta > 650) {
      percentile = 'p95';
    } else if (skipRate > 5.0 || pcDelta > 450) {
      percentile = 'p75';
    } else if (skipRate < 1.5) {
      percentile = 'p25';
    }
    
    return {
      recommendedPercentile: percentile,
      recommendedLamports: tipFloor[percentile],
    };
  }),

  // AI Decision Ledger
  decisions: [],
  totalDecisions: 0,
  addDecision: (decision) => set((state) => ({
    decisions: [decision, ...state.decisions.slice(0, 19)],
    totalDecisions: state.totalDecisions + 1,
  })),
  updateDecisionOutcome: (bundleId, outcome) => set((state) => {
    const updated = state.decisions.map((d) => {
      // Find the decision associated with this bundleId in its input_context or payload
      if (d.input_context?.bundle?.bundleId === bundleId || d.validated_decision?.expected_outcome?.includes(bundleId)) {
        return { ...d, eventual_outcome: outcome };
      }
      // Alternate matching: check if any part of the decision links to the bundle
      const ctxBundleId = d.input_context?.bundleId ?? d.input_context?.bundle?.bundleId;
      if (ctxBundleId === bundleId) {
        return { ...d, eventual_outcome: outcome };
      }
      return d;
    });
    return { decisions: updated };
  }),
  clearDecisions: () => set({ decisions: [], totalDecisions: 0 }),

  // Yellowstone Stream Feed
  streamEvents: [],
  pushStreamEvent: (event) => set((state) => ({
    streamEvents: [event, ...state.streamEvents.slice(0, 79)],
  })),
  clearStreamEvents: () => set({ streamEvents: [] }),
}));
