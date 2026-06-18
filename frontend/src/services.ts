import type { Bundle, AgentDecision, TipFloorSnapshot, AgentDecisionParams } from './types';

// Deterministic mock addresses and data generator helpers
import { useSolGuardStore } from './store';

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFihjz5EPg5Q8pD8krrG1685mYdBt9Q7tb',
  'HFq5ACJ6f2S3jaAp2HJeqVTaxriD441mznYTC2La6Dq8',
  'Cw8CFBTj43HFAph7Zf7sif42yCTkwqd3475sjWRqp7tb',
];

function generateRandomSig(): string {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return Array.from({ length: 88 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

let slotTimer: any = null;
let bundleTimer: any = null;
let simulatedBundles: {
  bundleId: string;
  stage: 'submitted' | 'processed' | 'confirmed' | 'finalized' | 'failed';
  startSlot: number;
  submittedAt: number;
  processedAt?: number;
  confirmedAt?: number;
  failureType?: string;
  isRetry?: boolean;
}[] = [];

// Failure scenario rotator
let failureIndex = 0;
const failureTypes = ['blockhash_expired', 'fee_too_low', 'bundle_dropped_leader_skip', 'compute_exceeded'];

export function startSimulation() {
  stopSimulation();
  
  const store = useSolGuardStore.getState();
  
  // 1. Telemetry and Slot Counter Tick (every 400ms)
  slotTimer = setInterval(() => {
    if (useSolGuardStore.getState().isLiveMode) return;
    
    const currentState = useSolGuardStore.getState();
    const nextSlot = currentState.slot + 1;
    store.setSlot(nextSlot);
    
    // Brownian random-walk telemetry updates
    const skipDrift = (Math.random() - 0.5) * 1.5;
    const newSkip = Math.max(0.5, Math.min(12.0, currentState.skipRate + skipDrift));
    
    const pcDrift = (Math.random() - 0.5) * 80;
    const newPc = Math.max(210, Math.min(850, currentState.pcDelta + Math.round(pcDrift)));
    
    // Next leader schedule window calculation
    const countdown = 4 - (nextSlot % 4);
    const isJitoWindowActive = nextSlot % 12 < 4; // simulated Jito active 4 out of 12 slots
    const jitoLeaderSlot = isJitoWindowActive ? nextSlot + countdown : nextSlot + 12 - (nextSlot % 12);
    
    store.updateNetworkHealth(
      parseFloat(newSkip.toFixed(2)), 
      newPc, 
      jitoLeaderSlot
    );

    // Tip Floor drift
    const tfDrift = (Math.random() - 0.5) * 2000;
    const currentTf = currentState.tipFloor;
    const newTf: TipFloorSnapshot = {
      p25: Math.max(1000, Math.round(currentTf.p25 + tfDrift * 0.5)),
      p50: Math.max(5000, Math.round(currentTf.p50 + tfDrift * 0.8)),
      p75: Math.max(12000, Math.round(currentTf.p75 + tfDrift * 1.2)),
      p95: Math.max(25000, Math.round(currentTf.p95 + tfDrift * 1.5)),
      p99: Math.max(50000, Math.round(currentTf.p99 + tfDrift * 2.0)),
      ema: Math.max(4000, Math.round(currentTf.ema + tfDrift * 0.9)),
      fetchedAt: Date.now(),
    };
    // Keep relative ordering
    newTf.p50 = Math.max(newTf.p50, newTf.p25 + 1000);
    newTf.p75 = Math.max(newTf.p75, newTf.p50 + 2000);
    newTf.p95 = Math.max(newTf.p95, newTf.p75 + 5000);
    newTf.p99 = Math.max(newTf.p99, newTf.p95 + 10000);
    store.setTipFloor(newTf);

    // Advance simulated bundle pipelines
    advanceBundles(nextSlot);
  }, 400);

  // 2. Normal Bundle Spawning (every 3 seconds)
  bundleTimer = setInterval(() => {
    if (useSolGuardStore.getState().isLiveMode) return;
    
    // Spawn bundle under 10% failure risk
    const shouldFail = Math.random() < 0.10;
    if (shouldFail) {
      const type = failureTypes[failureIndex];
      failureIndex = (failureIndex + 1) % failureTypes.length;
      simulateFailureScenario(type);
    } else {
      spawnNormalBundle();
    }
  }, 3000);
}

export function stopSimulation() {
  if (slotTimer) clearInterval(slotTimer);
  if (bundleTimer) clearInterval(bundleTimer);
  slotTimer = null;
  bundleTimer = null;
  simulatedBundles = [];
}

function spawnNormalBundle() {
  const store = useSolGuardStore.getState();
  const bundleId = `bundle_${Math.random().toString(36).substring(2, 11)}`;
  const tipLamports = store.recommendedLamports;
  const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
  const signatures = [generateRandomSig()];
  
  const bundle: Bundle = {
    bundleId,
    signatures,
    stage: 'submitted',
    tipLamports,
    tipAccount,
    attempt: 1,
    stages: {
      submitted: { slot: store.slot, ts: new Date().toISOString() },
    },
    deltas_ms: {},
    failure: null,
    confirmed_via: null,
  };

  store.addBundle(bundle);
  
  simulatedBundles.push({
    bundleId,
    stage: 'submitted',
    startSlot: store.slot,
    submittedAt: Date.now(),
  });
}

function advanceBundles(currentSlot: number) {
  const store = useSolGuardStore.getState();
  
  simulatedBundles = simulatedBundles.map((b) => {
    const elapsedSlots = currentSlot - b.startSlot;
    
    if (b.stage === 'submitted' && elapsedSlots >= 1) {
      if (b.failureType) {
        // Deterministic failure transition
        const ts = new Date().toISOString();
        store.failBundle(b.bundleId, {
          type: b.failureType,
          evidence: getMockFailureEvidence(b.failureType, store),
          detectedAtSlot: currentSlot,
          ts,
        });
        
        // Trigger AI Decision Log entry after 800ms
        triggerAIDecision(b.bundleId, b.failureType, store);
        
        return { ...b, stage: 'failed' as const };
      } else {
        // Normal progression: submitted -> processed
        const ts = new Date().toISOString();
        const delta = 100 + Math.floor(Math.random() * 80);
        store.updateBundleStage(b.bundleId, 'processed', currentSlot, ts, delta);
        return { ...b, stage: 'processed' as const, processedAt: Date.now() };
      }
    }
    
    if (b.stage === 'processed' && b.processedAt && Date.now() - b.processedAt > 400) {
      // processed -> confirmed
      const ts = new Date().toISOString();
      const delta = 300 + Math.floor(Math.random() * 100);
      store.updateBundleStage(b.bundleId, 'confirmed', currentSlot, ts, delta);
      return { ...b, stage: 'confirmed' as const, confirmedAt: Date.now() };
    }
    
    if (b.stage === 'confirmed' && b.confirmedAt && Date.now() - b.confirmedAt > 4000) {
      // confirmed -> finalized (fast tracked in simulation to 4s for showcase layout visibility)
      const ts = new Date().toISOString();
      const delta = 4200;
      store.updateBundleStage(b.bundleId, 'finalized', currentSlot, ts, delta);
      return { ...b, stage: 'finalized' as const };
    }
    
    return b;
  }).filter((b) => b.stage !== 'finalized' && b.stage !== 'failed');
}

function getMockFailureEvidence(type: string, store: any): any {
  switch (type) {
    case 'blockhash_expired':
      return { last_valid_block_height: 312450, current_block_height: 312460, blockhash_age_slots: 250 };
    case 'fee_too_low':
      return { tip_lamports: 1, tip_floor_p50: store.tipFloor.p50, congestion_multiplier: store.skipRate > 5 ? 2.5 : 1.0, skip_rate: store.skipRate };
    case 'bundle_dropped_leader_skip':
      return { slotsUntilJitoLeader: -1, observedSkipSlot: store.slot };
    case 'compute_exceeded':
      return { simulationError: 'Transaction simulation failed: Exceeded compute budget limit of 200000 CUs' };
    default:
      return {};
  }
}

function triggerAIDecision(bundleId: string, type: string, store: any) {
  setTimeout(() => {
    if (useSolGuardStore.getState().isLiveMode) return;
    
    const diagnosis = getMockDiagnosis(type, store);
    const action = getMockAction(type);
    const params = getMockParams(type, store);
    
    const decision: AgentDecision = {
      ts: new Date().toISOString(),
      trigger: 'injected_fault',
      decision_source: 'live_model',
      input_context: {
        bundleId,
        bundle: { bundleId, tip_lamports: type === 'fee_too_low' ? 1 : store.recommendedLamports },
        failure: { type },
        network: { skipRate: store.skipRate, current_slot: store.slot, tip_floor: store.tipFloor },
      },
      raw_reasoning: `Evaluating bundle failure: ${type}. Diagnosing root cause...`,
      validated_decision: {
        diagnosis,
        root_cause: type,
        action,
        params,
        confidence: 0.85 + Math.random() * 0.1,
        expected_outcome: getMockExpectedOutcome(type, action),
      },
      guardrail_action: 'accepted',
      executed_action: action,
      eventual_outcome: action === 'abort' ? 'aborted — non-recoverable' : '[pending — resubmitting]',
    };

    useSolGuardStore.getState().addDecision(decision);

    // If retry is selected, autonomously resubmit the bundle after 1.5s
    if (action === 'retry') {
      setTimeout(() => {
        if (useSolGuardStore.getState().isLiveMode) return;
        
        const retryBundleId = `bundle_${Math.random().toString(36).substring(2, 11)}`;
        const tipLamports = params.new_tip_lamports;
        const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
        
        const retryBundle: Bundle = {
          bundleId: retryBundleId,
          signatures: [generateRandomSig()],
          stage: 'submitted',
          tipLamports,
          tipAccount,
          attempt: 2,
          stages: {
            submitted: { slot: store.slot, ts: new Date().toISOString() },
          },
          deltas_ms: {},
          failure: null,
          confirmed_via: null,
        };

        // Add to active simulation queue to transition through stages
        store.addBundle(retryBundle);
        simulatedBundles.push({
          bundleId: retryBundleId,
          stage: 'submitted',
          startSlot: store.slot,
          submittedAt: Date.now(),
          isRetry: true,
        });

        // Patch decision ledger eventual outcome
        useSolGuardStore.getState().updateDecisionOutcome(bundleId, `retry landed @ slot ${store.slot}`);
      }, 1500);
    }
  }, 1000);
}

function getMockDiagnosis(type: string, store: any): string {
  switch (type) {
    case 'blockhash_expired':
      return `Blockhash expired with age of 250 slots at slot ${store.slot}, exceeding the 150-slot validity window. Telemetry shows skip rate is normal (${store.skipRate}%). Refreshing blockhash and targeting next Jito leader slot is recommended.`;
    case 'fee_too_low':
      return `Bundle tip of 1 lamport fell below the p25 floor (${store.tipFloor.p25} lamports) under skip rate ${store.skipRate}%. The Jito auction failed to prioritize execution. Tip escalation is required to ensure inclusion.`;
    case 'bundle_dropped_leader_skip':
      return `Jito validator skipped producing during the targeted slot window near slot ${store.slot}. Bundle dropped cleanly due to slot leader skip. Submitting immediately is unsafe; holding execution until the next Jito window is recommended.`;
    case 'compute_exceeded':
      return `Transaction execution blew the compute budget limit (requested instructions require more than 200,000 CUs). This is a static execution error. Retrying is non-viable without refactoring transaction logic.`;
    default:
      return 'Unknown simulation failure observed.';
  }
}

function getMockAction(type: string): 'retry' | 'hold' | 'abort' {
  if (type === 'compute_exceeded') return 'abort';
  if (type === 'bundle_dropped_leader_skip') return 'hold';
  return 'retry';
}

function getMockParams(type: string, store: any): AgentDecisionParams {
  const currentSlot = store.slot;
  return {
    refresh_blockhash: type === 'blockhash_expired',
    new_tip_lamports: type === 'fee_too_low' ? store.tipFloor.p75 : store.recommendedLamports,
    tip_percentile_target: type === 'fee_too_low' ? 75 : 50,
    submit_at_slot: type === 'bundle_dropped_leader_skip' ? currentSlot + 12 : currentSlot + 2,
    max_blockhash_age_slots: 60,
  };
}

function getMockExpectedOutcome(_type: string, action: string): string {
  if (action === 'abort') return 'Halt bundle execution to protect wallet funds.';
  if (action === 'hold') return 'Postpone resubmission until leader conditions improve.';
  return 'Resubmitted bundle will land successfully on next Jito leader window.';
}

export function simulateFailureScenario(type: string) {
  const store = useSolGuardStore.getState();
  const bundleId = `bundle_${Math.random().toString(36).substring(2, 11)}`;
  const tipLamports = type === 'fee_too_low' ? 1 : store.recommendedLamports;
  const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
  const signatures = [generateRandomSig()];
  
  const bundle: Bundle = {
    bundleId,
    signatures,
    stage: 'submitted',
    tipLamports,
    tipAccount,
    attempt: 1,
    stages: {
      submitted: { slot: store.slot, ts: new Date().toISOString() },
    },
    deltas_ms: {},
    failure: null,
    confirmed_via: null,
  };

  store.addBundle(bundle);
  
  simulatedBundles.push({
    bundleId,
    stage: 'submitted',
    startSlot: store.slot,
    submittedAt: Date.now(),
    failureType: type,
  });
}

// Websocket / SSE live integration
let ws: WebSocket | null = null;
let bundleSource: EventSource | null = null;
let decisionSource: EventSource | null = null;

export function connectToLiveBridge(url: string) {
  disconnectFromLiveBridge();
  stopSimulation();
  
  const store = useSolGuardStore.getState();
  store.setLiveMode(true);
  store.clearBundles();
  store.clearDecisions();

  // 1. WebSocket for Telemetry updates
  const wsUrl = url.startsWith('http') ? url.replace(/^http/, 'ws') : url;
  ws = new WebSocket(`${wsUrl}/ws/stream`);
  
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'slot_update' && data.slot) {
        store.setSlot(data.slot);
      } else if (data.type === 'network_update') {
        store.updateNetworkHealth(data.skipRate, data.pcDelta, data.jitoLeaderSlot);
      } else if (data.type === 'tip_update' && data.tipFloor) {
        store.setTipFloor(data.tipFloor);
      }
    } catch (err) {
      console.error('Error parsing live WS frame', err);
    }
  };

  ws.onclose = () => {
    console.warn('Live WS closed; fall back to simulation for safety');
    store.setLiveMode(false);
    startSimulation();
  };

  // 2. SSE for Bundle Lifecycle events
  const httpUrl = url.replace(/^ws/, 'http');
  bundleSource = new EventSource(`${httpUrl}/sse/bundles`);
  bundleSource.addEventListener('bundle_event', (event) => {
    try {
      const bEvent = JSON.parse(event.data);
      if (bEvent.stage === 'submitted') {
        const bundle: Bundle = {
          bundleId: bEvent.bundleId,
          signatures: bEvent.signatures,
          stage: 'submitted',
          tipLamports: bEvent.tipLamports,
          tipAccount: bEvent.tipAccount,
          attempt: bEvent.attempt || 1,
          stages: {
            submitted: { slot: bEvent.slot, ts: bEvent.timestamp },
          },
          deltas_ms: {},
          failure: null,
          confirmed_via: null,
        };
        store.addBundle(bundle);
      } else if (bEvent.stage === 'failed') {
        store.failBundle(bEvent.bundleId, {
          type: bEvent.failureType || 'unknown',
          evidence: bEvent.evidence || {},
          detectedAtSlot: bEvent.slot,
          ts: bEvent.timestamp,
        });
      } else {
        store.updateBundleStage(
          bEvent.bundleId, 
          bEvent.stage, 
          bEvent.slot, 
          bEvent.timestamp, 
          bEvent.deltaMs
        );
      }
    } catch (err) {
      console.error('Error parsing SSE bundle event', err);
    }
  });

  // 3. SSE for AI decisions
  decisionSource = new EventSource(`${httpUrl}/sse/decisions`);
  decisionSource.addEventListener('decision_event', (event) => {
    try {
      const dEvent = JSON.parse(event.data);
      const decision: AgentDecision = {
        ts: dEvent.triggeredAt || new Date().toISOString(),
        trigger: dEvent.trigger === 'injected_fault' ? 'injected_fault' : 'real_failure',
        decision_source: dEvent.decision_source || 'live_model',
        input_context: dEvent.input_context || {},
        raw_reasoning: dEvent.rawReasoning || '',
        validated_decision: {
          diagnosis: dEvent.diagnosis,
          root_cause: dEvent.rootCause,
          action: dEvent.action,
          params: {
            refresh_blockhash: dEvent.params?.refreshBlockhash,
            new_tip_lamports: dEvent.params?.newTipLamports || 0,
            tip_percentile_target: dEvent.params?.tipPercentileTarget ? parseInt(dEvent.params.tipPercentileTarget) : 50,
            submit_at_slot: dEvent.params?.submitAtSlot || 0,
            max_blockhash_age_slots: dEvent.params?.maxBlockhashAgeSlots || 60,
          },
          confidence: dEvent.confidence || 1.0,
          expected_outcome: dEvent.expected_outcome || '',
        },
        guardrail_action: dEvent.guardrail_action || 'accepted',
        executed_action: dEvent.action,
        eventual_outcome: dEvent.eventual_outcome || '[pending]',
      };
      store.addDecision(decision);
    } catch (err) {
      console.error('Error parsing SSE decision event', err);
    }
  });
}

export function disconnectFromLiveBridge() {
  if (ws) ws.close();
  if (bundleSource) bundleSource.close();
  if (decisionSource) decisionSource.close();
  ws = null;
  bundleSource = null;
  decisionSource = null;
}
