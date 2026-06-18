import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Landing from './pages/Landing';
import DashboardPage from './pages/DashboardPage';
import Ledger from './pages/Ledger';
import { startSimulation, stopSimulation } from './services';
import { useSolGuardStore } from './store';

function App() {
  const isLiveMode = useSolGuardStore((state) => state.isLiveMode);

  useEffect(() => {
    // Start simulation automatically in Demo Mode
    if (!isLiveMode) {
      startSimulation();
    }
    return () => {
      stopSimulation();
    };
  }, [isLiveMode]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/ledger" element={<Ledger />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
