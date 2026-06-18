import React from 'react';
import {
  Header,
  MetricCards,
  StreamFeedPanel,
  LeftPanel,
  BundleFeed,
  AIDecisionLog,
  BundleDetailPanel
} from '../components/DashboardComponents';

const DashboardPage: React.FC = () => {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans pb-12 selection:bg-purple-500/30">
      <Header />
      <MetricCards />
      <StreamFeedPanel />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 px-6 mt-6">
        <div className="lg:col-span-1">
          <LeftPanel />
        </div>
        <div className="lg:col-span-2">
          <BundleFeed />
        </div>
      </div>

      <AIDecisionLog />
      <BundleDetailPanel />
    </div>
  );
};

export default DashboardPage;
