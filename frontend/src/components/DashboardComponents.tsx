import React, { useState } from 'react';
import { useSolGuardStore } from '../store';
import { 
  shortenSignature, 
  formatSlot, 
  formatMs, 
  formatTime,
  formatNumber
} from '../utils';
import { 
  simulateFailureScenario, 
  connectToLiveBridge, 
  disconnectFromLiveBridge,
  startSimulation
} from '../services';
import { 
  Activity, 
  ShieldAlert, 
  CheckCircle2, 
  Clock, 
  TrendingUp, 
  Zap, 
  Cpu, 
  Terminal,
  FileJson,
  Wifi,
  WifiOff
} from 'lucide-react';

// ==========================================
// 1. HEADER COMPONENT
// ==========================================
export const Header: React.FC = () => {
  const { networkStatus, isLiveMode } = useSolGuardStore();
  const [bridgeUrl, setBridgeUrl] = useState('http://localhost:3000');
  const [showConnectModal, setShowConnectModal] = useState(false);

  const handleToggleMode = () => {
    if (isLiveMode) {
      disconnectFromLiveBridge();
      useSolGuardStore.getState().setLiveMode(false);
      // Restart simulation
      startSimulation();
    } else {
      setShowConnectModal(true);
    }
  };

  const handleConnectLive = () => {
    connectToLiveBridge(bridgeUrl);
    setShowConnectModal(false);
  };

  return (
    <header className="glass-panel w-full border-b border-slate-800/80 px-6 py-4 flex flex-col md:flex-row justify-between items-center gap-4 z-10">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-purple-600/30 flex items-center justify-center border border-purple-500/40 shadow-[0_0_15px_-3px_rgba(168,85,247,0.5)]">
          <Activity className="w-5 h-5 text-purple-400" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold font-sans tracking-tight text-white m-0">SolGuard</h1>
            <span className="text-[10px] font-mono font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded">
              v0.1.0-PRO
            </span>
          </div>
          <p className="text-xs text-slate-400 m-0">Autonomous Bundle Intelligence Stack</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {/* Network indicators */}
        <div className="flex items-center gap-2 bg-slate-900/80 px-3 py-1.5 rounded-lg border border-slate-800 text-xs">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span className="text-slate-400">Solana Network:</span>
          <span className="text-slate-200 font-mono">
            {new URLSearchParams(window.location.search).get('cluster') || 'devnet'}
          </span>
        </div>

        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold ${
          networkStatus === 'healthy' 
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' 
            : networkStatus === 'congested'
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          <ShieldAlert className="w-3.5 h-3.5" />
          <span>Status: {networkStatus.toUpperCase()}</span>
        </div>

        {/* Live Mode Toggle Button */}
        <button
          onClick={handleToggleMode}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg border text-xs font-bold transition-all duration-200 ${
            isLiveMode
              ? 'bg-purple-600/30 border-purple-500/60 text-purple-300 shadow-[0_0_15px_-3px_rgba(168,85,247,0.4)]'
              : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
          }`}
        >
          {isLiveMode ? <Wifi className="w-3.5 h-3.5 text-purple-400 animate-pulse" /> : <WifiOff className="w-3.5 h-3.5" />}
          <span>{isLiveMode ? 'LIVE MODE ACTIVE' : 'DEMO MODE (SIMULATED)'}</span>
        </button>
      </div>

      {showConnectModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl border border-slate-700/60 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-2">Connect to Live Bridge</h3>
            <p className="text-sm text-slate-400 mb-4">
              Connect to your running backend orchestrator to visualize Yellowstone gRPC, Jito tip-floors, and live AI Agent decisions.
            </p>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">Backend Bridge URL</label>
              <input
                type="text"
                value={bridgeUrl}
                onChange={(e) => setBridgeUrl(e.target.value)}
                placeholder="http://localhost:3000"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-purple-500/50 font-mono"
              />
            </div>
            <div className="flex justify-end gap-2 text-xs">
              <button
                onClick={() => setShowConnectModal(false)}
                className="px-4 py-2 bg-slate-900 text-slate-400 rounded-lg hover:bg-slate-800 border border-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={handleConnectLive}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500 hover:shadow-lg"
              >
                Connect Bridge
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};

// ==========================================
// 2. METRIC CARDS
// ==========================================
export const MetricCards: React.FC = () => {
  const { slot, skipRate, pcDelta, landedCount } = useSolGuardStore();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 px-6 mt-6">
      {/* Slot Counter */}
      <div className="glass-panel p-5 rounded-2xl relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/5 rounded-full blur-2xl group-hover:bg-purple-500/10 transition-all duration-300"></div>
        <div className="flex justify-between items-start">
          <div>
            <span className="text-xs font-semibold text-slate-400 block mb-1">CURRENT SLOT</span>
            <span className="text-2xl font-bold font-mono text-white pulse-slot block">{formatSlot(slot)}</span>
          </div>
          <span className="text-xs bg-purple-500/10 border border-purple-500/30 text-purple-400 px-2 py-0.5 rounded font-mono">gRPC Feed</span>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-xs text-emerald-400">
          <Clock className="w-3.5 h-3.5" />
          <span>Streaming slots at ~400ms interval</span>
        </div>
      </div>

      {/* Skip Rate */}
      <div className="glass-panel p-5 rounded-2xl relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-2xl group-hover:bg-amber-500/10 transition-all duration-300"></div>
        <div className="flex justify-between items-start">
          <div>
            <span className="text-xs font-semibold text-slate-400 block mb-1">SLOT SKIP RATE</span>
            <span className="text-2xl font-bold font-mono text-white block">{skipRate}%</span>
          </div>
          <span className="text-xs bg-slate-900 border border-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono">64-Window</span>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
          <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
            <div 
              className={`h-full rounded-full transition-all duration-300 ${skipRate > 9.0 ? 'bg-red-500' : skipRate > 5.0 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${Math.min(100, (skipRate / 12) * 100)}%` }}
            ></div>
          </div>
        </div>
      </div>

      {/* Processed to Confirmed Delta */}
      <div className="glass-panel p-5 rounded-2xl relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-full blur-2xl group-hover:bg-blue-500/10 transition-all duration-300"></div>
        <div className="flex justify-between items-start">
          <div>
            <span className="text-xs font-semibold text-slate-400 block mb-1">P→C VOTE DELTA</span>
            <span className="text-2xl font-bold font-mono text-white block">{pcDelta}ms</span>
          </div>
          <span className="text-xs bg-blue-500/10 border border-blue-500/30 text-blue-400 px-2 py-0.5 rounded font-mono">p50 Latency</span>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
          <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
            <div 
              className={`h-full rounded-full transition-all duration-300 ${pcDelta > 600 ? 'bg-red-500' : pcDelta > 450 ? 'bg-amber-500' : 'bg-blue-500'}`}
              style={{ width: `${Math.min(100, ((pcDelta - 200) / 700) * 100)}%` }}
            ></div>
          </div>
        </div>
      </div>

      {/* Bundles Landed Counter */}
      <div className="glass-panel p-5 rounded-2xl relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-all duration-300"></div>
        <div className="flex justify-between items-start">
          <div>
            <span className="text-xs font-semibold text-slate-400 block mb-1">BUNDLES LANDED</span>
            <span className="text-2xl font-bold font-mono text-emerald-400 block">{landedCount}</span>
          </div>
          <span className="text-xs bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 px-2 py-0.5 rounded font-mono">Landed</span>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
          <span>Dynamically tipped on-chain bundles</span>
        </div>
      </div>
    </div>
  );
};

// ==========================================
// 3. LEFT PANEL: NETWORK HEALTH + TIP INTELLIGENCE
// ==========================================
export const LeftPanel: React.FC = () => {
  const { skipHistory, jitoLeaderSlot, slot } = useSolGuardStore();
  const { tipFloor, recommendedPercentile, recommendedLamports } = useSolGuardStore();

  const slotsUntilLeader = jitoLeaderSlot ? jitoLeaderSlot - slot : null;
  const isJitoWindowActive = slotsUntilLeader !== null && slotsUntilLeader <= 4 && slotsUntilLeader >= 0;

  return (
    <div className="flex flex-col gap-4">
      {/* 3.1 Network Health Widget */}
      <div className="glass-panel p-5 rounded-2xl flex flex-col gap-4">
        <div className="flex items-center gap-2 border-b border-slate-800/80 pb-3">
          <TrendingUp className="w-4.5 h-4.5 text-purple-400" />
          <h3 className="text-sm font-bold text-white m-0">Congestion Oracle Feed</h3>
        </div>

        {/* Sparkline chart */}
        <div>
          <span className="text-[10px] font-semibold text-slate-500 block mb-2">SKIP RATE HISTORY (LAST 24 SLOTS)</span>
          <div className="h-16 flex items-end gap-[3px] bg-slate-950/65 rounded-xl border border-slate-900 p-2.5">
            {skipHistory.map((val, idx) => {
              const height = (val / 12) * 100; // max skip height simulated at 12
              return (
                <div key={idx} className="flex-1 group relative h-full flex items-end">
                  <div 
                    className={`w-full rounded-t-sm transition-all duration-300 ${val > 9.0 ? 'bg-red-500' : val > 5.0 ? 'bg-amber-500' : 'bg-purple-500/80'}`}
                    style={{ height: `${Math.max(10, height)}%` }}
                  ></div>
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 opacity-0 group-hover:opacity-100 bg-slate-900 border border-slate-700 px-2 py-0.5 rounded text-[9px] text-white pointer-events-none font-mono whitespace-nowrap z-20">
                    {val}%
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Jito leader schedule */}
        <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800 flex items-center justify-between text-xs">
          <div>
            <span className="text-[10px] font-semibold text-slate-500 block">JITO LEADER SCHEDULE</span>
            {slotsUntilLeader !== null && slotsUntilLeader >= 0 ? (
              <span className="font-bold text-slate-200 font-mono mt-0.5 block">
                {slotsUntilLeader === 0 
                  ? 'Leader Up Now!' 
                  : `Leader scheduled in ${slotsUntilLeader} slots`}
              </span>
            ) : (
              <span className="font-bold text-slate-400 font-mono mt-0.5 block">Scanning Epoch Schedule...</span>
            )}
          </div>
          <span className={`px-2.5 py-1 rounded-md border font-bold ${
            isJitoWindowActive 
              ? 'bg-purple-500/10 border-purple-500/40 text-purple-300 animate-pulse' 
              : 'bg-slate-900 border-slate-800 text-slate-500'
          }`}>
            {isJitoWindowActive ? 'SUBMIT WINDOW' : 'HOLDING'}
          </span>
        </div>
      </div>

      {/* 3.2 Tip Intelligence Widget */}
      <div className="glass-panel p-5 rounded-2xl flex flex-col gap-4">
        <div className="flex items-center gap-2 border-b border-slate-800/80 pb-3">
          <Zap className="w-4.5 h-4.5 text-amber-400" />
          <h3 className="text-sm font-bold text-white m-0">Dynamic Tip Intelligence</h3>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-semibold text-slate-500 block mb-1">LIVE JITO TIP FLOOR TIERS</span>
          
          {(['p25', 'p50', 'p75', 'p95', 'p99'] as const).map((key) => {
            const isSelected = recommendedPercentile === key;
            const price = tipFloor[key];
            return (
              <div key={key} className={`flex items-center justify-between p-2 rounded-lg border text-xs transition-all duration-200 ${
                isSelected 
                  ? 'bg-amber-500/10 border-amber-500/40 text-amber-300 shadow-[0_0_12px_-5px_rgba(245,158,11,0.5)]' 
                  : 'bg-slate-950/30 border-slate-900 text-slate-400'
              }`}>
                <div className="flex items-center gap-2 font-semibold font-mono">
                  <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-amber-400' : 'bg-slate-700'}`}></span>
                  <span>{key.toUpperCase()} Percentile</span>
                </div>
                <span className="font-bold font-mono text-slate-200">{formatNumber(price)} Lmp</span>
              </div>
            );
          })}
        </div>

        {/* AI recommended tip */}
        <div className="bg-amber-500/5 p-4 rounded-xl border border-amber-500/20 flex flex-col gap-1.5">
          <div className="flex justify-between items-center text-xs">
            <span className="text-[10px] font-semibold text-amber-500/70">AI TIP RECOMMENDATION</span>
            <span className="bg-amber-500/20 text-amber-300 text-[9px] font-bold border border-amber-500/30 px-1.5 rounded uppercase">
              {recommendedPercentile} Active
            </span>
          </div>
          <div className="flex justify-between items-end">
            <span className="text-lg font-bold font-mono text-amber-400">{formatNumber(recommendedLamports)} lamports</span>
            <span className="text-[10px] text-slate-500 font-mono">≈ {(recommendedLamports / 1_000_000_000).toFixed(6)} SOL</span>
          </div>
          <p className="text-[10px] text-slate-400 m-0">Scaled dynamic tip. Floor fetched 60s ago.</p>
        </div>
      </div>
    </div>
  );
};

const failureTypes = ['blockhash_expired', 'fee_too_low', 'bundle_dropped_leader_skip', 'compute_exceeded'];

// ==========================================
// 4. MIDDLE/RIGHT PANEL: BUNDLE FEED
// ==========================================
export const BundleFeed: React.FC = () => {
  const { bundles, selectedBundleId, setSelectedBundleId } = useSolGuardStore();
  const [faultType, setFaultType] = useState('blockhash_expired');

  const triggerFault = () => {
    simulateFailureScenario(faultType);
    
    // Cycle fault type
    const nextIdx = (failureTypes.indexOf(faultType) + 1) % failureTypes.length;
    setFaultType(failureTypes[nextIdx]!);
  };

  return (
    <div className="glass-panel p-5 rounded-2xl flex flex-col gap-4 flex-1 h-[480px]">
      <div className="flex justify-between items-center border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-4.5 h-4.5 text-purple-400" />
          <h3 className="text-sm font-bold text-white m-0">Live Bundle Pipeline</h3>
        </div>

        {/* Simulate Failure Button */}
        <button
          onClick={triggerFault}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:border-red-500/50 text-xs font-bold transition-all cursor-pointer shadow-[0_0_15px_-5px_rgba(239,68,68,0.4)]"
        >
          <ShieldAlert className="w-3.5 h-3.5 animate-bounce" />
          <span>Simulate: {faultType.replace(/_/g, ' ').toUpperCase()}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-2">
        {bundles.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-3">
            <Clock className="w-8 h-8 opacity-40 animate-pulse text-purple-400" />
            <p className="text-xs text-slate-400 font-medium">No active transactions in bundle pipeline.</p>
            <button 
              onClick={() => {
                startSimulation();
              }}
              className="text-[10px] text-purple-400 underline hover:text-purple-300"
            >
              Start simulation ticks
            </button>
          </div>
        ) : (
          bundles.map((bundle) => {
            const isSelected = selectedBundleId === bundle.bundleId;
            
            return (
              <div 
                key={bundle.bundleId}
                onClick={() => setSelectedBundleId(bundle.bundleId)}
                className={`glass-card p-4 rounded-xl cursor-pointer flex flex-col gap-2 border-l-4 ${
                  bundle.stage === 'failed' 
                    ? 'border-l-red-500' 
                    : bundle.stage === 'finalized'
                    ? 'border-l-emerald-500'
                    : bundle.stage === 'confirmed'
                    ? 'border-l-emerald-400'
                    : 'border-l-purple-500'
                } ${isSelected ? 'bg-slate-800/80 border-y-purple-500/30 border-r-purple-500/30' : ''}`}
              >
                <div className="flex justify-between items-center text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-white">#{bundle.bundleId.substring(7, 11).toUpperCase()}</span>
                    <span className="text-slate-500 font-mono">· slot {bundle.stages.submitted.slot}</span>
                  </div>
                  
                  {/* Status Badge */}
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border font-mono uppercase ${
                    bundle.stage === 'failed'
                      ? 'bg-red-500/10 border-red-500/30 text-red-400'
                      : bundle.stage === 'finalized'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : bundle.stage === 'confirmed'
                      ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400'
                      : 'bg-purple-500/10 border-purple-500/30 text-purple-400 animate-pulse'
                  }`}>
                    {bundle.stage}
                  </span>
                </div>

                <div className="flex justify-between items-center text-xs">
                  <span className="font-mono text-slate-400">{shortenSignature(bundle.signatures[0] || '')}</span>
                  <span className="font-mono font-bold text-slate-300">{formatNumber(bundle.tipLamports)} Lmp</span>
                </div>

                {/* Sub-text for failure trigger indicator */}
                {bundle.stage === 'failed' && bundle.failure && (
                  <div className="text-[10px] text-red-400 font-mono mt-1 bg-red-500/5 px-2.5 py-1 rounded border border-red-500/25 flex items-center gap-1.5">
                    <ShieldAlert className="w-3 h-3 flex-shrink-0" />
                    <span>Failed via: {bundle.failure.type.replace(/_/g, ' ')}</span>
                  </div>
                )}

                {/* Attempt count details */}
                {bundle.attempt > 1 && (
                  <div className="text-[10px] text-purple-400 font-mono mt-1 bg-purple-500/5 px-2.5 py-1 rounded border border-purple-500/25 flex items-center gap-1.5 w-fit">
                    <Zap className="w-3 h-3 flex-shrink-0" />
                    <span>Attempt #{bundle.attempt} (AI-driven resubmission)</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

// ==========================================
// 5. BOTTOM PANEL: AI DECISION LOG
// ==========================================
export const AIDecisionLog: React.FC = () => {
  const { decisions } = useSolGuardStore();

  return (
    <div className="glass-panel p-5 rounded-2xl flex flex-col gap-4 px-6 mt-4">
      <div className="flex justify-between items-center border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2">
          <Cpu className="w-4.5 h-4.5 text-purple-400" />
          <h3 className="text-sm font-bold text-white m-0">AI Agent Decision Ledger</h3>
        </div>
        <span className="text-xs text-slate-400 font-mono">Active Model: Claude 3.5 Sonnet</span>
      </div>

      <div className="overflow-x-auto">
        <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
          {decisions.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-slate-500 gap-2">
              <ShieldAlert className="w-6 h-6 opacity-40 text-purple-400 animate-pulse" />
              <p className="text-xs text-slate-400">Ledger is clean. Trigger a simulated failure to verify reasoning.</p>
            </div>
          ) : (
            decisions.map((decision, idx) => {
              const dTime = formatTime(decision.ts);
              const trigger = decision.validated_decision.root_cause;
              const action = decision.executed_action;
              const confidence = Math.round(decision.validated_decision.confidence * 100);
              
              return (
                <div 
                  key={idx} 
                  className={`border p-4 rounded-xl flex flex-col md:flex-row gap-4 justify-between border-l-4 ${
                    action === 'abort' 
                      ? 'bg-red-500/5 border-l-red-500 border-y-red-500/10 border-r-red-500/10' 
                      : action === 'hold'
                      ? 'bg-amber-500/5 border-l-amber-500 border-y-amber-500/10 border-r-amber-500/10'
                      : 'bg-blue-500/5 border-l-blue-500 border-y-blue-500/10 border-r-blue-500/10'
                  }`}
                >
                  <div className="flex-1 flex flex-col gap-2">
                    <div className="flex items-center gap-3 text-xs">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold border font-mono uppercase ${
                        action === 'abort'
                          ? 'bg-red-500/10 border-red-500/30 text-red-400'
                          : action === 'hold'
                          ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                          : 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                      }`}>
                        Action: {action}
                      </span>
                      <span className="text-slate-400 font-mono font-semibold">
                        Trigger: {trigger.replace(/_/g, ' ').toUpperCase()}
                      </span>
                      <span className="text-slate-500 font-mono">· {dTime}</span>
                    </div>

                    <p className="text-xs text-slate-200 leading-relaxed font-sans m-0">
                      {decision.validated_decision.diagnosis}
                    </p>

                    {/* Parameters summary */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] font-mono text-slate-400 mt-1.5 border-t border-slate-800/60 pt-2">
                      <span>• refresh_blockhash: {String(decision.validated_decision.params.refresh_blockhash)}</span>
                      <span>• new_tip_lamports: {formatNumber(decision.validated_decision.params.new_tip_lamports)}</span>
                      <span>• target_slot: {formatSlot(decision.validated_decision.params.submit_at_slot)}</span>
                      <span>• max_blockhash_age: {decision.validated_decision.params.max_blockhash_age_slots} slots</span>
                    </div>
                  </div>

                  {/* Confidence score + Source provenance badge */}
                  <div className="flex flex-col justify-between items-end gap-2 md:w-48 border-l border-slate-800/80 pl-4">
                    <div className="text-right">
                      <span className="text-[10px] font-semibold text-slate-500 block">AI CONFIDENCE</span>
                      <span className="text-lg font-bold font-mono text-slate-200">{confidence}%</span>
                    </div>
                    
                    <span className="text-[9px] font-mono bg-purple-500/10 border border-purple-500/30 text-purple-400 px-2 py-0.5 rounded font-bold uppercase">
                      {decision.decision_source.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

// ==========================================
// 6. SLIDE-OVER DETAIL PANEL
// ==========================================
export const BundleDetailPanel: React.FC = () => {
  const { selectedBundleId, setSelectedBundleId, bundles, decisions } = useSolGuardStore();
  const [showJsonLog, setShowJsonLog] = useState(false);

  const bundle = bundles.find((b) => b.bundleId === selectedBundleId);
  if (!bundle) return null;

  const decision = decisions.find(
    (d) => d.input_context?.bundleId === bundle.bundleId || d.input_context?.bundle?.bundleId === bundle.bundleId
  );

  return (
    <div className="fixed inset-0 overflow-hidden z-40">
      {/* Backdrop */}
      <div 
        onClick={() => setSelectedBundleId(null)}
        className="absolute inset-0 bg-slate-950/60 backdrop-blur-xs transition-opacity duration-300"
      ></div>

      {/* Panel container */}
      <div className="absolute inset-y-0 right-0 max-w-full flex pl-10">
        <div className="w-screen max-w-md bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl h-full text-slate-300">
          <div className="px-6 py-5 border-b border-slate-800/80 flex items-center justify-between">
            <h2 className="text-md font-bold text-white m-0">Bundle Detail Analysis</h2>
            <button 
              onClick={() => setSelectedBundleId(null)}
              className="text-slate-400 hover:text-slate-200 text-lg cursor-pointer"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
            {/* Header info */}
            <div className="flex flex-col gap-1 bg-slate-950/40 p-4 rounded-xl border border-slate-800">
              <span className="text-[10px] font-semibold text-slate-500">BUNDLE ID</span>
              <span className="font-mono text-sm text-slate-200 font-bold block">{bundle.bundleId}</span>
              <span className="text-[10px] font-semibold text-slate-500 mt-2">TRANSACTION SIGNATURE</span>
              <span className="font-mono text-xs text-purple-400 break-all select-all block mt-0.5">
                {bundle.signatures[0]}
              </span>
            </div>

            {/* Stage Timeline */}
            <div>
              <h4 className="text-xs font-bold text-white uppercase tracking-wider mb-3">Landed Timeline</h4>
              <div className="flex flex-col gap-4 relative border-l border-slate-800/80 pl-4 ml-1.5">
                
                {/* 1. Submitted */}
                <div className="relative">
                  <div className="absolute right-full mr-2.5 top-1.5 w-3.5 h-3.5 rounded-full bg-purple-500 border border-slate-900 flex items-center justify-center">
                    <div className="w-1.5 h-1.5 bg-white rounded-full"></div>
                  </div>
                  <div className="text-xs flex justify-between font-mono">
                    <span className="font-bold text-slate-200">Submitted</span>
                    <span className="text-slate-400">slot {bundle.stages.submitted.slot}</span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono block mt-0.5">{formatTime(bundle.stages.submitted.ts)}</span>
                </div>

                {/* 2. Processed */}
                <div className="relative">
                  <div className={`absolute right-full mr-2.5 top-1.5 w-3.5 h-3.5 rounded-full border border-slate-900 flex items-center justify-center ${
                    bundle.stages.processed ? 'bg-purple-500' : 'bg-slate-800'
                  }`}>
                    {bundle.stages.processed && <div className="w-1.5 h-1.5 bg-white rounded-full"></div>}
                  </div>
                  <div className="text-xs flex justify-between font-mono">
                    <span className={`font-bold ${bundle.stages.processed ? 'text-slate-200' : 'text-slate-500'}`}>Processed</span>
                    <span className="text-slate-400">{bundle.stages.processed ? `slot ${bundle.stages.processed.slot}` : '—'}</span>
                  </div>
                  {bundle.stages.processed ? (
                    <div className="flex justify-between items-center text-[10px] text-slate-500 font-mono mt-0.5">
                      <span>{formatTime(bundle.stages.processed.ts)}</span>
                      <span className="text-purple-400">Δ = {formatMs(bundle.deltas_ms.submitted_to_processed)}</span>
                    </div>
                  ) : (
                    <span className="text-[10px] text-slate-500 block mt-0.5">Pending execution</span>
                  )}
                </div>

                {/* 3. Confirmed */}
                <div className="relative">
                  <div className={`absolute right-full mr-2.5 top-1.5 w-3.5 h-3.5 rounded-full border border-slate-900 flex items-center justify-center ${
                    bundle.stages.confirmed ? 'bg-emerald-500' : 'bg-slate-800'
                  }`}>
                    {bundle.stages.confirmed && <div className="w-1.5 h-1.5 bg-white rounded-full"></div>}
                  </div>
                  <div className="text-xs flex justify-between font-mono">
                    <span className={`font-bold ${bundle.stages.confirmed ? 'text-slate-200' : 'text-slate-500'}`}>Confirmed</span>
                    <span className="text-slate-400">{bundle.stages.confirmed ? `slot ${bundle.stages.confirmed.slot}` : '—'}</span>
                  </div>
                  {bundle.stages.confirmed ? (
                    <div className="flex justify-between items-center text-[10px] text-slate-500 font-mono mt-0.5">
                      <span>{formatTime(bundle.stages.confirmed.ts)}</span>
                      <span className="text-emerald-400 font-bold">Δ = {formatMs(bundle.deltas_ms.processed_to_confirmed)}</span>
                    </div>
                  ) : (
                    <span className="text-[10px] text-slate-500 block mt-0.5">Awaiting supermajority vote</span>
                  )}
                </div>

                {/* 4. Finalized */}
                <div className="relative">
                  <div className={`absolute right-full mr-2.5 top-1.5 w-3.5 h-3.5 rounded-full border border-slate-900 flex items-center justify-center ${
                    bundle.stages.finalized ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-800'
                  }`}>
                    {bundle.stages.finalized && <div className="w-1.5 h-1.5 bg-white rounded-full"></div>}
                  </div>
                  <div className="text-xs flex justify-between font-mono">
                    <span className={`font-bold ${bundle.stages.finalized ? 'text-slate-200' : 'text-slate-500'}`}>Finalized</span>
                    <span className="text-slate-400">{bundle.stages.finalized ? `slot ${bundle.stages.finalized.slot}` : '—'}</span>
                  </div>
                  {bundle.stages.finalized && (
                    <div className="flex justify-between items-center text-[10px] text-slate-500 font-mono mt-0.5">
                      <span>{formatTime(bundle.stages.finalized.ts)}</span>
                      <span className="text-emerald-500">Δ = {formatMs(bundle.deltas_ms.confirmed_to_finalized)}</span>
                    </div>
                  )}
                </div>

              </div>
            </div>

            {/* Failure/AI Info */}
            {bundle.stage === 'failed' && (
              <div className="flex flex-col gap-3 border border-red-500/20 bg-red-500/5 p-4 rounded-xl">
                <div className="flex items-center gap-2 text-red-400 text-xs font-bold font-mono">
                  <ShieldAlert className="w-4.5 h-4.5" />
                  <span>FAILURE CLASSIFIED: {bundle.failure?.type.replace(/_/g, ' ').toUpperCase()}</span>
                </div>
                <div className="text-xs text-slate-300">
                  <span className="text-[10px] font-semibold text-slate-500 block uppercase mb-1">EVIDENCE LOG</span>
                  <pre className="bg-slate-950/70 p-2.5 rounded border border-slate-850 text-[10px] font-mono text-red-300 overflow-x-auto">
                    {JSON.stringify(bundle.failure?.evidence, null, 2)}
                  </pre>
                </div>
              </div>
            )}

            {/* Associated AI Decision */}
            {decision && (
              <div className="flex flex-col gap-2 bg-blue-500/5 border border-blue-500/20 p-4 rounded-xl text-xs">
                <span className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider block">AI AGENT ACTION: {decision.executed_action.toUpperCase()}</span>
                <p className="text-slate-200 m-0 leading-relaxed font-sans">{decision.validated_decision.diagnosis}</p>
                <div className="flex justify-between items-center mt-2 border-t border-slate-800/80 pt-2 font-mono text-[10px]">
                  <span className="text-slate-400">Confidence: {Math.round(decision.validated_decision.confidence * 100)}%</span>
                  <span className="text-slate-400">Source: {decision.decision_source}</span>
                </div>
              </div>
            )}

            {/* Raw JSON Toggle */}
            <div className="border-t border-slate-800/80 pt-4 flex flex-col gap-2">
              <button 
                onClick={() => setShowJsonLog(!showJsonLog)}
                className="flex items-center justify-between text-xs text-slate-400 hover:text-slate-200 w-full font-mono cursor-pointer"
              >
                <span className="flex items-center gap-1.5">
                  <FileJson className="w-3.5 h-3.5" />
                  <span>Raw Lifecycle JSON Entry</span>
                </span>
                <span>{showJsonLog ? 'Hide ▴' : 'Show ▾'}</span>
              </button>
              
              {showJsonLog && (
                <pre className="bg-slate-950 p-3 rounded-lg border border-slate-850 text-[9px] font-mono text-slate-300 overflow-x-auto leading-normal">
                  {JSON.stringify(bundle, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
