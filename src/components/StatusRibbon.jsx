import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../api.js';

const BASE = API_BASE;
const TICKER_MS = 4500;   // how long each live headline stays up

/**
 * The app's signature element: a persistent live-metrics strip. The numbers are
 * REAL — pulled once from the backend (fleet / dispatch / demand) so they stay
 * consistent with every module page. Each metric is clickable and jumps to its
 * module. The right-hand OPERATIONS ticker rotates through real, specific events
 * of the day (today's plan, top breakdown risk, demand movement) so the header
 * reads as a live feed rather than a static badge row.
 */
export default function StatusRibbon() {
  const navigate = useNavigate();
  const [m, setM] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(`${BASE}/api/fleet/dashboard`).then((r) => r.json()),
      fetch(`${BASE}/api/dispatch/plan`).then((r) => r.json()),
      fetch(`${BASE}/api/demand/forecast`).then((r) => r.json()),
    ]).then(([fleet, dispatch, demand]) => {
      if (!alive) return;
      const inService = fleet.kpis.find((k) => k.label === 'Units In Service');
      const forecast = demand.kpis.find((k) => k.label === 'Forecast Accuracy');
      const avgWeek = demand.kpis.find((k) => k.label === 'Avg Weekly Demand');
      const alerts = (fleet.maintenanceRisk?.highRiskCount || 0)
        + (fleet.anomalies?.summary?.vehiclesFlagged || 0)
        + (dispatch.delayRisk?.flags?.length || 0)
        + (dispatch.overtimeFlags?.length || 0);

      // --- build the rotating operations feed from real fields ---------------
      const feed = [];
      if (dispatch?.warehouseName) {
        feed.push({
          to: '/dispatch', state: 'flow',
          text: `${dispatch.warehouseName} · ${dispatch.ordersToday} orders · ${dispatch.routes.length} routes · ${dispatch.totalDistanceKm} km planned`,
        });
      }
      if (dispatch?.loadBalancing) {
        const flags = (dispatch.overtimeFlags?.length || 0) + (dispatch.delayRisk?.flags?.length || 0);
        feed.push({
          to: '/dispatch', state: flags ? 'attention' : 'flow',
          text: `Fleet load ${dispatch.loadBalancing.avgUtilizationPct}% avg · ${dispatch.overtimeFlags?.length || 0} overtime · ${dispatch.delayRisk?.flags?.length || 0} reroute flags`,
        });
      }
      const topRisk = fleet?.maintenanceRisk?.vehicles?.[0];
      if (topRisk) {
        feed.push({
          to: '/fleet', state: topRisk.riskPct >= 50 ? 'critical' : 'attention',
          text: `${topRisk.vehicleId} — ${topRisk.riskPct}% breakdown risk · service ${topRisk.riskLevel === 'High' ? 'due now' : 'recommended'}`,
        });
      }
      if (fleet?.maintenanceRisk) {
        feed.push({
          to: '/fleet', state: 'attention',
          text: `${fleet.maintenanceRisk.highRiskCount} high-risk vehicles · ${fleet.anomalies?.summary?.vehiclesFlagged || 0} anomalies flagged this week`,
        });
      }
      if (avgWeek) {
        const up = avgWeek.delta > 0;
        feed.push({
          to: '/demand', state: 'flow',
          text: `Demand ${up ? '▲' : '▼'} ${Math.abs(avgWeek.delta)}% WoW · ${Number(avgWeek.value).toLocaleString()} units/wk · forecast ${forecast?.value ?? '—'}% accurate`,
        });
      }

      setM({
        forecastAcc: forecast ? forecast.value : null,
        forecastDelta: forecast ? forecast.delta : null,
        activeTrucks: inService ? parseInt(inService.value, 10) : null,
        totalTrucks: fleet.vehicleUtilization?.vehicles?.length ?? null,
        alerts,
        spark: (demand.weeklyTrend || []).slice(-24).map((w) => w.actual),
        feed,
      });
    }).catch(() => { /* backend down: ribbon stays quiet, doesn't break the app */ });
    return () => { alive = false; };
  }, []);

  // rotate the operations feed
  const feed = m?.feed?.length ? m.feed : null;
  useEffect(() => {
    if (!feed || feed.length < 2) return undefined;
    const t = setInterval(() => setTick((i) => (i + 1) % feed.length), TICKER_MS);
    return () => clearInterval(t);
  }, [feed]);

  // sparkline geometry (guard until real data arrives)
  const spark = m?.spark && m.spark.length > 1 ? m.spark : null;
  const W = 96, H = 26;
  let points = '', ax = 0, ay = 0;
  if (spark) {
    const n = spark.length;
    const mn = Math.min(...spark);
    const mx = Math.max(...spark);
    const span = mx - mn || 1;
    const sx = (i) => 2 + (i * (W - 4)) / (n - 1);
    const sy = (v) => H - 3 - ((v - mn) / span) * (H - 6);
    points = spark.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
    ax = sx(n - 1); ay = sy(spark[n - 1]);
  }

  const dash = '—';
  const current = feed ? feed[tick % feed.length] : null;

  return (
    <>
      <div className="ribbon__live">
        <span className="ribbon__live-dot" />
        <span className="ribbon__live-label">LIVE</span>
      </div>
      <div className="ribbon__divider" />
      <div className="ribbon__metrics">
        <button type="button" className="ribbon__metric ribbon__metric--link" onClick={() => navigate('/demand')} title="Open Demand Intelligence">
          <span className="ribbon__metric-label">Forecast</span>
          <span className="ribbon__metric-value s-flow">{m?.forecastAcc != null ? `${m.forecastAcc}%` : dash}</span>
          {m?.forecastDelta != null && m.forecastDelta !== 0 && (
            <span className={`ribbon__trend ${m.forecastDelta > 0 ? 's-flow' : 's-attention'}`}>
              {m.forecastDelta > 0 ? '▲' : '▼'}{Math.abs(m.forecastDelta)}
            </span>
          )}
        </button>
        <button type="button" className="ribbon__metric ribbon__metric--link" onClick={() => navigate('/fleet')} title="Open Fleet Intelligence">
          <span className="ribbon__metric-label">Trucks</span>
          <span className="ribbon__metric-value">
            {m?.activeTrucks != null ? `${m.activeTrucks}${m.totalTrucks ? `/${m.totalTrucks}` : ''}` : dash}
          </span>
        </button>
        <button type="button" className="ribbon__metric ribbon__metric--link" onClick={() => navigate('/fleet')} title="Open alerts in Fleet Intelligence">
          <span className="ribbon__metric-label">Alerts</span>
          <span className={`ribbon__metric-value ${m?.alerts ? 's-attention' : 's-flow'}`}>
            {m?.alerts != null ? m.alerts : dash}
          </span>
        </button>
      </div>

      {/* rotating live operations feed — fills the dead space with real, changing info */}
      {current && (
        <button
          type="button"
          className="ribbon__ticker"
          onClick={() => current.to && navigate(current.to)}
          title="Latest operations — click to open"
        >
          <span className={`dot s-${current.state}`} />
          <span key={tick} className="ribbon__ticker-text">{current.text}</span>
        </button>
      )}

      <div className="ribbon__spark" title="Weekly demand · last 24 weeks">
        <span className="ribbon__spark-label">DEMAND · 24W</span>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
          {spark && (
            <>
              <polyline points={points} fill="none" stroke="var(--accent-flow)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={ax} cy={ay} r="2.6" fill="var(--accent-flow)" />
            </>
          )}
        </svg>
      </div>
    </>
  );
}
