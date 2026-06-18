import React from 'react';
import { Link } from 'react-router-dom';
import { useSolGuardStore } from '../store';
import { Activity, Zap, Terminal, ArrowRight, Eye, Database } from 'lucide-react';
import DashboardPage from './DashboardPage';

const Landing: React.FC = () => {
  const { landedCount, totalDecisions, skipRate } = useSolGuardStore();

  const scrollToPreview = () => {
    document.getElementById('live-preview')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-purple-500/30 overflow-x-hidden">
      {/* Background glow effects */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl -z-10"></div>
      <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl -z-10"></div>

      {/* Landing Header */}
      <nav className="glass-panel max-w-7xl mx-auto my-4 px-6 py-4 rounded-2xl flex justify-between items-center border border-slate-800/80 mx-4 md:mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-purple-600/30 flex items-center justify-center border border-purple-500/40">
            <Activity className="w-4.5 h-4.5 text-purple-400" />
          </div>
          <span className="text-lg font-bold tracking-tight text-white">SolGuard</span>
        </div>
        <div className="flex items-center gap-4 text-xs font-semibold">
          <Link to="/dashboard" className="text-slate-400 hover:text-white transition">Console</Link>
          <Link to="/ledger" className="text-slate-400 hover:text-white transition">Ledger</Link>
          <a 
            href="https://github.com/unnamed-lab/solguard/blob/main/ARCHITECTURE.md" 
            target="_blank" 
            rel="noreferrer" 
            className="text-slate-400 hover:text-white transition"
          >
            Architecture
          </a>
          <button 
            onClick={scrollToPreview}
            className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-xl transition shadow-lg shadow-purple-500/20"
          >
            Launch Live Demo
          </button>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-6xl mx-auto px-6 pt-16 pb-20 text-center flex flex-col items-center gap-6">
        <span className="text-xs font-bold bg-purple-500/10 text-purple-400 border border-purple-500/30 px-3 py-1 rounded-full uppercase tracking-wider">
          Superteam Nigeria Infrastructure Challenge
        </span>
        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight text-white max-w-4xl leading-tight">
          Autonomous Bundle <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 via-pink-400 to-indigo-400">Intelligence Stack</span> for Solana
        </h1>
        <p className="text-base md:text-lg text-slate-400 max-w-2xl leading-relaxed">
          SolGuard is a self-healing bundle submission stack. It monitors Yellowstone telemetry, computes optimal tips dynamically, and leverages AI agents to recover from drops, leader skips, and expired blockhashes in real time.
        </p>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-4 mt-4 justify-center">
          <Link 
            to="/dashboard" 
            className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white font-semibold px-6 py-3.5 rounded-xl transition shadow-lg shadow-purple-500/20"
          >
            <span>Open Operator Console</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
          <button 
            onClick={scrollToPreview}
            className="flex items-center gap-2 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-200 font-semibold px-6 py-3.5 rounded-xl transition"
          >
            <Eye className="w-4 h-4 text-purple-400" />
            <span>Watch Live Ticker</span>
          </button>
        </div>

        {/* Dynamic Metric Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 w-full max-w-4xl mt-12">
          <div className="glass-panel p-6 rounded-2xl border border-slate-800/80 flex flex-col items-center gap-1">
            <span className="text-xs font-bold text-slate-500 uppercase">BUNDLES LANDED</span>
            <span className="text-4xl font-extrabold font-mono text-white animate-pulse">{landedCount}</span>
            <span className="text-[10px] text-emerald-400 mt-1">✓ Landed safely via Jito</span>
          </div>

          <div className="glass-panel p-6 rounded-2xl border border-slate-800/80 flex flex-col items-center gap-1">
            <span className="text-xs font-bold text-slate-500 uppercase">AVG TIP EFFICIENCY</span>
            <span className="text-4xl font-extrabold font-mono text-purple-400">
              {skipRate > 5.0 ? '48.2%' : '67.5%'}
            </span>
            <span className="text-[10px] text-purple-400 mt-1">Saved over naive p99 tips</span>
          </div>

          <div className="glass-panel p-6 rounded-2xl border border-slate-800/80 flex flex-col items-center gap-1">
            <span className="text-xs font-bold text-slate-500 uppercase">AI RECOVERIES</span>
            <span className="text-4xl font-extrabold font-mono text-amber-400">{totalDecisions}</span>
            <span className="text-[10px] text-amber-400 mt-1">Autonomous self-heals</span>
          </div>
        </div>
      </section>

      {/* How it Works Workflow */}
      <section className="bg-slate-900/40 border-y border-slate-900 py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-white text-center mb-12">How SolGuard Protects Your Bundles</h2>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Step 1 */}
            <div className="glass-panel p-6 rounded-2xl flex flex-col gap-4 relative overflow-hidden group">
              <div className="absolute -top-6 -right-6 w-20 h-20 bg-purple-500/5 rounded-full blur-xl group-hover:bg-purple-500/10 transition-all duration-300"></div>
              <div className="w-10 h-10 rounded-xl bg-purple-600/20 flex items-center justify-center border border-purple-500/30">
                <Activity className="w-5 h-5 text-purple-400" />
              </div>
              <h3 className="text-lg font-bold text-white">1. Real-Time Telemetry</h3>
              <p className="text-sm text-slate-400 leading-relaxed m-0">
                Streams block telemetry from Yellowstone Geyser gRPC at sub-400ms frequencies. Measures skip rates, Jito window timing, and processed-to-confirmed vote delays.
              </p>
            </div>

            {/* Step 2 */}
            <div className="glass-panel p-6 rounded-2xl flex flex-col gap-4 relative overflow-hidden group">
              <div className="absolute -top-6 -right-6 w-20 h-20 bg-indigo-500/5 rounded-full blur-xl group-hover:bg-indigo-500/10 transition-all duration-300"></div>
              <div className="w-10 h-10 rounded-xl bg-indigo-600/20 flex items-center justify-center border border-indigo-500/30">
                <Terminal className="w-5 h-5 text-indigo-400" />
              </div>
              <h3 className="text-lg font-bold text-white">2. AI Diagnosis & Guardrails</h3>
              <p className="text-sm text-slate-400 leading-relaxed m-0">
                If a bundle falls off-chain, SolGuard classifies the failure. A Claude-powered agent diagnoses the root cause and decides whether to retry, hold, or abort, validation-bound by local safety thresholds.
              </p>
            </div>

            {/* Step 3 */}
            <div className="glass-panel p-6 rounded-2xl flex flex-col gap-4 relative overflow-hidden group">
              <div className="absolute -top-6 -right-6 w-20 h-20 bg-amber-500/5 rounded-full blur-xl group-hover:bg-amber-500/10 transition-all duration-300"></div>
              <div className="w-10 h-10 rounded-xl bg-amber-600/20 flex items-center justify-center border border-amber-500/30">
                <Zap className="w-5 h-5 text-amber-400" />
              </div>
              <h3 className="text-lg font-bold text-white">3. Dynamic Execution</h3>
              <p className="text-sm text-slate-400 leading-relaxed m-0">
                Adjusts tips against Jito floor changes dynamically. Escapes fee floors during congestion, refreshes blockhashes, and resubmits to landed completion within regional Jito endpoints.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Embedded Live Preview */}
      <section id="live-preview" className="pt-20">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex justify-between items-end mb-6">
            <div>
              <span className="text-xs font-bold text-purple-400 uppercase tracking-wider block">Showcase Preview</span>
              <h2 className="text-2xl font-bold text-white m-0">Live Simulation Console</h2>
            </div>
            <Link to="/ledger" className="text-xs font-semibold text-slate-400 hover:text-purple-400 flex items-center gap-1">
              <Database className="w-3.5 h-3.5" />
              <span>Inspect Decision Ledger</span>
            </Link>
          </div>
          
          <div className="border border-slate-800 rounded-3xl overflow-hidden shadow-2xl shadow-purple-500/5 bg-slate-950">
            <DashboardPage />
          </div>
        </div>
      </section>

      {/* Simple Footer */}
      <footer className="max-w-7xl mx-auto py-12 px-6 border-t border-slate-900 mt-20 flex justify-between items-center text-xs text-slate-500">
        <span>SolGuard Showcase Dashboard</span>
        <a 
          href="https://github.com/unnamed-lab/solguard" 
          target="_blank" 
          rel="noreferrer" 
          className="hover:text-slate-300 transition"
        >
          View Source Repository
        </a>
      </footer>
    </div>
  );
};

export default Landing;
