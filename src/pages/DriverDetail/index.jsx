import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import PageHeader from '../../components/PageHeader.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import { Metric, MetricGrid } from '../../components/Metric.jsx';
import { API_BASE } from '../../api.js';

// Complete per-driver profile: safety & fuel performance from the Fleet
// dashboard plus today's assignment from the Dispatch plan.
export default function DriverDetail() {
  const { driverId } = useParams();
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
  }, [driverId]);

  const driver = fleet?.driverPerformance?.drivers?.find((d) => d.driverId === driverId);
  const route = dispatch?.routes?.find((r) => r.driverId === driverId);
  const name = driver?.name || route?.driver || driverId;

  const header = (
    <>
      <Link to="/fleet" className="link-id" style={{ fontSize: 12, display: 'inline-block', marginBottom: 8 }}>← Fleet Intelligence</Link>
      <PageHeader title={name} subtitle="Complete driver profile — safety, fuel efficiency & today's assignment" />
    </>
  );

  if (error) {
    return (
      <>{header}
        <div className="card" style={{ maxWidth: 640, borderLeft: '3px solid var(--accent-attention)' }}>
          <h2 style={{ marginBottom: 8 }}>Driver data is temporarily unavailable</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>We couldn&rsquo;t load fleet data just now. Try refreshing in a moment.</p>
          <p className="muted" style={{ margin: '10px 0 0', fontSize: 11, opacity: 0.7 }}><span className="mono">{error}</span></p>
        </div>
      </>
    );
  }
  if (!fleet) return (<>{header}<div className="muted" style={{ padding: '48px 4px', fontSize: 14 }}>Loading driver profile…</div></>);

  if (!driver) {
    return (<>{header}<div className="card"><p style={{ margin: 0 }}>No performance record found for <span className="mono">{driverId}</span>. <Link className="link-id" to="/fleet">Back to Fleet</Link></p></div></>);
  }

  const dp = fleet.driverPerformance.summary;
  const fleetEff = dp.fleetAvgFuelEff;
  const effState = driver.fuelEfficiencyKmL >= fleetEff ? 'flow' : 'attention';

  const kpis = [
    { label: 'Safety Score', value: String(driver.safetyScore), delta: driver.worseThanFleet ? 'below fleet' : 'on track', state: driver.state },
    { label: 'Fuel Efficiency', value: `${driver.fuelEfficiencyKmL} km/L`, delta: `fleet avg ${fleetEff}`, state: effState },
    { label: 'Harsh / 100km', value: String(driver.harshPer100km), delta: driver.worseThanFleet ? 'rough' : 'smooth', state: driver.worseThanFleet ? 'attention' : 'flow' },
    { label: 'Fleet Rank', value: `#${driver.rank}`, delta: `of ${dp.drivers} drivers`, state: 'flow' },
  ];

  return (
    <>
      {header}
      <div className="kpi-grid">
        {kpis.map((k) => <KpiCard key={k.label} {...k} />)}
      </div>

      <div className="split">
        <div className="col">
          <div className="card">
            <div className="card__head"><h2 style={{ margin: 0 }}>Driving Performance</h2></div>
            <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
              Ranked #{driver.rank} of {dp.drivers} drivers by combined safety + fuel score.
              {driver.worseThanFleet ? ' Flagged worse than the fleet average.' : ' Performing at or above the fleet average.'}
            </p>
            <MetricGrid>
              <Metric label="Safety score" value={driver.safetyScore} sub="0–100, higher safer" state={driver.state} />
              <Metric label="Fuel efficiency" value={`${driver.fuelEfficiencyKmL} km/L`} sub={`fleet avg ${fleetEff}`} state={effState} />
              <Metric label="Harsh / 100km" value={driver.harshPer100km} sub={`fleet avg ${dp.fleetAvgHarshPer100km}`} state={driver.worseThanFleet ? 'attention' : 'flow'} />
              <Metric label="Harsh braking" value={driver.harshBrakingEvents} />
              <Metric label="Harsh accel" value={driver.harshAccelEvents} />
              <Metric label="Avg speed" value={`${driver.avgSpeedKmph} km/h`} />
              <Metric label="Trips" value={driver.trips} />
              <Metric label="Status" value={driver.worseThanFleet ? 'Needs coaching' : 'Good standing'} state={driver.worseThanFleet ? 'attention' : 'flow'} />
            </MetricGrid>
          </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Today&rsquo;s Assignment</h2>
              {route && <Link to="/dispatch" className="link-id" style={{ fontSize: 12 }}>Open dispatch →</Link>}
            </div>
            {route ? (
              <>
                <MetricGrid>
                  <Metric label="Truck" value={<Link className="link-id" to={`/fleet/truck/${route.vehicleId}`}>{route.vehicleId}</Link>} />
                  <Metric label="Stops" value={route.numStops} />
                  <Metric label="Distance" value={`${route.distanceKm} km`} />
                  <Metric label="Window" value={`${route.startTime}–${route.endTime}`} />
                  <Metric label="Load" value={`${route.capacityUtilizationPct}%`} state={route.capacityUtilizationPct >= 100 ? 'critical' : route.capacityUtilizationPct < 50 ? 'attention' : 'flow'} />
                </MetricGrid>
                {(route.overtimeRisk || route.rerouteRecommended) && (
                  <div className="mono s-attention" style={{ fontSize: 12, marginTop: 10 }}>
                    ⚠ {[route.overtimeRisk && 'Overtime risk', route.rerouteRecommended && 'Reroute suggested'].filter(Boolean).join(' · ')}
                  </div>
                )}
              </>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>Not scheduled on today&rsquo;s dispatch plan{dispatch ? ` (${dispatch.warehouseName} only)` : ''}.</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
