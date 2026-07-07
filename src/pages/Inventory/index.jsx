import { useEffect, useState } from 'react';
import PageHeader from '../../components/PageHeader.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import DataTable, { StatusCell } from '../../components/DataTable.jsx';
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
          ? `${data.kpis[0]?.value} SKUs · 3 facilities · stock-out model ${data.stockOutPredictions.modelMetrics.accuracy}% acc · live`
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
    warehouseHeatmap, congestionAlerts, pickingRouteExample } = data;
  const primary = warehouseHeatmap.warehouses.find((w) => w.warehouseId === warehouseHeatmap.primary)
    || warehouseHeatmap.warehouses[0];

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

      <div className="kpi-grid">
        {data.kpis.map((k) => (
          <KpiCard key={k.label} label={k.label} value={String(k.value)} delta={k.delta} state={k.state} />
        ))}
      </div>

      <div className="split">
        <div className="col">
          <div className="card">
            <div className="card__head">              <h2>Reorder Recommendations</h2>
              <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                {reorderRecommendations.flaggedCount} flagged · EOQ · 7-day lead time
              </span>
            </div>
            <DataTable columns={columns} rows={reorderRows} keyField="id" template="1.6fr 1.3fr .7fr .7fr .8fr 1.1fr" />
          </div>

          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Warehouse Heatmap · {primary.name}</h2>
              <div className="legend">
                <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--accent-flow-bg)' }} />Idle</span>
                <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--accent-flow)' }} />Normal</span>
                <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--accent-attention-bg)' }} />Busy</span>
                <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--accent-attention)' }} />Congested</span>
              </div>
            </div>
            <div className="heatmap" style={{ gridTemplateColumns: `repeat(${primary.aisles}, 1fr)` }}>
              {primary.cells.map((c) => (
                <div key={`${c.zone}-${c.aisle}`} className={`heat-cell ${heatBucket(c.utilization)}`}
                  style={{ flexDirection: 'column', gap: 1, lineHeight: 1 }}
                  title={`${String.fromCharCode(64 + c.zone)}${c.aisle} · Zone ${c.zone} · Aisle ${c.aisle} — avg inv ${c.avgInventory}, ${c.pickCount} picks`}>
                  <span style={{ fontWeight: 600 }}>{`${String.fromCharCode(64 + c.zone)}${c.aisle}`}</span>
                  <span style={{ opacity: 0.7, fontSize: 9 }}>{c.utilization}</span>
                </div>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Occupancy (avg inventory) blended with pick activity across {primary.zones} zones × {primary.aisles} aisles.
              Each cell is labelled Zone letter + Aisle number (e.g. B3) with its utilization below.
            </div>
          </div>

          <div className="card">
            <div className="card__head">              <h2>Picking Route Optimization · {pickingRouteExample.warehouseId}</h2>
            </div>
            <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 12 }}>
              <KpiCard label="Distance Saved" value={`${pickingRouteExample.distanceSavedPct}%`} state="flow" />
              <KpiCard label="Time Saved" value={`${pickingRouteExample.timeSavedPct}%`} state="flow" />
              <KpiCard label="Stops" value={String(pickingRouteExample.stops)} state="neutral" />
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              <div><strong>OR-Tools TSP:</strong> <span className="mono">{pickingRouteExample.optimizedSequence.map(friendlyLocation).join(' → ')}</span></div>
              <div style={{ marginTop: 4 }}><strong>Naive picklist:</strong> <span className="mono">{pickingRouteExample.naiveSequence.map(friendlyLocation).join(' → ')}</span></div>
              <div style={{ marginTop: 6 }}>
                {pickingRouteExample.optimizedDistance} vs {pickingRouteExample.naiveDistance} distance units ·
                {' '}{pickingRouteExample.optimizedDurationSec}s vs {pickingRouteExample.naiveDurationSec}s
              </div>
            </div>
          </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Stock-Out Prediction</h2>
              <span className="muted" style={{ fontSize: 12 }}>{stockOutPredictions.atRiskCount} at risk · next 7 days</span>
            </div>
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
