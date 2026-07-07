import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeContext.jsx';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';

import Executive from './pages/Executive/index.jsx';
import Demand from './pages/Demand/index.jsx';
import Inventory from './pages/Inventory/index.jsx';
import Dispatch from './pages/Dispatch/index.jsx';
import Fleet from './pages/Fleet/index.jsx';
import Copilot from './pages/Copilot/index.jsx';
import Reports from './pages/Reports/index.jsx';

export default function App() {
  // Off-canvas nav state — only used at mobile widths (see .sidebar drawer in global.css).
  const [navOpen, setNavOpen] = useState(false);

  return (
    <ThemeProvider>
      <BrowserRouter>
        <div className="app">
          <Sidebar mobileOpen={navOpen} onNavigate={() => setNavOpen(false)} />
          <div
            className={`nav-backdrop${navOpen ? ' show' : ''}`}
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <div className="shell">
            <TopBar onMenu={() => setNavOpen((o) => !o)} />
            <main className="main">
              <Routes>
                <Route path="/" element={<Executive />} />
                <Route path="/demand" element={<Demand />} />
                <Route path="/inventory" element={<Inventory />} />
                <Route path="/dispatch" element={<Dispatch />} />
                <Route path="/fleet" element={<Fleet />} />
                <Route path="/copilot" element={<Copilot />} />
                <Route path="/reports" element={<Reports />} />
              </Routes>
            </main>
          </div>
        </div>
      </BrowserRouter>
    </ThemeProvider>
  );
}
