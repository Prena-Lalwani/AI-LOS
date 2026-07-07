import { useEffect, useState } from 'react';
import { API_BASE } from '../api.js';

const BASE = API_BASE;

/**
 * The app's signature element: a persistent live metrics strip with an inline
 * sparkline. The numbers are REAL — pulled once from the backend (fleet /
 * dispatch / demand) so they stay consistent with every module page rather than
 * being random placeholders. The sparkline is the last 24 weeks of actual
 * demand, with an --accent-attention dot on the lowest recent week.
 */
export default function StatusRibbon() {
  const [m, setM] = useState(null);

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
      const alerts = (fleet.maintenanceRisk?.highRiskCount || 0)
        + (fleet.anomalies?.summary?.vehiclesFlagged || 0)
        + (dispatch.delayRisk?.flags?.length || 0)
        + (dispatch.overtimeFlags?.length || 0);
      setM({
        forecastAcc: forecast ? forecast.value : null,
        activeTrucks: inService ? parseInt(inService.value, 10) : null,
        totalTrucks: fleet.vehicleUtilization?.vehicles?.length ?? null,
        alerts,
        spark: (demand.weeklyTrend || []).slice(-24).map((w) => w.actual),
      });
    }).catch(() => { /* backend down: ribbon stays quiet, doesn't break the app */ });
    return () => { alive = false; };
  }, []);

  // sparkline geometry (guard until real data arrives)
  const spark = m?.spark && m.spark.length > 1 ? m.spark : null;
  const W = 132, H = 30;
  let points = '', ax = 0, ay = 0;
  if (spark) {
    const n = spark.length;
    const mn = Math.min(...spark);
    const mx = Math.max(...spark);
    const span = mx - mn || 1;
    const sx = (i) => 2 + (i * (W - 4)) / (n - 1);
    const sy = (v) => H - 3 - ((v - mn) / span) * (H - 6);
    points = spark.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
    let ai = n - 1, lo = Infinity;
    for (let i = Math.max(0, n - 10); i < n; i++) {
      if (spark[i] < lo) { lo = spark[i]; ai = i; }
    }
    ax = sx(ai); ay = sy(spark[ai]);
  }

  const dash = '—';

  return (
    <>
      <div className="ribbon__live">
        <span className="ribbon__live-dot" />
        <span className="ribbon__live-label">LIVE</span>
      </div>
      <div className="ribbon__divider" />
      <div className="ribbon__metrics">
        <div className="ribbon__metric">
          <span className="ribbon__metric-label">Forecast Acc</span>
          <span className="ribbon__metric-value s-flow">{m?.forecastAcc != null ? `${m.forecastAcc}%` : dash}</span>
        </div>
        <div className="ribbon__metric">
          <span className="ribbon__metric-label">Active Trucks</span>
          <span className="ribbon__metric-value">
            {m?.activeTrucks != null ? `${m.activeTrucks}${m.totalTrucks ? `/${m.totalTrucks}` : ''}` : dash}
          </span>
        </div>
        <div className="ribbon__metric">
          <span className="ribbon__metric-label">Open Alerts</span>
          <span className={`ribbon__metric-value ${m?.alerts ? 's-attention' : 's-flow'}`}>
            {m?.alerts != null ? m.alerts : dash}
          </span>
        </div>
      </div>
      <div className="ribbon__spark">
        <span className="ribbon__spark-label">DEMAND · 24W</span>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
          {spark && (
            <>
              <polyline points={points} fill="none" stroke="var(--accent-flow)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={ax} cy={ay} r="3" fill="var(--accent-attention)" />
            </>
          )}
        </svg>
      </div>
    </>
  );
}
