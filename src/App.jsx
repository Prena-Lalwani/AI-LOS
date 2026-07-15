import { useState, useRef, useLayoutEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, useLocation, useNavigationType } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeContext.jsx';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

// Executive is the landing page (the LCP surface) so it stays in the main
// bundle and paints immediately. Every other route is code-split into its own
// chunk, loaded only when visited — this keeps the heavy Recharts/Leaflet code
// (esp. the Dispatch map) out of the first paint.
import Executive from './pages/Executive/index.jsx';
const Demand = lazy(() => import('./pages/Demand/index.jsx'));
const Inventory = lazy(() => import('./pages/Inventory/index.jsx'));
const Dispatch = lazy(() => import('./pages/Dispatch/index.jsx'));
const Fleet = lazy(() => import('./pages/Fleet/index.jsx'));
const TruckDetail = lazy(() => import('./pages/TruckDetail/index.jsx'));
const DriverDetail = lazy(() => import('./pages/DriverDetail/index.jsx'));
const Copilot = lazy(() => import('./pages/Copilot/index.jsx'));
const Reports = lazy(() => import('./pages/Reports/index.jsx'));

// Remembers the scroll position of each history entry (keyed by location.key)
// so pressing Back returns you to exactly where you were, not the top.
const scrollCache = new Map();

function useScrollRestoration(ref) {
  const location = useLocation();
  const navType = useNavigationType();   // 'POP' (back/forward) | 'PUSH' | 'REPLACE'
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // Back/forward → restore the saved position for that history entry;
    // a brand-new navigation → start at the top.
    if (navType === 'POP') {
      const saved = scrollCache.get(location.key);
      el.scrollTop = saved != null ? saved : 0;
    } else {
      el.scrollTop = 0;
    }
    const onScroll = () => { scrollCache.set(location.key, el.scrollTop); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [location.key, navType, ref]);
}

// Routes wrapped in an error boundary (keyed by path so it resets on navigation)
// + Suspense for the lazy route chunks.
function RouteArea() {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<div className="muted" style={{ padding: '48px 4px', fontSize: 14 }}>Loading…</div>}>
        <Routes>
          <Route path="/" element={<Executive />} />
          <Route path="/demand" element={<Demand />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/dispatch" element={<Dispatch />} />
          <Route path="/fleet" element={<Fleet />} />
          <Route path="/fleet/truck/:vehicleId" element={<TruckDetail />} />
          <Route path="/fleet/driver/:driverId" element={<DriverDetail />} />
          <Route path="/copilot" element={<Copilot />} />
          <Route path="/reports" element={<Reports />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

// The app shell lives inside the Router so it can restore scroll per route.
function Shell() {
  const [navOpen, setNavOpen] = useState(false);
  const mainRef = useRef(null);
  useScrollRestoration(mainRef);

  return (
    <div className="app">
      <Sidebar mobileOpen={navOpen} onNavigate={() => setNavOpen(false)} />
      <div
        className={`nav-backdrop${navOpen ? ' show' : ''}`}
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />
      <div className="shell">
        <TopBar onMenu={() => setNavOpen((o) => !o)} />
        <main className="main" ref={mainRef}>
          <RouteArea />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </ThemeProvider>
  );
}
