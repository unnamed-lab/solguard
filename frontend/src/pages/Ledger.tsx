import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSolGuardStore } from '../store';
import { formatTime } from '../utils';
import { ArrowLeft, Cpu, Download } from 'lucide-react';


const Ledger: React.FC = () => {
  const { decisions, totalDecisions, clearDecisions } = useSolGuardStore();
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [triggerFilter, setTriggerFilter] = useState<string>('all');

  // Handle Filtering
  const filteredDecisions = decisions.filter((d) => {
    const actionMatch = actionFilter === 'all' || d.executed_action === actionFilter;
    const triggerMatch = triggerFilter === 'all' || d.validated_decision.root_cause === triggerFilter;
    return actionMatch && triggerMatch;
  });

  // Client-Side CSV Export
  const exportToCSV = () => {
    const headers = ['Timestamp', 'Slot', 'Trigger', 'Root Cause', 'Diagnosis', 'Action', 'Confidence %', 'Outcome'];
    const rows = filteredDecisions.map((d) => [
      d.ts,
      d.validated_decision.params.submit_at_slot || d.input_context?.current_slot || '',
      d.trigger,
      d.validated_decision.root_cause,
      `"${d.validated_decision.diagnosis.replace(/"/g, '""')}"`,
      d.executed_action,
      Math.round(d.validated_decision.confidence * 100),
      d.eventual_outcome
    ]);

    const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `solguard_decision_ledger_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans pb-12 selection:bg-purple-500/30">
      
      {/* Top Navbar */}
      <header className="glass-panel w-full border-b border-slate-800/80 px-6 py-4 flex justify-between items-center gap-4 z-10">
        <div className="flex items-center gap-3">
          <Link to="/" className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white hover:border-slate-700 transition">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-purple-400" />
            <h1 className="text-lg font-bold tracking-tight text-white m-0">Decision Ledger</h1>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <Link to="/dashboard" className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-slate-300 font-semibold transition">
            Console
          </Link>
          <button 
            onClick={exportToCSV}
            disabled={filteredDecisions.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:hover:bg-purple-600 text-white rounded-lg font-semibold transition cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl w-full mx-auto px-6 mt-6 flex flex-col gap-6">
        
        {/* Statistics & Filters Bar */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          
          {/* Ledger Stats Card */}
          <div className="glass-panel p-5 rounded-2xl flex flex-col justify-center border border-slate-800/80">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">TOTAL SAVED DECISIONS</span>
            <span className="text-3xl font-extrabold text-white font-mono mt-1">{totalDecisions}</span>
            <span className="text-[10px] text-slate-400 mt-1">Audit log is append-only on-disk</span>
          </div>

          {/* Action Filter Card */}
          <div className="glass-panel p-5 rounded-2xl border border-slate-800/80 flex flex-col justify-between">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2 block">FILTER BY ACTION</span>
            <div className="relative">
              <select
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 text-xs rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-purple-500/50"
              >
                <option value="all">All Actions</option>
                <option value="retry">Retry (Resubmit)</option>
                <option value="hold">Hold (Postpone)</option>
                <option value="abort">Abort (Halts)</option>
              </select>
            </div>
          </div>

          {/* Trigger Filter Card */}
          <div className="glass-panel p-5 rounded-2xl border border-slate-800/80 flex flex-col justify-between">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2 block">FILTER BY TRIGGER</span>
            <div className="relative">
              <select
                value={triggerFilter}
                onChange={(e) => setTriggerFilter(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 text-xs rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-purple-500/50"
              >
                <option value="all">All Triggers</option>
                <option value="blockhash_expired">Expired Blockhash</option>
                <option value="fee_too_low">Tip Fee Insufficient</option>
                <option value="bundle_dropped_leader_skip">Validator Skip</option>
                <option value="compute_exceeded">Compute Exceeded</option>
              </select>
            </div>
          </div>

          {/* Danger Zone / Reset Card */}
          <div className="glass-panel p-5 rounded-2xl border border-slate-800/80 flex flex-col justify-between">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2 block">AUDIT CONTROLS</span>
            <button
              onClick={() => {
                if (window.confirm('Are you sure you want to purge the live UI ledger logs?')) {
                  clearDecisions();
                }
              }}
              className="w-full py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg text-xs font-bold transition"
            >
              Clear Live View Log
            </button>
          </div>
        </div>

        {/* Ledger Table Panel */}
        <div className="glass-panel rounded-2xl border border-slate-800/80 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800/80 bg-slate-900/30 text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                  <th className="py-4 px-6 font-semibold">Timestamp</th>
                  <th className="py-4 px-6 font-semibold">Root Cause Trigger</th>
                  <th className="py-4 px-6 font-semibold">Action Mode</th>
                  <th className="py-4 px-6 font-semibold text-right">Confidence</th>
                  <th className="py-4 px-6 font-semibold">diagnosis & reasoning</th>
                  <th className="py-4 px-6 font-semibold">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-xs font-sans">
                {filteredDecisions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-16 text-center text-slate-500 font-medium">
                      No matching audit records found. Try modifying filters or triggering a simulation fault.
                    </td>
                  </tr>
                ) : (
                  filteredDecisions.map((d, index) => {
                    const action = d.executed_action;
                    return (
                      <tr key={index} className="hover:bg-slate-900/20 transition-all duration-150">
                        <td className="py-4 px-6 font-mono text-slate-400 whitespace-nowrap">
                          {formatTime(d.ts)}
                        </td>
                        <td className="py-4 px-6 font-mono font-bold text-slate-200 uppercase whitespace-nowrap">
                          {d.validated_decision.root_cause.replace(/_/g, ' ')}
                        </td>
                        <td className="py-4 px-6 whitespace-nowrap">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold border font-mono uppercase ${
                            action === 'abort'
                              ? 'bg-red-500/10 border-red-500/30 text-red-400'
                              : action === 'hold'
                              ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                              : 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                          }`}>
                            {action}
                          </span>
                        </td>
                        <td className="py-4 px-6 text-right font-mono font-bold text-slate-200">
                          {Math.round(d.validated_decision.confidence * 100)}%
                        </td>
                        <td className="py-4 px-6 text-slate-300 max-w-sm font-sans line-clamp-2 hover:line-clamp-none transition-all duration-300">
                          {d.validated_decision.diagnosis}
                        </td>
                        <td className="py-4 px-6 font-mono font-semibold text-slate-400 whitespace-nowrap">
                          {d.eventual_outcome}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

      </main>
    </div>
  );
};

export default Ledger;
