import { useEffect, useState } from 'react';
import PageHeader from '../../components/PageHeader.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import DataTable, { StatusCell } from '../../components/DataTable.jsx';
import TrendChart from '../../components/TrendChart.jsx';
import { API_BASE } from '../../api.js';

// Live data source: the FastAPI backend (see backend/models/fleet_intelligence.py).
// Predictive maintenance is a real XGBoost classifier (breakdown within 10 days),
// anomalies come from an unsupervised IsolationForest, and utilization / driver
// performance / fuel analytics are computed from the synthetic telemetry + trips.
const API_URL = `${API_BASE}/api/fleet/dashboard`;

const riskState = (pct) => (pct >= 50 ? 'critical' : pct >= 20 ? 'attention' : 'flow');
const fmtDate = (s) => new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export default function Fleet() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // vehicleId -> booked maintenance window (client-side; there is no persistence
  // backend yet, so "Schedule" books the suggested window for this session).
  const [scheduled, setScheduled] = useState({});

  const toggleSchedule = (r) => setScheduled((s) => {
    const next = { ...s };
    if (next[r.vehicleId]) delete next[r.vehicleId];
    else next[r.vehicleId] = r.suggestedWindow;
    return next;
  });

  useEffect(() => {
    let alive = true;
    fetch(API_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  const header = (
    <PageHeader
      title="Fleet Intelligence"
      subtitle={
        data
          ? `${data.meta.telemetryRows.toLocaleString()} telemetry rows · ${data.maintenanceRisk.vehicles.length} vehicles · predictive maintenance active`
          : 'Predictive maintenance · anomaly detection · utilization · driver & fuel analytics'
      }
    />
  );

  if (error) {
    return (
      <>
        {header}
        <div className="card" style={{ maxWidth: 640 }}>
          <h2 style={{ marginBottom: 8 }}>Fleet API unavailable</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            Could not reach the fleet service at <span className="mono">{API_URL}</span> ({error}).
            Start it with <span className="mono">cd backend &amp;&amp; uvicorn main:app --port 8000</span>.
          </p>
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        {header}
        <div className="muted" style={{ padding: '48px 4px', fontSize: 14 }}>Training breakdown model…</div>
      </>
    );
  }

  const { maintenanceRisk, anomalies, vehicleUtilization, driverPerformance, fuelAnalytics, maintenanceSchedule } = data;
  const m = maintenanceRisk.modelMetrics;
  const anomByVeh = Object.fromEntries(anomalies.vehicles.map((a) => [a.vehicleId, a]));

  // ---- Predictive maintenance: top vehicles by breakdown risk --------------
  const riskRows = maintenanceRisk.vehicles.slice(0, 8);
  const riskCols = [
    { header: 'Vehicle', cell: (r) => <span className="mono muted">{r.vehicleId}</span> },
    { header: 'Breakdown Risk', cell: (r) => <StatusCell state={riskState(r.riskPct)} label={`${r.riskPct}%`} /> },
    { header: 'Brake Wear', cell: (r) => <span className={`mono s-${r.brakePadWearPct >= 80 ? 'attention' : 'flow'}`}>{r.brakePadWearPct}%</span> },
    { header: 'Oil Δ7d', cell: (r) => <span className={`mono s-${r.oilPressureTrend7 <= -3 ? 'attention' : 'flow'}`}>{r.oilPressureTrend7 > 0 ? '+' : ''}{r.oilPressureTrend7}</span> },
    { header: 'Temp Δ7d', cell: (r) => <span className={`mono s-${r.engineTempTrend7 >= 3 ? 'attention' : 'flow'}`}>{r.engineTempTrend7 > 0 ? '+' : ''}{r.engineTempTrend7}°</span> },
  ];

  // ---- Maintenance schedule (prioritized) ----------------------------------
  const schedRows = maintenanceSchedule.filter((s) => s.priority !== 'Routine').slice(0, 8);
  const schedCols = [
    { header: 'Vehicle', cell: (r) => <span className="mono muted">{r.vehicleId}</span> },
    { header: 'Priority', cell: (r) => <StatusCell state={r.state} label={r.priority} /> },
    { header: 'Reason', cell: (r) => <span style={{ fontSize: 12 }}>{r.reason}</span> },
    { header: 'Window', cell: (r) => <span className="mono">{r.suggestedWindow}</span> },
    { header: '', cell: (r) => {
      const booked = scheduled[r.vehicleId];
      return (
        <button
          className="btn btn--sm"
          onClick={() => toggleSchedule(r)}
          title={booked ? `Booked for ${booked} — click to cancel` : `Book the ${r.suggestedWindow} service window`}
          style={booked ? { color: 'var(--accent-flow)', borderColor: 'var(--accent-flow)' } : undefined}
        >
          {booked ? '✓ Booked' : 'Schedule'}
        </button>
      );
    } },
  ];
  const bookedCount = schedRows.filter((r) => scheduled[r.vehicleId]).length;

  // ---- Driver performance: best 3 + worst 3 --------------------------------
  const dp = driverPerformance;
  const driverRows = [...dp.drivers.slice(0, 3), ...dp.drivers.slice(-3)];
  const driverCols = [
    { header: '#', cell: (r) => <span className="mono muted">{r.rank}</span> },
    { header: 'Driver', cell: (r) => r.name },
    { header: 'Safety', cell: (r) => <span className={`mono s-${r.state}`}>{r.safetyScore}</span> },
    { header: 'km/L', cell: (r) => <span className="mono">{r.fuelEfficiencyKmL}</span> },
    { header: 'Harsh/100km', cell: (r) => <span className={`mono s-${r.worseThanFleet ? 'attention' : 'flow'}`}>{r.harshPer100km}</span> },
    { header: 'Trips', cell: (r) => <span className="mono">{r.trips}</span> },
  ];

  // ---- Fuel efficiency weekly series ---------------------------------------
  const kmL = fuelAnalytics.fuelWeeks.map((w) => w.kmL);
  const yMin = Math.floor(Math.min(...kmL) * 10) / 10 - 0.2;
  const yMax = Math.ceil(Math.max(...kmL) * 10) / 10 + 0.2;
  const lastKmL = kmL[kmL.length - 1];
  const trendUp = kmL.length > 1 && lastKmL >= kmL[0];

  return (
    <>
      {header}

      <div className="kpi-grid">
        {data.kpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </div>

      <div className="split">
        <div className="col">
          {/* Predictive maintenance — real XGBoost classifier */}
          <div className="card">
            <div className="card__head">
              <span className="ai-chip">AI</span>
              <h2>Predictive Maintenance</h2>
            </div>
            <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
              Predicted risk of a breakdown within the next {m.labelHorizonDays} days, per vehicle.
            </p>
            <DataTable columns={riskCols} rows={riskRows} keyField="vehicleId" template=".9fr 1.3fr .9fr .8fr .8fr" />
            <div className="mono" style={{ fontSize: 12, marginTop: 8 }}>
              <span className="s-critical">{maintenanceRisk.highRiskCount} high-risk</span> ·
              <span className="s-attention"> {maintenanceRisk.mediumRiskCount} medium</span> · {maintenanceRisk.vehicles.length} vehicles scored
            </div>
          </div>

          {/* Maintenance scheduling — combines risk + anomalies */}
          <div className="card">
            <div className="card__head">
              <span className="ai-chip">AI</span>
              <h2>Maintenance Schedule</h2>
            </div>
            <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
              Prioritized by breakdown risk + recent anomalies; window = next low-utilization day
            </p>
            <DataTable columns={schedCols} rows={schedRows} keyField="vehicleId" template=".8fr 1fr 2.2fr 1fr .9fr" />
            <div className="mono" style={{ fontSize: 12, marginTop: 8 }}>
              {bookedCount > 0
                ? <span className="s-flow">✓ {bookedCount} service window{bookedCount > 1 ? 's' : ''} booked this session</span>
                : <span className="muted">{schedRows.length} vehicles need service — click Schedule to book the suggested window</span>}
            </div>
          </div>

          {/* Driver performance */}
          <div className="card">
            <div className="card__head">
              <h2 style={{ margin: 0 }}>Driver Performance</h2>
            </div>
            <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
              Top 3 &amp; bottom 3 of {dp.summary.drivers} · fleet avg {dp.summary.fleetAvgFuelEff} km/L ·
              {' '}{dp.summary.flaggedCount} flagged worse than fleet (z-score)
            </p>
            <DataTable columns={driverCols} rows={driverRows} keyField="driverId" template=".4fr 1.5fr .8fr .8fr 1.1fr .7fr" />
          </div>
        </div>

        <div className="col">
          {/* Anomaly detection — IsolationForest */}
          <div className="card">
            <div className="card__head">
              <span className="ai-chip">AI</span>
              <h2>Anomaly Detection</h2>
            </div>
            <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
              {anomalies.summary.vehiclesFlagged} vehicles showing unusual sensor readings in the last {anomalies.summary.windowDays} days
              {' '}({anomalies.summary.anomalousDaysRecent} vehicle-days)
            </p>
            {anomalies.vehicles.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>No anomalies in recent data.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {anomalies.vehicles.map((a) => {
                  const accent = a.state === 'critical' ? 'var(--critical)' : 'var(--accent-attention)';
                  const tint = a.state === 'critical' ? 'var(--critical-bg)' : 'var(--accent-attention-bg)';
                  return (
                    <div
                      key={a.vehicleId}
                      style={{
                        borderRadius: 6, background: tint,
                        borderLeft: `3px solid ${accent}`, padding: '9px 11px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`dot s-${a.state}`} />
                        <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{a.vehicleId}</span>
                        <span className={`mono s-${a.state}`} style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600 }}>
                          {a.anomalousDays} unusual days
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 11.5 }}>
                        <span className="muted">engine</span>
                        <span className="mono">{a.engineTempMaxC}°C</span>
                        <span className="muted">·</span>
                        <span className="muted">oil</span>
                        <span className="mono">{a.oilPressurePsi} psi</span>
                        <span className="mono muted" style={{ marginLeft: 'auto' }}>worst {fmtDate(a.worstDate)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Fuel efficiency trend */}
          <div className="card">
            <h2 style={{ marginBottom: 2 }}>Fuel Efficiency</h2>
            <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>Fleet avg km/L · last {fuelAnalytics.fuelWeeks.length} weeks</p>
            <TrendChart
              data={fuelAnalytics.fuelWeeks}
              xKey="label"
              height={150}
              yDomain={[yMin, yMax]}
              yFormatter={(v) => v.toFixed(1)}
              series={[{ key: 'kmL', type: 'bar', color: 'var(--accent-flow)', barSize: 20 }]}
            />
            <div className="summary-stats" style={{ marginTop: 10 }}>
              <div className={`stat stat--${trendUp ? 'flow' : 'attention'}`}>
                <div className="stat__label">Latest week</div>
                <div className="stat__value">{lastKmL} <span className="muted" style={{ fontSize: 12 }}>km/L</span></div>
                <div className={`mono s-${trendUp ? 'flow' : 'attention'}`} style={{ fontSize: 11, marginTop: 2 }}>
                  {trendUp ? '▲ trending up' : '▼ trending down'} vs W1
                </div>
              </div>
              <div className="stat stat--flow">
                <div className="stat__label">Fleet average</div>
                <div className="stat__value">{fuelAnalytics.fleetAvgKmL} <span className="muted" style={{ fontSize: 12 }}>km/L</span></div>
              </div>
            </div>
            {fuelAnalytics.degradingVehicles.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                  Efficiency degrading &gt;{fuelAnalytics.degradeThresholdPct}% vs baseline (last {fuelAnalytics.recentWindowDays}d)
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {fuelAnalytics.degradingVehicles.map((id) => (
                    <span
                      key={id}
                      className="mono s-attention"
                      style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: 'var(--accent-attention-bg)' }}
                    >
                      {id}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Vehicle utilization */}
          <div className="card">
            <h2 style={{ marginBottom: 2 }}>Vehicle Utilization</h2>
            <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
              Days active over {vehicleUtilization.summary.totalDays}d ·
              {' '}{vehicleUtilization.summary.underusedCount} underused (bottom 20%)
            </p>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {vehicleUtilization.vehicles.slice(0, 6).map((v, i) => (
                <div
                  key={v.vehicleId}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 6, padding: '9px 0',
                    borderTop: i === 0 ? 'none' : '0.5px solid var(--border)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={`dot s-${v.state}`} />
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{v.vehicleId}</span>
                    {v.underused && (
                      <span className="mono s-attention" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.4px' }}>UNDERUSED</span>
                    )}
                    <span className="mono muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
                      {v.totalDistanceKm.toLocaleString()} km · {v.trips} trips
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="bar">
                      <span className={`bar__fill s-${v.state === 'attention' ? 'attention' : 'flow'}`} style={{ width: `${v.activePct}%` }} />
                    </span>
                    <span className={`mono s-${v.state}`} style={{ fontSize: 12, width: 40, textAlign: 'right' }}>{v.activePct}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
