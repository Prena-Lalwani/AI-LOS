import { useEffect, useState, Fragment } from 'react';
import PageHeader from '../../components/PageHeader.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import DataTable, { StatusCell } from '../../components/DataTable.jsx';
import RoiCard from '../../components/RoiCard.jsx';
import { API_BASE } from '../../api.js';

// Live data source: the FastAPI backend (see backend/models/inventory_intelligence.py).
// Everything below is computed from the self-generated synthetic warehouse dataset —
// EOQ reorder points, a RandomForest stock-out classifier, real occupancy/activity
// heatmaps, congestion density, and an OR-Tools picking-route optimization.
const API_URL = `${API_BASE}/api/inventory/dashboard`;

// utilization (0–100) -> heat bucket class (b1 idle … b4 congested)
const heatBucket = (u) => (u > 90 ? 'b4' : u > 75 ? 'b3' : u > 55 ? 'b2' : 'b1');

// Turn a raw location code like 'WH1-Z2-A3-R1-S2' into a short warehouse-style
// label 'B3' — Zone becomes a letter (Zone 1=A, 2=B …) and the Aisle number is
// appended. Rack/shelf detail is dropped for readability. Falls back to the raw
// code if it doesn't match the expected pattern.
const friendlyLocation = (code) => {
  if (!code) return '—';
  const m = String(code).match(/Z(\d+)-A(\d+)/);
  if (!m) return code;
  return `${String.fromCharCode(64 + Number(m[1]))}${m[2]}`;
};

// Compact list row with a colored severity accent bar, a bold title, a muted
// detail line and a right-aligned key value — the shared look for every alert
// list in the right column (matches the Fleet / Dispatch polish).
function AccentRow({ state = 'attention', title, meta, value, first }) {
  const color = state === 'critical' ? 'var(--critical)'
    : state === 'flow' ? 'var(--accent-flow)' : 'var(--accent-attention)';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0',
      borderTop: first ? 'none' : '0.5px solid var(--border)' }}>
      <span style={{ width: 3, alignSelf: 'stretch', minHeight: 26, borderRadius: 2, background: color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
        {meta && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{meta}</div>}
      </div>
      <span className={`mono s-${state}`} style={{ fontSize: 11.5, fontWeight: 600, textAlign: 'right', flexShrink: 0 }}>{value}</span>
    </div>
  );
}

// Positive "all clear" line — a green dot with reassuring copy.
function AllClear({ children }) {
  return (
    <div style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <span className="dot s-flow" />{children}
    </div>
  );
}

export default function Inventory() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // interactive picking route: chosen warehouse, selected product ids, and the
  // optimized result (null = show the default example from the dashboard).
  const [pickWh, setPickWh] = useState(null);
  const [pickSel, setPickSel] = useState([]);
  const [customRoute, setCustomRoute] = useState(null);
  const [pickBusy, setPickBusy] = useState(false);
  // slotting moves the user has confirmed (applied) — the heatmap only changes
  // once a suggestion is applied. Each entry = { cabinet, assign } labels.
  const [appliedMoves, setAppliedMoves] = useState([]);

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
      title="Inventory & Warehouse Intelligence"
      subtitle={
        data
          ? `${data.kpis[0]?.value} SKUs · 3 facilities · reorder · stock-out ML · picking · live`
          : 'Reorder · stock-out ML · heatmap · route optimization'
      }
    />
  );

  if (error) {
    return (
      <>
        {header}
        <div className="card" style={{ maxWidth: 640 }}>
          <h2 style={{ marginBottom: 8 }}>Inventory API unavailable</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            Could not reach the inventory service at <span className="mono">{API_URL}</span> ({error}).
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
        <div className="muted" style={{ padding: '48px 4px', fontSize: 14 }}>Loading inventory intelligence…</div>
      </>
    );
  }

  const { reorderRecommendations, safetyStock, stockOutPredictions, overstock,
    warehouseHeatmap, congestionAlerts, pickingRouteExample, pickingCatalog } = data;

  // --- ONE warehouse drives the heatmap AND the picking route ------------
  const catalog = pickingCatalog || { warehouses: [], products: [] };
  const wh = pickWh || warehouseHeatmap.primary;         // selected warehouse id
  const heatWarehouse = warehouseHeatmap.warehouses.find((w) => w.warehouseId === wh)
    || warehouseHeatmap.warehouses[0];

  const priorityOf = (u) => (u > 90 ? 'Congested' : u > 75 ? 'Busy' : u > 55 ? 'Normal' : 'Idle');

  // ---- slotting algorithm ---------------------------------------------------
  // 1) each cabinet gets a priority by nearness to the dock (A1 corner) — P1 is
  //    the closest. distance uses the same grid weights as the picking model.
  // 2) allocate the highest-demand aisles (by pick activity) to the highest-
  //    priority (nearest) cabinets. All derived — no manual placement.
  const dockDist = (z, a) => z * 10 + a * 4;
  const cabinets = heatWarehouse.cells.map((c) => ({
    ...c, label: `${String.fromCharCode(64 + c.zone)}${c.aisle}`, dist: dockDist(c.zone, c.aisle),
  }));
  const byDist = [...cabinets].sort((a, b) => a.dist - b.dist);            // nearest → farthest
  const priorityByLabel = {};
  byDist.forEach((c, i) => { priorityByLabel[c.label] = i + 1; });         // P1 = nearest the door
  const byDemand = [...cabinets].sort((a, b) => b.pickCount - a.pickCount); // busiest first
  // Suggest only moves that bring high-demand stock CLOSER to the door: for each
  // aisle (busiest first) its ideal cabinet is the equally-ranked nearest one;
  // propose a move only when the aisle currently sits FARTHER than that ideal.
  const slotPlan = byDemand
    .map((aisle, i) => ({ aisle, target: byDist[i], rank: i }))
    .filter((m) => m.target && m.aisle.label !== m.target.label
      && priorityByLabel[m.aisle.label] > m.rank + 1);
  // effective content per cabinet — identity at first, and swaps ONLY when the
  // user confirms (applies) a suggested move below. So the heatmap changes on
  // confirm, not automatically.
  const cabinetByLabel = Object.fromEntries(cabinets.map((c) => [c.label, c]));
  const contentMap = {};
  cabinets.forEach((c) => { contentMap[c.label] = c.label; });
  appliedMoves.forEach(({ from, to }) => {
    const t = contentMap[from]; contentMap[from] = contentMap[to]; contentMap[to] = t;
  });

  const whProducts = catalog.products.filter((p) => p.warehouseId === wh);
  // route to show: fetched result, or the startup example if it's the same wh
  const route = customRoute
    || (pickingRouteExample.warehouseId === wh ? pickingRouteExample : null);

  // product ↔ shelf relation: which products sit in each zone-aisle cell, and
  // which cells hold the items currently ticked for picking.
  const aKey = (code) => { const [, z, a] = code.split('-'); return `${+z.slice(1)}-${+a.slice(1)}`; };
  const cellProducts = {};
  whProducts.forEach((p) => { (cellProducts[aKey(p.locationCode)] ||= []).push(p.name); });
  const pickedCells = new Set(
    whProducts.filter((p) => pickSel.includes(p.productId)).map((p) => aKey(p.locationCode)));

  const loadRoute = (whId, products) => {
    setPickBusy(true);
    const qs = new URLSearchParams({ warehouse: whId });
    if (products && products.length) qs.set('products', products.join(','));
    fetch(`${API_BASE}/api/inventory/picking-route?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => setCustomRoute(d))
      .catch(() => {})
      .finally(() => setPickBusy(false));
  };
  const changeWh = (whId) => { setPickWh(whId); setPickSel([]); setCustomRoute(null); setAppliedMoves([]); loadRoute(whId, []); };
  const togglePick = (pid) => setPickSel((s) => (
    s.includes(pid) ? s.filter((x) => x !== pid) : [...s, pid]));
  const optimizeRoute = () => loadRoute(wh, pickSel);

  // Reorder table -> DataTable rows/columns
  const reorderRows = reorderRecommendations.rows.map((r) => ({ ...r, id: `${r.productId}-${r.locationCode}` }));
  const columns = [
    { header: 'Product', cell: (r) => r.name },
    { header: 'Location', cell: (r) => <span className="muted">{friendlyLocation(r.locationCode)}</span> },
    { header: 'On Hand', cell: (r) => <span className="mono">{r.onHand}</span> },
    { header: 'ROP', cell: (r) => <span className="mono">{r.reorderPoint}</span> },
    { header: 'Rec Qty', cell: (r) => <span className="mono">{r.recommendedQty || '—'}</span> },
    { header: 'Status', cell: (r) => <StatusCell state={r.state} label={r.status} /> },
  ];

  const usd = (v) => (v >= 1000 ? `$${(v / 1000).toFixed(0)}K` : `$${v}`);
  const fmtDays = (d) => (d == null ? 'imminent' : `${d} days`);

  return (
    <>
      {header}

      <RoiCard
        subtitle="Capital, labour & lost-sales"
        items={[
          { value: `$${Math.round(data.overstock.totalExcessValue / 1000)}K`, label: 'Overstock capital', state: 'attention', note: `${data.overstock.count} SKUs to right-size · ~$${Math.round(data.overstock.totalExcessValue * 0.25 / 1000)}K/yr carrying cost saved` },
          { value: `−${data.pickingRouteExample.timeSavedPct}%`, label: 'Pick-tour time', note: 'OR-Tools route vs naive picklist → ~$50K/yr picker labour' },
          { value: '$70–100K/yr', label: 'Stock-out recovery', note: `${data.stockOutPredictions.atRiskCount} at-risk SKUs flagged ${data.meta.leadTimeDays} days early — reorder before the shelf empties` },
        ]}
        footnote="Overstock value and pick-time saving are computed live from this dashboard; carrying cost @ 25%/yr and stock-out recovery are conservative estimates."
      />

      <div className="kpi-grid">
        {data.kpis.map((k) => (
          <KpiCard key={k.label} label={k.label} value={String(k.value)} delta={k.delta} state={k.state} />
        ))}
      </div>

      <div className="split">
        <div className="col">
          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Warehouse Heatmap · {heatWarehouse.name}</h2>
              <select className="date-input" value={wh} onChange={(e) => changeWh(e.target.value)}>
                {catalog.warehouses.map((w) => (
                  <option key={w.warehouseId} value={w.warehouseId}>{w.warehouseId} · {w.name}</option>
                ))}
              </select>
            </div>
            <p className="muted" style={{ margin: '0 0 12px', fontSize: 12, lineHeight: 1.5 }}>
              Real layout — rows A–{String.fromCharCode(64 + heatWarehouse.zones)} zones, columns 1–{heatWarehouse.aisles} aisles.
              Each cabinet has a priority <strong>P1</strong> (at the A1 dock) → <strong>P{cabinets.length}</strong> (farthest).
              The algorithm <strong>suggests</strong> moving high-demand stock to the nearest cabinets — <strong>apply</strong> a suggestion below and
              this map updates. Colour = current busyness; ticked pick items get a teal ring.
            </p>
            {(() => {
              const zoneNums = Array.from({ length: heatWarehouse.zones }, (_, i) => i + 1);
              const aisleNums = Array.from({ length: heatWarehouse.aisles }, (_, i) => i + 1);
              return (
                <div style={{ display: 'grid', gridTemplateColumns: `22px repeat(${heatWarehouse.aisles}, 1fr)`, gap: 5 }}>
                  <div className="heat-axis" />
                  {aisleNums.map((a) => <div key={`col${a}`} className="heat-axis">{a}</div>)}
                  {zoneNums.map((z) => (
                    <Fragment key={`row${z}`}>
                      <div className="heat-axis">{String.fromCharCode(64 + z)}</div>
                      {aisleNums.map((a) => {
                        const posLabel = `${String.fromCharCode(64 + z)}${a}`;
                        const pri = priorityByLabel[posLabel];
                        const srcLabel = contentMap[posLabel];             // stock currently shown here
                        const cell = cabinetByLabel[srcLabel];
                        const util = cell ? cell.utilization : 0;
                        const realKey = cell ? `${cell.zone}-${cell.aisle}` : `${z}-${a}`;
                        const items = cellProducts[realKey] || [];
                        const picked = pickedCells.has(realKey);
                        const moved = srcLabel !== posLabel;
                        return (
                          <div
                            key={posLabel}
                            className={`heat-cell ${heatBucket(util)}`}
                            style={{ boxShadow: picked ? 'inset 0 0 0 2px var(--accent-flow)' : undefined }}
                            title={`${posLabel} · P${pri} (nearest = P1) — ${priorityOf(util)}, utilization ${util}%, ${cell ? cell.pickCount : 0} picks`
                              + (moved ? `\nHolds ${srcLabel}'s stock (re-slotted)` : '')
                              + (items.length ? `\nItems: ${items.join(', ')}` : '\nNo catalogued items')}
                          >
                            <span className="heat-cell__pri">P{pri}</span>
                            <span className="heat-cell__util">{util}%</span>
                            <span className="heat-cell__items">{items.length ? `${items.length} item${items.length > 1 ? 's' : ''}` : 'no items'}</span>
                          </div>
                        );
                      })}
                    </Fragment>
                  ))}
                </div>
              );
            })()}
            <div className="legend" style={{ marginTop: 12 }}>
              <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--accent-flow-bg)' }} />Idle &lt;55%</span>
              <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--accent-flow)' }} />Normal</span>
              <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--accent-attention-bg)' }} />Busy</span>
              <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--accent-attention)' }} />Congested &gt;90%</span>
              <span className="legend__item"><span className="legend__swatch" style={{ background: 'transparent', boxShadow: 'inset 0 0 0 2px var(--accent-flow)' }} />Pick item</span>
            </div>
            {slotPlan.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                <div className="card__head" style={{ marginBottom: 8, gap: 8 }}>
                  <span className="ai-chip">SLOTTING</span>
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>Suggested moves — review &amp; apply to re-slot</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {slotPlan.slice(0, 4).map((m) => {
                    const from = m.aisle.label;
                    const to = m.target.label;
                    const isApplied = appliedMoves.some((x) => x.from === from && x.to === to);
                    return (
                      <div key={from} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span className="muted">Move</span>
                        <span className="mono s-attention" style={{ fontWeight: 600 }}>{from}</span>
                        <span className="muted">({m.aisle.pickCount} picks · now P{priorityByLabel[from]})</span>
                        <span className="muted">→</span>
                        <span className="mono s-flow" style={{ fontWeight: 600 }}>P{m.rank + 1} · {to}</span>
                        <span className="muted">(nearer the door)</span>
                        <button
                          className="btn btn--sm"
                          style={{ marginLeft: 'auto', ...(isApplied ? { color: 'var(--accent-flow)', borderColor: 'var(--accent-flow)' } : {}) }}
                          onClick={() => setAppliedMoves((prev) => (isApplied
                            ? prev.filter((x) => !(x.from === from && x.to === to))
                            : [...prev, { from, to }]))}
                        >
                          {isApplied ? '✓ Applied · Undo' : 'Apply'}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
                  Algorithm ranks cabinets P1 (nearest dock) → P{cabinets.length} (farthest); only aisles whose busy stock currently sits farther than it should are suggested for a move closer.
                  {appliedMoves.length > 0 && <span className="s-flow"> {appliedMoves.length} move{appliedMoves.length > 1 ? 's' : ''} applied — the map above is updated.</span>}
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="dot s-flow" /> High-demand stock is already in the nearest cabinets — slotting is optimal.
              </div>
            )}
          </div>

          <div className="card">
            <div className="card__head">
              <h2>Picking Route Optimization · {wh}</h2>
            </div>
            <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
              Tick the items to collect — they light up on the warehouse heatmap above — then optimize the picker&rsquo;s
              walking route (OR-Tools TSP).
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 104, overflowY: 'auto', marginBottom: 10 }}>
              {whProducts.map((p) => (
                <button
                  key={p.productId}
                  className={`chip${pickSel.includes(p.productId) ? ' active' : ''}`}
                  onClick={() => togglePick(p.productId)}
                  title={friendlyLocation(p.locationCode)}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <button className="btn btn--sm" disabled={pickBusy || pickSel.length < 2} onClick={optimizeRoute}>
                {pickBusy ? 'Optimizing…' : `Optimize Route${pickSel.length ? ` (${pickSel.length})` : ''}`}
              </button>
              {pickSel.length > 0 && (
                <button className="btn btn--sm" onClick={() => { setPickSel([]); loadRoute(wh, []); }}>Reset</button>
              )}
              <span className="muted" style={{ fontSize: 11 }}>
                {pickSel.length < 2 ? 'select at least 2 items' : (customRoute && pickSel.length ? 'your picklist' : 'example route')}
              </span>
            </div>

            {route ? (
              <>
                <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', margin: '12px 0' }}>
                  <KpiCard label="Distance Saved" value={`${route.distanceSavedPct}%`} state="flow" />
                  <KpiCard label="Time Saved" value={`${route.timeSavedPct}%`} state="flow" />
                  <KpiCard label="Stops" value={String(route.stops)} state="neutral" />
                </div>
                <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
                  <div><strong>OR-Tools TSP:</strong> <span className="mono">{route.optimizedSequence.map(friendlyLocation).join(' → ')}</span></div>
                  <div style={{ marginTop: 4 }}><strong>Naive picklist:</strong> <span className="mono">{route.naiveSequence.map(friendlyLocation).join(' → ')}</span></div>
                  <div style={{ marginTop: 6 }}>
                    {route.optimizedDistance} vs {route.naiveDistance} distance units ·
                    {' '}{route.optimizedDurationSec}s vs {route.naiveDurationSec}s
                  </div>
                </div>
              </>
            ) : (
              <div className="muted" style={{ fontSize: 13, padding: '16px 2px' }}>
                {pickBusy ? 'Optimizing route…' : 'Select items and optimize to see the route.'}
              </div>
            )}
          </div>
          <div className="card">
            <div className="card__head">              <h2>Reorder Recommendations</h2>
              <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                {reorderRecommendations.flaggedCount} flagged · EOQ · 7-day lead time
              </span>
            </div>
            <DataTable columns={columns} rows={reorderRows} keyField="id" template="1.6fr 1.3fr .7fr .7fr .8fr 1.1fr" />
          </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Stock-Out Prediction</h2>
              <span className="muted" style={{ fontSize: 12 }}>{stockOutPredictions.atRiskCount} at risk · next 7 days</span>
            </div>
            <p className="muted" style={{ margin: '0 0 10px', fontSize: 11, lineHeight: 1.5 }}>
              Products likely to run out within {data.meta.leadTimeDays} days, ranked by risk — an early-warning list so you can reorder before the shelf empties.
            </p>
            {stockOutPredictions.atRisk.length === 0 ? (
              <AllClear>No locations above the model&rsquo;s risk threshold.</AllClear>
            ) : (
              stockOutPredictions.atRisk.map((s, i) => (
                <AccentRow
                  key={`${s.productId}-${s.locationCode}`}
                  first={i === 0}
                  state={s.state}
                  title={s.name}
                  meta={`${friendlyLocation(s.locationCode)} · risk ${Math.round(s.riskProbability * 100)}%`}
                  value={fmtDays(s.daysToStockout)}
                />
              ))
            )}
          </div>

          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Overstock Detection</h2>
              <span className="muted" style={{ fontSize: 12 }}>{overstock.count} locations · {usd(overstock.totalExcessValue)} tied up</span>
            </div>
            {overstock.rows.length === 0 ? (
              <AllClear>No overstocked locations detected.</AllClear>
            ) : (
              overstock.rows.map((o, i) => (
                <AccentRow
                  key={`${o.productId}-${o.locationCode}`}
                  first={i === 0}
                  state="attention"
                  title={o.name}
                  meta={friendlyLocation(o.locationCode)}
                  value={`${usd(o.excessValue)} excess`}
                />
              ))
            )}
          </div>

          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Congestion Alerts</h2>
              <span className="muted" style={{ fontSize: 12 }}>top {Math.round(10)}% · &ge;{congestionAlerts.thresholdPicksPerDay}/day</span>
            </div>
            {congestionAlerts.alerts.map((a, i) => (
              <AccentRow
                key={a.aisleLabel}
                first={i === 0}
                state={a.state}
                title={`Aisle ${friendlyLocation(a.aisleLabel)}`}
                meta={`peak ${a.peakPicksPerDay} picks/day`}
                value={`${a.avgPicksPerDay}/day`}
              />
            ))}
          </div>

          {safetyStock.belowCount > 0 && (
            <div className="card">
              <div className="card__head" style={{ justifyContent: 'space-between' }}>
                <h2>Below Safety Stock</h2>
                <span className="muted" style={{ fontSize: 12 }}>{safetyStock.belowCount} locations · 1.65·σ·√L</span>
              </div>
              {safetyStock.rows.slice(0, 5).map((s, i) => (
                <AccentRow
                  key={`${s.productId}-${s.locationCode}`}
                  first={i === 0}
                  state="critical"
                  title={s.name}
                  meta={friendlyLocation(s.locationCode)}
                  value={`${s.onHand} / SS ${s.safetyStock}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
