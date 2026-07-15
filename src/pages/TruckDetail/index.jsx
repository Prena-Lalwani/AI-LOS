import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import PageHeader from '../../components/PageHeader.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import { Metric, MetricGrid } from '../../components/Metric.jsx';
import { API_BASE } from '../../api.js';

// Complete per-vehicle profile: pulls the Fleet dashboard (maintenance risk,
// telemetry, anomalies, utilization, fuel) and the Dispatch plan (today's route)
// and filters both down to one truck.
const riskState = (pct) => (pct >= 50 ? 'critical' : pct >= 20 ? 'attention' : 'flow');

export default function TruckDetail() {
  const { vehicleId } = useParams();
  const [fleet, setFleet] = useState(null);
  const [dispatch, setDispatch] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setFleet(null);
    setError(null);
    Promise.all([
      fetch(`${API_BASE}/api/fleet/dashboard`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      fetch(`${API_BASE}/api/dispatch/plan`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([f, d]) => { if (!alive) return; setFleet(f); setDispatch(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [vehicleId]);

  const header = (
    <>
      <Link to="/fleet" className="link-id" style={{ fontSize: 12, display: 'inline-block', marginBottom: 8 }}>← Fleet Intelligence</Link>
      <PageHeader title={`Truck ${vehicleId}`} subtitle="Complete vehicle profile — breakdown risk, telemetry, utilization, fuel & today's route" />
    </>
  );

  if (error) {
    return (
      <>{header}
        <div className="card" style={{ maxWidth: 640, borderLeft: '3px solid var(--accent-attention)' }}>
          <h2 style={{ marginBottom: 8 }}>Vehicle data is temporarily unavailable</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            We couldn&rsquo;t load fleet data just now. Try refreshing in a moment.
          </p>
          <p className="muted" style={{ margin: '10px 0 0', fontSize: 11, opacity: 0.7 }}><span className="mono">{error}</span></p>
        </div>
      </>
    );
  }
  if (!fleet) return (<>{header}<div className="muted" style={{ padding: '48px 4px', fontSize: 14 }}>Loading vehicle profile…</div></>);

  const risk = fleet.maintenanceRisk.vehicles.find((v) => v.vehicleId === vehicleId);
  const anom = fleet.anomalies.vehicles.find((v) => v.vehicleId === vehicleId);
  const util = fleet.vehicleUtilization.vehicles.find((v) => v.vehicleId === vehicleId);
  const fuel = fleet.fuelAnalytics.perVehicle.find((v) => v.vehicleId === vehicleId);
  const sched = fleet.maintenanceSchedule.find((v) => v.vehicleId === vehicleId);
  const route = dispatch?.routes?.find((r) => r.vehicleId === vehicleId);

  if (!risk && !util) {
    return (<>{header}<div className="card"><p style={{ margin: 0 }}>No data found for truck <span className="mono">{vehicleId}</span>. <Link className="link-id" to="/fleet">Back to Fleet</Link></p></div></>);
  }

  const kpis = [
    risk && { label: 'Breakdown Risk', value: `${risk.riskPct}%`, delta: `${risk.riskLevel} risk`, state: riskState(risk.riskPct) },
    util && { label: 'Utilization', value: `${util.activePct}%`, delta: util.underused ? 'underused' : 'active', state: util.underused ? 'attention' : 'flow' },
    fuel && { label: 'Recent Fuel', value: `${fuel.recentKmL} km/L`, delta: `${fuel.changePct > 0 ? '+' : ''}${fuel.changePct}% vs base`, state: fuel.degrading ? 'attention' : 'flow' },
    util && { label: 'Total Distance', value: `${(util.totalDistanceKm / 1000).toFixed(1)}k km`, delta: `${util.trips} trips`, state: 'flow' },
  ].filter(Boolean);

  return (
    <>
      {header}
      <div className="kpi-grid">
        {kpis.map((k) => <KpiCard key={k.label} {...k} />)}
      </div>

      <div className="split">
        <div className="col">
          {risk && (
            <div className="card">
              <div className="card__head"><span className="ai-chip">AI</span><h2>Breakdown Risk &amp; Telemetry</h2></div>
              <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
                {risk.riskPct}% predicted chance of a breakdown in the next {fleet.maintenanceRisk.modelMetrics.labelHorizonDays} days ({risk.riskLevel} risk).
              </p>
              <MetricGrid>
                <Metric label="Breakdown risk" value={`${risk.riskPct}%`} sub={`${risk.riskLevel} risk`} state={riskState(risk.riskPct)} />
                <Metric label="Brake pad wear" value={`${risk.brakePadWearPct}%`} state={risk.brakePadWearPct >= 80 ? 'attention' : 'flow'} />
                <Metric label="Engine temp" value={`${risk.engineTempAvgC}°C`} sub={`Δ7d ${risk.engineTempTrend7 > 0 ? '+' : ''}${risk.engineTempTrend7}°`} state={risk.engineTempTrend7 >= 3 ? 'attention' : 'flow'} />
                <Metric label="Oil pressure" value={`${risk.oilPressurePsi} psi`} sub={`Δ7d ${risk.oilPressureTrend7 > 0 ? '+' : ''}${risk.oilPressureTrend7}`} state={risk.oilPressureTrend7 <= -3 ? 'attention' : 'flow'} />
                <Metric label="Battery" value={`${risk.batteryVoltage} V`} />
                <Metric label="Odometer" value={`${Math.round(risk.odometerKm).toLocaleString()} km`} />
              </MetricGrid>
            </div>
          )}

          <div className="card">
            <div className="card__head"><span className="ai-chip">AI</span><h2>Maintenance Schedule</h2></div>
            {sched && sched.priority !== 'Routine' ? (
              <div style={{ borderRadius: 6, background: sched.state === 'critical' ? 'var(--critical-bg)' : 'var(--accent-attention-bg)', borderLeft: `3px solid ${sched.state === 'critical' ? 'var(--critical)' : 'var(--accent-attention)'}`, padding: '11px 13px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`dot s-${sched.state}`} />
                  <span style={{ fontWeight: 600 }}>{sched.priority} priority</span>
                  <span className="mono muted" style={{ marginLeft: 'auto', fontSize: 12 }}>window {sched.suggestedWindow}</span>
                </div>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{sched.reason}</div>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>No urgent service due — routine maintenance only.</p>
            )}
          </div>

          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Today&rsquo;s Route</h2>
              {route && <Link to="/dispatch" className="link-id" style={{ fontSize: 12 }}>Open dispatch →</Link>}
            </div>
            {route ? (
              <>
                <MetricGrid>
                  <Metric label="Driver" value={<Link className="link-id" to={`/fleet/driver/${route.driverId}`}>{route.driver}</Link>} />
                  <Metric label="Stops" value={route.numStops} />
                  <Metric label="Distance" value={`${route.distanceKm} km`} />
                  <Metric label="Load" value={`${route.capacityUtilizationPct}%`} sub={`${route.load}/${route.capacity} units`} state={route.capacityUtilizationPct >= 100 ? 'critical' : route.capacityUtilizationPct < 50 ? 'attention' : 'flow'} />
                  <Metric label="Window" value={`${route.startTime}–${route.endTime}`} />
                  <Metric label="Fuel" value={`${Math.round(route.fuelLitres)} L`} sub={`$${Math.round(route.fuelCost)}`} />
                </MetricGrid>
                {(route.overtimeRisk || route.rerouteRecommended) && (
                  <div className="mono s-attention" style={{ fontSize: 12, marginTop: 10 }}>
                    ⚠ {[route.overtimeRisk && 'Overtime risk', route.rerouteRecommended && 'Reroute suggested'].filter(Boolean).join(' · ')}
                  </div>
                )}
              </>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>This truck isn&rsquo;t on today&rsquo;s dispatch plan{dispatch ? ` (${dispatch.warehouseName} only)` : ''}.</p>
            )}
          </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="card__head"><span className="ai-chip">AI</span><h2>Anomaly Detection</h2></div>
            {anom ? (
              <div style={{ borderRadius: 6, background: anom.state === 'critical' ? 'var(--critical-bg)' : 'var(--accent-attention-bg)', borderLeft: `3px solid ${anom.state === 'critical' ? 'var(--critical)' : 'var(--accent-attention)'}`, padding: '11px 13px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`dot s-${anom.state}`} />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{anom.anomalousDays} unusual days</span>
                  <span className="mono muted" style={{ marginLeft: 'auto', fontSize: 11 }}>worst {anom.worstDate}</span>
                </div>
                <div style={{ fontSize: 11.5, marginTop: 8, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span className="muted">engine</span><span className="mono">{anom.engineTempMaxC}°C</span>
                  <span className="muted">oil</span><span className="mono">{anom.oilPressurePsi} psi</span>
                  <span className="muted">battery</span><span className="mono">{anom.batteryVoltage} V</span>
                </div>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>No unusual sensor readings in the last {fleet.anomalies.summary.windowDays} days.</p>
            )}
          </div>

          {util && (
            <div className="card">
              <h2 style={{ marginBottom: 10 }}>Utilization</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span className="bar"><span className={`bar__fill s-${util.underused ? 'attention' : 'flow'}`} style={{ width: `${util.activePct}%` }} /></span>
                <span className={`mono s-${util.underused ? 'attention' : 'flow'}`} style={{ fontSize: 13, width: 44, textAlign: 'right' }}>{util.activePct}%</span>
              </div>
              <MetricGrid>
                <Metric label="Days active" value={`${util.daysActive}/${util.totalDays}`} />
                <Metric label="Distance" value={`${util.totalDistanceKm.toLocaleString()} km`} />
                <Metric label="Trips" value={util.trips} />
                <Metric label="Status" value={util.underused ? 'Underused' : 'Healthy'} state={util.underused ? 'attention' : 'flow'} />
              </MetricGrid>
            </div>
          )}

          {fuel && (
            <div className="card">
              <h2 style={{ marginBottom: 10 }}>Fuel Efficiency</h2>
              <MetricGrid>
                <Metric label="Recent (30d)" value={`${fuel.recentKmL} km/L`} state={fuel.degrading ? 'attention' : 'flow'} />
                <Metric label="Baseline" value={`${fuel.baselineKmL} km/L`} />
                <Metric label="Change" value={`${fuel.changePct > 0 ? '+' : ''}${fuel.changePct}%`} state={fuel.degrading ? 'attention' : 'flow'} />
                <Metric label="Fleet avg" value={`${fleet.fuelAnalytics.fleetAvgKmL} km/L`} />
              </MetricGrid>
              {fuel.degrading && <div className="mono s-attention" style={{ fontSize: 12, marginTop: 10 }}>▼ Efficiency degrading &gt;{fleet.fuelAnalytics.degradeThresholdPct}% vs baseline — an early maintenance signal.</div>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
