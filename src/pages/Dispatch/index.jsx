import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import PageHeader from '../../components/PageHeader.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import DataTable, { StatusCell } from '../../components/DataTable.jsx';
import { API_BASE } from '../../api.js';

// Live data source: the FastAPI backend (see backend/models/dispatch_intelligence.py).
// The plan is a real OR-Tools CVRPTW solve over haversine distances plus a
// RandomForest delay model trained on historical trip logs.
const API_URL = `${API_BASE}/api/dispatch/plan`;

// Categorical route palette (validated dark-surface hues from the dataviz
// reference; fixed order, never cycled). Each vehicle route gets one colour and
// the legend direct-labels the truck id — the required secondary encoding since
// the green/yellow pair sits in the CVD floor band.
const ROUTE_COLORS = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926'];
const routeColor = (i) => ROUTE_COLORS[i % ROUTE_COLORS.length];

// Route status label derived from the solver + ML flags.
const statusOf = (r) => {
  if (r.overtimeRisk) return { label: 'OT risk', state: 'attention' };
  if (r.rerouteRecommended) return { label: 'Reroute', state: 'attention' };
  if (r.capacityUtilizationPct < 50) return { label: 'Underused', state: 'attention' };
  return { label: 'Optimized', state: 'flow' };
};

export default function Dispatch() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(null);   // selected route index; null = show all

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
      title="Dispatch Intelligence"
      subtitle={
        data
          ? `${data.warehouseName} · ${data.ordersToday} orders · ${data.routes.length} routes · ${data.totalDistanceKm} km · ${data.planDate}`
          : 'CVRPTW route optimization · fuel · delay & overtime prediction'
      }
    />
  );

  if (error) {
    return (
      <>
        {header}
        <div className="card" style={{ maxWidth: 640 }}>
          <h2 style={{ marginBottom: 8 }}>Dispatch API unavailable</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            Could not reach the dispatch service at <span className="mono">{API_URL}</span> ({error}).
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
        <div className="muted" style={{ padding: '48px 4px', fontSize: 14 }}>Solving today's routes…</div>
      </>
    );
  }

  const { routes, delayRisk, overtimeFlags, loadBalancing, geo, unassignedCount } = data;
  const totalFuelCost = routes.reduce((s, r) => s + r.fuelCost, 0);
  const totalLitres = routes.reduce((s, r) => s + r.fuelLitres, 0);

  // fit-bounds for the real map: depot + every delivery stop
  const allPts = [[geo.depot.lat, geo.depot.lng],
    ...geo.routes.flatMap((r) => r.stops.map((s) => [s.lat, s.lng]))];
  const bounds = [
    [Math.min(...allPts.map((p) => p[0])), Math.min(...allPts.map((p) => p[1]))],
    [Math.max(...allPts.map((p) => p[0])), Math.max(...allPts.map((p) => p[1]))],
  ];
  const visibleRoutes = geo.routes.filter((r) => sel === null || r.route === sel);

  const rows = routes.map((r, i) => {
    const s = statusOf(r);
    return { ...r, id: r.vehicleId, _label: s.label, _state: s.state, _color: routeColor(i) };
  });
  const columns = [
    { header: 'Truck', cell: (r) => (
      <span className="mono" style={{ color: r._color }}>■ <span className="muted">{r.vehicleId}</span></span>
    ) },
    { header: 'Driver', cell: (r) => r.driver },
    { header: 'Stops', cell: (r) => <span className="mono">{r.numStops}</span> },
    { header: 'Dist', cell: (r) => <span className="mono">{r.distanceKm}km</span> },
    { header: 'Load', cell: (r) => <span className="mono">{r.capacityUtilizationPct}%</span> },
    { header: 'ETA', cell: (r) => <span className="mono">{r.endTime}</span> },
    { header: 'Status', cell: (r) => <StatusCell state={r._state} label={r._label} /> },
  ];

  return (
    <>
      {header}

      <div className="kpi-grid">
        {data.kpis.map((k) => (
          <KpiCard key={k.label} label={k.label} value={String(k.value)} delta={k.delta} state={k.state} />
        ))}
      </div>

      <div className="split">
        <div className="col">
          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Truck &amp; Driver Assignment</h2>
              <span className="muted" style={{ fontSize: 12 }}>
                OR-Tools CVRPTW{unassignedCount ? ` · ${unassignedCount} unassigned (capacity)` : ''}
              </span>
            </div>
            <DataTable columns={columns} rows={rows} keyField="id" template=".9fr 1.3fr .6fr .7fr .6fr .7fr 1fr" />
          </div>

          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Optimized Route Map · {data.warehouseId}</h2>
              <span className="muted" style={{ fontSize: 12 }}>
                {sel === null ? 'click a truck below to isolate its route' : `showing ${routes[sel].vehicleId} only`}
              </span>
            </div>
            <div style={{ height: 360, borderRadius: 6, overflow: 'hidden', border: '0.5px solid var(--border)' }}>
              <MapContainer bounds={bounds} boundsOptions={{ padding: [30, 30] }}
                style={{ height: '100%', width: '100%', background: 'var(--bg-page)' }} scrollWheelZoom={false}>
                <TileLayer
                  url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                  subdomains="abcd"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
                />
                {visibleRoutes.map((r) => (
                  <Polyline key={r.vehicleId} positions={r.path}
                    pathOptions={{ color: routeColor(r.route), weight: sel === null ? 2 : 3,
                      opacity: 0.85, dashArray: r.reroute ? '6 5' : undefined }} />
                ))}
                {visibleRoutes.flatMap((r) => r.stops.map((s) => (
                  <CircleMarker key={s.orderId} center={[s.lat, s.lng]} radius={sel === null ? 3.5 : 4.5}
                    pathOptions={{ color: routeColor(r.route), fillColor: routeColor(r.route), fillOpacity: 0.9, weight: 1 }}>
                    <Tooltip>{r.vehicleId} · {s.orderId} · {s.weight}u</Tooltip>
                  </CircleMarker>
                )))}
                <CircleMarker center={[geo.depot.lat, geo.depot.lng]} radius={8}
                  pathOptions={{ color: '#ffffff', fillColor: '#ffae42', fillOpacity: 1, weight: 2 }}>
                  <Tooltip permanent direction="right">{geo.depot.label} depot</Tooltip>
                </CircleMarker>
              </MapContainer>
            </div>
            {/* clickable legend = filter + direct labels (secondary encoding for the CVD floor-band pair) */}
            <div className="legend" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <button
                onClick={() => setSel(null)}
                style={{ fontSize: 12, cursor: 'pointer', background: 'none', color: 'inherit',
                  border: '0.5px solid var(--border)', padding: '3px 9px', borderRadius: 5,
                  fontWeight: sel === null ? 600 : 400, opacity: sel === null ? 1 : 0.7 }}>
                All routes
              </button>
              {routes.map((r, i) => (
                <button
                  key={r.vehicleId}
                  onClick={() => setSel(sel === i ? null : i)}
                  className="legend__item"
                  style={{ fontSize: 12, cursor: 'pointer', background: 'none', border: 0,
                    padding: '3px 5px', borderRadius: 5,
                    opacity: sel === null || sel === i ? 1 : 0.35,
                    outline: sel === i ? `1.5px solid ${routeColor(i)}` : 'none' }}>
                  <span style={{ width: 12, height: 3, borderRadius: 2, background: routeColor(i), display: 'inline-block' }} />
                  <span className="mono">{r.vehicleId}</span>
                  {(r.rerouteRecommended || r.overtimeRisk) && <span className="s-attention"> ⚠</span>}
                </button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
              {sel === null
                ? `${routes.length} vehicle routes from ${data.warehouseName}, ${data.totalDistanceKm} km total — one colour per truck, each dot a delivery stop in optimized order. ⚠ = predicted delay / overtime risk.`
                : `${routes[sel].vehicleId} · ${routes[sel].driver} — ${routes[sel].numStops} stops, ${routes[sel].distanceKm} km, ${routes[sel].startTime}–${routes[sel].endTime}. Click again or “All routes” to reset.`}
            </div>
          </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="card__head">
              <h2>Delay &amp; Overtime Prediction</h2>
            </div>
            {delayRisk.flags.length === 0 && overtimeFlags.length === 0 ? (
              <div
                style={{
                  borderRadius: 6, background: 'var(--accent-flow-bg)',
                  borderLeft: '3px solid var(--accent-flow)', padding: '10px 12px',
                  fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
                }}
              >
                <span className="dot s-flow" />
                <span>All routes within planned duration and shift limits.</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {overtimeFlags.map((f) => (
                  <div
                    key={`o-${f.vehicleId}`}
                    style={{ borderRadius: 6, background: 'var(--critical-bg)', borderLeft: '3px solid var(--critical)', padding: '9px 11px' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="dot s-critical" />
                      <span style={{ fontWeight: 500, fontSize: 13 }}>{f.driver}</span>
                      <span className="mono muted" style={{ fontSize: 11 }}>{f.vehicleId}</span>
                      <span className="mono s-critical" style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600 }}>{f.overMin} min over shift</span>
                    </div>
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
                      Overtime risk · predicted {f.predictedDurationMin}m vs {f.maxShiftMin}m shift
                    </div>
                  </div>
                ))}
                {delayRisk.flags.map((f) => (
                  <div
                    key={`d-${f.vehicleId}`}
                    style={{ borderRadius: 6, background: 'var(--accent-attention-bg)', borderLeft: '3px solid var(--accent-attention)', padding: '9px 11px' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="dot s-attention" />
                      <span style={{ fontWeight: 500, fontSize: 13 }}>{f.driver}</span>
                      <span className="mono muted" style={{ fontSize: 11 }}>{f.vehicleId}</span>
                      <span className="mono s-attention" style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600 }}>{f.overshootMin} min slower</span>
                    </div>
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
                      Reroute suggested · predicted {f.predictedDurationMin}m vs planned {f.plannedDurationMin}m
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Fuel Stop Planning</h2>
              <span className="muted" style={{ fontSize: 12 }}>range {data.meta.tankRangeKm}km / tank</span>
            </div>
            <div className="summary-stats" style={{ marginTop: 2, marginBottom: 12 }}>
              <div className="stat stat--flow">
                <div className="stat__label">Total diesel</div>
                <div className="stat__value">{totalLitres.toFixed(0)} <span className="muted" style={{ fontSize: 12 }}>L</span></div>
              </div>
              <div className="stat stat--flow">
                <div className="stat__label">Est. fuel cost</div>
                <div className="stat__value">${totalFuelCost.toFixed(0)}</div>
              </div>
            </div>
            {routes.map((r, i) => (
              <div className="alert-row" key={r.vehicleId}>
                <span className="dot" style={{ marginTop: 4, background: routeColor(i) }} />
                <span className="alert-row__text">
                  {r.vehicleId}
                  <span className="muted" style={{ fontSize: 11 }}> · {Math.round(r.distanceKm)} km route</span>
                  {r.needsFuelStop && <span className="s-attention" style={{ fontSize: 11 }}> · refuel at {r.nearestStation}</span>}
                </span>
                <span className="alert-row__time mono">{Math.round(r.fuelLitres)} L · ${Math.round(r.fuelCost)}</span>
              </div>
            ))}
            <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
              Estimated diesel each truck burns on its route, and the cost. Every route today fits within the
              {' '}{data.meta.tankRangeKm} km tank range, so no mid-route refuel stop is needed.
            </div>
          </div>

          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Load Balancing</h2>
              <span className="muted" style={{ fontSize: 12 }}>avg {loadBalancing.avgUtilizationPct}% full · units loaded / capacity</span>
            </div>
            {routes.map((r, i) => {
              const over = r.capacityUtilizationPct >= 100;
              const under = r.capacityUtilizationPct < 50;
              const barColor = over ? 'var(--critical)' : under ? 'var(--accent-attention)' : routeColor(i);
              return (
                <div key={r.vehicleId} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                    <span className="mono muted">{r.vehicleId} · {r.load.toLocaleString()} / {r.capacity.toLocaleString()} units</span>
                    <span className="mono" style={{ color: barColor }}>
                      {r.capacityUtilizationPct}% full{under ? ' · underused' : over ? ' · overloaded' : ''}
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-page)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(r.capacityUtilizationPct, 100)}%`, height: '100%', background: barColor, borderRadius: 3 }} />
                  </div>
                </div>
              );
            })}
            <div className="muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
              {loadBalancing.underused.length === 0 && loadBalancing.overloaded.length === 0
                ? `Fleet running near capacity (avg ${loadBalancing.avgUtilizationPct}%)${unassignedCount ? ` — ${unassignedCount} order(s) couldn't fit` : ''}.`
                : `${loadBalancing.underused.length} underused · ${loadBalancing.overloaded.length} overloaded.`}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
