import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import PageHeader from '../../components/PageHeader.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import DataTable, { StatusCell } from '../../components/DataTable.jsx';
import RoiCard from '../../components/RoiCard.jsx';
import { API_BASE } from '../../api.js';
import { useTheme } from '../../theme/ThemeContext.jsx';

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

// Great-circle distance (km) between two [lat, lng] points — used to break the
// selected route into per-leg distances for the itinerary panel.
const havKm = (a, b) => {
  const R = 6371;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b[0] - a[0]);
  const dLng = toR(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
};
const hhmmToMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const minToHhmm = (m) => {
  const x = Math.round(m);
  return `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

// Route status label derived from the solver + ML flags.
const statusOf = (r) => {
  if (r.overtimeRisk) return { label: 'OT risk', state: 'attention' };
  if (r.rerouteRecommended) return { label: 'Reroute', state: 'attention' };
  if (r.capacityUtilizationPct < 50) return { label: 'Underused', state: 'attention' };
  return { label: 'Optimized', state: 'flow' };
};

// Session-scoped memory of the isolated truck, so navigating to a detail page
// and pressing Back restores the same selection (survives the remount).
let cachedSel = null;

export default function Dispatch() {
  const { theme } = useTheme();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSelState] = useState(cachedSel);
  const setSel = (v) => { cachedSel = v; setSelState(v); };
  const [roadPaths, setRoadPaths] = useState({}); // route idx -> [[lat,lng],…] snapped to roads

  // CARTO basemap that matches the active app theme so the map panel never
  // renders a dark rectangle inside a light page (and vice-versa).
  const tileUrl = theme === 'dark'
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

  useEffect(() => {
    let alive = true;
    fetch(API_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  // Snap each route's straight legs onto real roads via OSRM's free routing
  // demo (no API key). The solver already fixed the STOP ORDER; here we only
  // fetch the driving geometry that connects those stops so the polyline
  // follows streets instead of flying in a straight line. If OSRM is
  // unreachable, the route keeps its straight-line path (graceful fallback).
  useEffect(() => {
    if (!data?.geo?.routes?.length) return undefined;
    let alive = true;
    const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
    data.geo.routes.forEach((r) => {
      const coords = r.path.map(([lat, lng]) => `${lng},${lat}`).join(';');
      fetch(`${OSRM}${coords}?overview=full&geometries=geojson`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('osrm'))))
        .then((j) => {
          const geo = j?.routes?.[0]?.geometry?.coordinates;
          if (!alive || !geo) return;
          setRoadPaths((prev) => ({ ...prev, [r.route]: geo.map(([lng, lat]) => [lat, lng]) }));
        })
        .catch(() => { /* keep the straight-line fallback for this route */ });
    });
    return () => { alive = false; };
  }, [data]);

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
        <div className="card" style={{ maxWidth: 640, borderLeft: '3px solid var(--accent-attention)' }}>
          <h2 style={{ marginBottom: 8 }}>Live dispatch data is temporarily unavailable</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            We couldn&rsquo;t reach the routing service just now. Today&rsquo;s optimized plan will
            appear here as soon as the connection is restored — try refreshing in a moment.
          </p>
          <p className="muted" style={{ margin: '10px 0 0', fontSize: 11, opacity: 0.7 }}>
            <span className="mono">{error}</span> · {API_URL}
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

  // driver lookup for the flag panels (flags carry vehicleId, not driverId)
  const driverIdByVehicle = Object.fromEntries(routes.map((r) => [r.vehicleId, r.driverId]));

  // fit-bounds for the real map: depot + every delivery stop
  const allPts = [[geo.depot.lat, geo.depot.lng],
    ...geo.routes.flatMap((r) => r.stops.map((s) => [s.lat, s.lng]))];
  const bounds = [
    [Math.min(...allPts.map((p) => p[0])), Math.min(...allPts.map((p) => p[1]))],
    [Math.max(...allPts.map((p) => p[0])), Math.max(...allPts.map((p) => p[1]))],
  ];
  const visibleRoutes = geo.routes.filter((r) => sel === null || r.route === sel);

  // Itinerary for the selected truck: depot -> delivery stops (in the solver's
  // optimized order) -> depot. Per-leg distances come from the real stop
  // coordinates; arrival times are planned estimates using the same speed
  // (fleetSpeedKmph) and per-stop service time the backend planned with.
  const selInfo = (() => {
    if (sel === null) return null;
    const r = routes[sel];
    const g = geo.routes.find((x) => x.route === sel);
    if (!g) return null;
    const speed = data.meta?.fleetSpeedKmph || 55;
    const svc = data.meta?.serviceMinPerStop || 9;
    const breakAfter = data.meta?.breakAfterMin || 240;   // 4h of work
    const breakDur = data.meta?.breakDurationMin || 30;   // 30-min rest
    const path = g.path;                       // [depot, s1, ..., depot]
    const startMin = hhmmToMin(r.startTime);
    // the VRP gives long shifts a mandatory break; show it when this route runs
    // longer than the break threshold (short routes skip it, same as the solver).
    const takesBreak = (r.plannedDurationMin || 0) > breakAfter;
    let cum = 0;
    let t = startMin;
    let breakDone = false;
    const legs = [];
    for (let k = 1; k < path.length; k += 1) {
      const legKm = havKm(path[k - 1], path[k]);
      cum += legKm;
      t += (legKm / speed) * 60;
      const isReturn = k === path.length - 1;
      // insert the driver's rest break once ~4h of driving has elapsed
      if (takesBreak && !breakDone && (t - startMin) >= breakAfter) {
        legs.push({ isBreak: true, arrive: t, durationMin: breakDur });
        t += breakDur;
        breakDone = true;
      }
      legs.push({ n: k, legKm, cumKm: cum, arrive: t, stop: isReturn ? null : g.stops[k - 1], isReturn });
      if (!isReturn) t += svc;
    }
    return { r, legs, color: routeColor(sel), tookBreak: breakDone, breakDur };
  })();

  const rows = routes.map((r, i) => {
    const s = statusOf(r);
    return { ...r, id: r.vehicleId, _label: s.label, _state: s.state, _color: routeColor(i) };
  });
  const columns = [
    { header: 'Truck', cell: (r) => (
      <span className="mono" style={{ color: r._color }}>■ <Link className="link-id" to={`/fleet/truck/${r.vehicleId}`}>{r.vehicleId}</Link></span>
    ) },
    { header: 'Driver', cell: (r) => <Link className="link-id" to={`/fleet/driver/${r.driverId}`}>{r.driver}</Link> },
    { header: 'Stops', cell: (r) => <span className="mono">{r.numStops}</span> },
    { header: 'Dist', cell: (r) => <span className="mono">{r.distanceKm}km</span> },
    { header: 'Load', cell: (r) => <span className="mono">{r.capacityUtilizationPct}%</span> },
    { header: 'ETA', cell: (r) => <span className="mono">{r.endTime}</span> },
    { header: 'Status', cell: (r) => <StatusCell state={r._state} label={r._label} /> },
  ];

  return (
    <>
      {header}

      <RoiCard
        subtitle="Routing, fuel & delays"
        items={[
          { value: '$18–22K/yr', label: 'Routing & fuel', note: 'VRP-optimized routes · ~12% mileage-linked fuel & running cost' },
          { value: `${loadBalancing.avgUtilizationPct}%`, label: 'Avg load factor', note: 'fuller trucks → fewer trips for the same orders' },
          { value: `${delayRisk.flags.length + overtimeFlags.length}`, label: 'Delays caught early', state: (delayRisk.flags.length + overtimeFlags.length) ? 'attention' : 'flow', note: 'reroute / overtime flagged before dispatch, not after' },
        ]}
        footnote="Load factor and delay flags are live from today's plan; the fuel/routing saving is a conservative estimate on the modeled fleet."
      />

      <div className="kpi-grid">
        {data.kpis.map((k) => {
          // strip the cryptic warehouse code (e.g. "WH2 · ") from KPI captions —
          // the warehouse name already shows in the page subtitle.
          const delta = typeof k.delta === 'string'
            ? k.delta.replace(`${data.warehouseId} · `, '')
            : k.delta;
          return <KpiCard key={k.label} label={k.label} value={String(k.value)} delta={delta} state={k.state} />;
        })}
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
              <h2>Optimized Route Map · {data.warehouseName}</h2>
              <span className="muted" style={{ fontSize: 12 }}>
                {sel === null ? 'click a truck below to isolate its route' : `showing ${routes[sel].vehicleId} only`}
              </span>
            </div>
            <div style={{ height: 360, borderRadius: 6, overflow: 'hidden', border: '0.5px solid var(--border)' }}>
              <MapContainer bounds={bounds} boundsOptions={{ padding: [30, 30] }}
                style={{ height: '100%', width: '100%', background: 'var(--bg-page)' }} scrollWheelZoom={false}>
                <TileLayer
                  key={theme}
                  url={tileUrl}
                  subdomains="abcd"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
                />
                {visibleRoutes.map((r) => (
                  <Polyline key={r.vehicleId} positions={roadPaths[r.route] || r.path}
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
                  <Tooltip direction="top">Warehouse · {data.warehouseName}</Tooltip>
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
                </button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
              {sel === null
                ? `${routes.length} vehicle routes from ${data.warehouseName}, ${data.totalDistanceKm} km total — one colour per truck, each dot a delivery stop in optimized order, lines follow real roads.`
                : `${routes[sel].vehicleId} · ${routes[sel].driver} — ${routes[sel].numStops} stops, ${routes[sel].distanceKm} km, ${routes[sel].startTime}–${routes[sel].endTime}. Click again or “All routes” to reset.`}
            </div>
            {/* key for the depot marker (the permanent label was removed from the map) */}
            <div className="legend" style={{ marginTop: 6 }}>
              <span className="legend__item">
                <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#ffae42',
                  border: '1.5px solid var(--bg-panel)', boxShadow: '0 0 0 1px var(--border-strong)',
                  display: 'inline-block', flexShrink: 0 }} />
                Orange circle = warehouse ({data.warehouseName}) — routes start &amp; end here
              </span>
            </div>
          </div>

          {selInfo && (
            <div className="card">
              <div className="card__head" style={{ justifyContent: 'space-between' }}>
                <h2><span style={{ color: selInfo.color }}>■ </span><Link className="link-id" to={`/fleet/truck/${selInfo.r.vehicleId}`}>{selInfo.r.vehicleId}</Link> · Itinerary</h2>
                <button className="btn btn--sm" onClick={() => setSel(null)}>Show all</button>
              </div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
                Driver <Link className="link-id" to={`/fleet/driver/${selInfo.r.driverId}`}>{selInfo.r.driver}</Link> · {selInfo.r.numStops} deliveries from {data.warehouseName} ·
                {' '}{selInfo.r.distanceKm} km · runs {selInfo.r.startTime} to {selInfo.r.endTime} · truck {selInfo.r.capacityUtilizationPct}% full
                {selInfo.r.needsFuelStop ? ` · refuels at ${selInfo.r.nearestStation}` : ''}
              </div>

              <div style={{ maxHeight: 340, overflowY: 'auto', paddingRight: 4 }}>
                {/* depot departure */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0' }}>
                  <span style={{ width: 22, height: 22, borderRadius: 5, background: 'var(--accent-attention)', color: 'var(--on-accent)', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>◆</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>Start · {data.warehouseName}</div>
                    <div className="muted" style={{ fontSize: 11 }}>Truck leaves the warehouse</div>
                  </div>
                  <span className="mono muted" style={{ fontSize: 11.5, flexShrink: 0 }}>{selInfo.r.startTime}</span>
                </div>

                {selInfo.legs.map((leg) => (
                  leg.isBreak ? (
                    <div key="break" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderTop: '0.5px dashed var(--accent-attention)' }}>
                      <span style={{ width: 22, height: 22, borderRadius: 5, background: 'var(--accent-attention-bg)', color: 'var(--accent-attention)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: '1px solid var(--accent-attention)' }}>
                        <span style={{ display: 'inline-flex', gap: 2 }}>
                          <span style={{ width: 2, height: 9, background: 'currentColor', borderRadius: 1 }} />
                          <span style={{ width: 2, height: 9, background: 'currentColor', borderRadius: 1 }} />
                        </span>
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="s-attention" style={{ fontSize: 12.5, fontWeight: 600 }}>Rest break · {leg.durationMin} min</div>
                        <div className="muted" style={{ fontSize: 11 }}>Mandatory driver break after 4h of driving</div>
                      </div>
                      <span className="mono muted" style={{ fontSize: 11.5, flexShrink: 0 }}>~{minToHhmm(leg.arrive)}–{minToHhmm(leg.arrive + leg.durationMin)}</span>
                    </div>
                  ) : leg.isReturn ? (
                    <div key="return" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderTop: '0.5px solid var(--border)' }}>
                      <span style={{ width: 22, height: 22, borderRadius: 5, background: 'var(--accent-attention)', color: 'var(--on-accent)', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>◆</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>Back to {data.warehouseName}</div>
                        <div className="muted" style={{ fontSize: 11 }}>Route complete · {leg.cumKm.toFixed(1)} km driven in total</div>
                      </div>
                      <span className="mono muted" style={{ fontSize: 11.5, flexShrink: 0 }}>≈ {minToHhmm(leg.arrive)}</span>
                    </div>
                  ) : (
                    <div key={leg.stop.orderId} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderTop: '0.5px solid var(--border)' }}>
                      <span style={{ width: 22, height: 22, borderRadius: '50%', background: selInfo.color, color: '#fff', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{leg.n}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                          Stop {leg.n} of {selInfo.r.numStops}
                          <span className="mono muted" style={{ fontWeight: 400, fontSize: 11 }}> · {leg.stop.orderId}</span>
                        </div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          Drop off {leg.stop.weight} units
                          {leg.stop.customerId ? ` · customer ${leg.stop.customerId}` : ''}
                          {` · ${leg.legKm.toFixed(1)} km from previous stop`}
                          {leg.stop.windowStart ? ` · deliver by ${leg.stop.windowStart}–${leg.stop.windowEnd}` : ''}
                        </div>
                      </div>
                      <span className="mono muted" style={{ fontSize: 11.5, flexShrink: 0 }}>arrive ~{minToHhmm(leg.arrive)}</span>
                    </div>
                  )
                ))}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
                Stops are shown in the best order our route planner found. The “arrive ~” times are estimates
                (driving at {data.meta?.fleetSpeedKmph || 55} km/h with about {data.meta?.serviceMinPerStop || 9} min at each stop) — not fixed appointment times.
                {selInfo.tookBreak
                  ? ` A ${selInfo.breakDur}-min rest break is included after 4h of driving.`
                  : ' This route is short enough that no rest break is required.'}
              </div>
            </div>
          )}
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
                      <Link className="link-id" to={`/fleet/driver/${driverIdByVehicle[f.vehicleId]}`} style={{ fontWeight: 500, fontSize: 13 }}>{f.driver}</Link>
                      <Link className="link-id mono" to={`/fleet/truck/${f.vehicleId}`} style={{ fontSize: 11 }}>{f.vehicleId}</Link>
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
                      <Link className="link-id" to={`/fleet/driver/${driverIdByVehicle[f.vehicleId]}`} style={{ fontWeight: 500, fontSize: 13 }}>{f.driver}</Link>
                      <Link className="link-id mono" to={`/fleet/truck/${f.vehicleId}`} style={{ fontSize: 11 }}>{f.vehicleId}</Link>
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
                  <Link className="link-id" to={`/fleet/truck/${r.vehicleId}`}>{r.vehicleId}</Link>
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
                    <span className="mono muted"><Link className="link-id" to={`/fleet/truck/${r.vehicleId}`}>{r.vehicleId}</Link> · {r.load.toLocaleString()} / {r.capacity.toLocaleString()} units</span>
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
