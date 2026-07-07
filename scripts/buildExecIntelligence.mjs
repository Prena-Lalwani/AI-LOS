/* ===========================================================================
 * buildExecIntelligence.mjs
 * ---------------------------------------------------------------------------
 * Reads the DataCo supply-chain CSV and produces a single JSON file
 * (src/data/execIntelligenceData.json) shaped for the Executive Intelligence
 * page: { kpis, trend, regions, healthScore, alerts }.
 *
 * Run:  npm run data:exec        (or)  node scripts/buildExecIntelligence.mjs
 *
 * Notes
 *  - The CSV has non-UTF8 bytes in a few text fields (e.g. "Rajastán",
 *    "EE. UU."), so it is read as latin1 / ISO-8859-1 to avoid mangled parses.
 *  - Some fields contain quoted commas, so a proper quote-aware CSV parser is
 *    used (naive comma-splitting misaligns columns) and columns are addressed
 *    by header name, not fixed index.
 *  - No third-party deps — a streaming char parser keeps the 91 MB file cheap.
 *
 * DATE OFFSET (display only)
 *  - The source dataset spans 2015–2018. To make the dashboard look current,
 *    every date is shifted forward by a fixed number of months so the latest
 *    data month lands on the current real-world month (computed dynamically via
 *    new Date(), so it stays current whenever the script is re-run).
 *  - The month offset is applied uniformly to the trend keys and the Order Id
 *    month grouping, so all relative gaps, seasonality and month-over-month deltas
 *    stay mathematically identical. Active-alert timestamps are instead stamped at
 *    recent times relative to now (staggered, deterministic) so the alerts read as
 *    live rather than inheriting a low-activity region's last data date. ONLY date
 *    labels change; dollar values, percentages, region names and every other field
 *    are untouched.
 * =========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'Datasets', 'Executive Intelligence', 'DataCoSupplyChainDataset.csv');
const OUT_PATH = path.join(ROOT, 'src', 'data', 'execIntelligenceData.json');

// --- helpers ---------------------------------------------------------------

/** Quote-aware CSV row generator. Handles "" escapes, quoted commas/newlines,
 *  and CRLF. Yields each record as an array of raw string fields. */
function* parseCSV(str) {
  let field = '';
  let row = [];
  let inQuotes = false;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const ch = str[i];
    if (inQuotes) {
      if (ch === '"') {
        if (str[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      yield row; row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); yield row; }
}

const toNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON) * f) / f;
};
/** month-over-month percentage change, guarded against divide-by-zero. */
const pctChange = (curr, prev) => (prev ? round(((curr - prev) / Math.abs(prev)) * 100, 1) : 0);

const pad2 = (x) => String(x).padStart(2, '0');

/** Shift a "YYYY-MM" key forward by `offset` months. */
function shiftMonthKey(key, offset) {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + offset;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}

/** Local ISO "YYYY-MM-DDTHH:MM:SS" (no timezone suffix) for a Date. */
const localIso = (dt) =>
  `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;

/** Parse "M/D/YYYY H:MM" -> { key: "YYYY-MM", sortable: number, iso: string }.
 *  Built manually (not via Date) so it is timezone-stable and cheap. */
function parseDate(raw) {
  if (!raw) return null;
  const [datePart, timePart = '0:0'] = raw.trim().split(' ');
  const [m, d, y] = datePart.split('/').map((x) => parseInt(x, 10));
  const [hh, mm] = timePart.split(':').map((x) => parseInt(x, 10) || 0);
  if (!y || !m || !d) return null;
  const p = (x) => String(x).padStart(2, '0');
  return {
    key: `${y}-${p(m)}`,
    sortable: y * 100000000 + m * 1000000 + d * 10000 + hh * 100 + mm,
    iso: `${y}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:00`,
  };
}

// --- read + parse ----------------------------------------------------------

console.log(`Reading ${path.relative(ROOT, CSV_PATH)} (latin1)…`);
const raw = fs.readFileSync(CSV_PATH, 'latin1');
const rows = parseCSV(raw);

const header = rows.next().value;
if (!header) throw new Error('CSV appears to be empty.');
const col = {};
header.forEach((name, i) => { col[name.trim()] = i; });

const need = [
  'Sales', 'Order Profit Per Order', 'Late_delivery_risk', 'Order Id',
  'order date (DateOrders)', 'Order Region', 'Order Status',
];
for (const c of need) {
  if (col[c] === undefined) throw new Error(`Missing expected column: "${c}"`);
}

const iSales = col['Sales'];
const iProfit = col['Order Profit Per Order'];
const iLateRisk = col['Late_delivery_risk'];
const iOrderId = col['Order Id'];
const iDate = col['order date (DateOrders)'];
const iRegion = col['Order Region'];
const iStatus = col['Order Status'];

// --- accumulate ------------------------------------------------------------

let totalRevenue = 0;
let totalProfit = 0;
let onTimeRows = 0;
let totalRows = 0;

const monthly = new Map();  // monthKey -> { revenue, profit, onTimeRows, rows }
const orders = new Map();   // orderId  -> { monthKey, status } (one per unique order)
const regions = new Map();  // region   -> { sales, profit, onTimeRows, rows, latestVal, latestIso }

const CANCELLED = new Set(['CANCELED', 'CANCELLED', 'SUSPECTED_FRAUD']);

for (const r of rows) {
  if (r.length === 1 && r[0] === '') continue; // trailing blank line
  if (r.length < header.length) continue;      // guard against short/garbled rows

  const sales = toNum(r[iSales]);
  const profit = toNum(r[iProfit]);
  const onTime = toNum(r[iLateRisk]) === 0 ? 1 : 0;
  const orderId = r[iOrderId];
  const region = (r[iRegion] || 'Unknown').trim();
  const status = (r[iStatus] || '').trim().toUpperCase();
  const dt = parseDate(r[iDate]);

  totalRevenue += sales;
  totalProfit += profit;
  onTimeRows += onTime;
  totalRows += 1;

  // monthly (row-based sums)
  if (dt) {
    let mo = monthly.get(dt.key);
    if (!mo) { mo = { revenue: 0, profit: 0, onTimeRows: 0, rows: 0 }; monthly.set(dt.key, mo); }
    mo.revenue += sales;
    mo.profit += profit;
    mo.onTimeRows += onTime;
    mo.rows += 1;
  }

  // unique orders (status + month captured once per order id)
  if (!orders.has(orderId)) {
    orders.set(orderId, { monthKey: dt ? dt.key : null, status });
  }

  // region roll-up
  let rg = regions.get(region);
  if (!rg) {
    rg = { sales: 0, profit: 0, onTimeRows: 0, rows: 0, latestVal: -1, latestIso: null };
    regions.set(region, rg);
  }
  rg.sales += sales;
  rg.profit += profit;
  rg.onTimeRows += onTime;
  rg.rows += 1;
  if (dt && dt.sortable > rg.latestVal) { rg.latestVal = dt.sortable; rg.latestIso = dt.iso; }
}

console.log(`Parsed ${totalRows.toLocaleString()} rows · ${orders.size.toLocaleString()} unique orders · ${regions.size} regions.`);

// --- derive: overall metrics ----------------------------------------------

const overallOnTimePct = totalRows ? (onTimeRows / totalRows) * 100 : 0;

// month-over-month: most recent vs prior month present in the data
const monthKeys = [...monthly.keys()].sort();
const recentKey = monthKeys[monthKeys.length - 1];
const priorKey = monthKeys[monthKeys.length - 2];
const recent = monthly.get(recentKey);
const prior = priorKey ? monthly.get(priorKey) : null;

// Display-only date offset: how many months forward to move the whole timeline
// so the latest data month lands on the current real-world month. Dynamic per run.
const now = new Date();
const [latestY, latestM] = recentKey.split('-').map(Number);
const MONTH_OFFSET = (now.getFullYear() - latestY) * 12 + (now.getMonth() + 1 - latestM);
console.log(`Date offset: +${MONTH_OFFSET} months (${recentKey} -> ${shiftMonthKey(recentKey, MONTH_OFFSET)}).`);

// unique orders per month (for the Total Orders delta) — grouped on shifted months
const ordersPerMonth = new Map();
for (const { monthKey } of orders.values()) {
  if (!monthKey) continue;
  const shifted = shiftMonthKey(monthKey, MONTH_OFFSET);
  ordersPerMonth.set(shifted, (ordersPerMonth.get(shifted) || 0) + 1);
}
const recentOrders = ordersPerMonth.get(shiftMonthKey(recentKey, MONTH_OFFSET)) || 0;
const priorOrders = priorKey ? (ordersPerMonth.get(shiftMonthKey(priorKey, MONTH_OFFSET)) || 0) : 0;

const onTimePctOf = (m) => (m && m.rows ? (m.onTimeRows / m.rows) * 100 : 0);

// --- kpis ------------------------------------------------------------------

const kpis = [
  {
    label: 'Total Revenue',
    value: round(totalRevenue, 2),
    delta: prior ? pctChange(recent.revenue, prior.revenue) : 0,
    unit: '$',
  },
  {
    label: 'Total Profit',
    value: round(totalProfit, 2),
    delta: prior ? pctChange(recent.profit, prior.profit) : 0,
    unit: '$',
  },
  {
    label: 'On-Time Delivery',
    value: round(overallOnTimePct, 1),
    // percentage-point change month-over-month for a rate metric
    delta: prior ? round(onTimePctOf(recent) - onTimePctOf(prior), 1) : 0,
    unit: '%',
  },
  {
    label: 'Total Orders',
    value: orders.size,
    delta: prior ? pctChange(recentOrders, priorOrders) : 0,
    unit: '',
  },
];

// --- trend (monthly revenue + profit, chronological) -----------------------

const trend = monthKeys.map((month) => {
  const m = monthly.get(month);
  return { month: shiftMonthKey(month, MONTH_OFFSET), revenue: round(m.revenue, 2), profit: round(m.profit, 2) };
});

// --- regions (sorted desc by sales) ---------------------------------------

const regionsOut = [...regions.entries()]
  .map(([region, r]) => ({
    region,
    sales: round(r.sales, 2),
    profit: round(r.profit, 2),
    onTimePct: round(r.rows ? (r.onTimeRows / r.rows) * 100 : 0, 1),
  }))
  .sort((a, b) => b.sales - a.sales);

// --- operational health score (0–100) -------------------------------------

const profitMarginPct = Math.max(0, Math.min(100, totalRevenue ? (totalProfit / totalRevenue) * 100 : 0));
let fulfilledOrders = 0;
for (const { status } of orders.values()) {
  if (!CANCELLED.has(status)) fulfilledOrders += 1;
}
const orderFulfillmentPct = orders.size ? (fulfilledOrders / orders.size) * 100 : 0;

const healthScore = Math.max(0, Math.min(100, Math.round(
  overallOnTimePct * 0.4 + profitMarginPct * 0.3 + orderFulfillmentPct * 0.3,
)));

// --- alerts (generated from the data) -------------------------------------

const alerts = [];
let alertSeq = 0;
const nextId = () => `alert-${++alertSeq}`;
const flagged = new Set();

// red: any region operating at a loss
for (const r of regionsOut) {
  if (r.profit < 0) {
    flagged.add(r.region);
    alerts.push({
      id: nextId(),
      severity: 'red',
      message: `${r.region} is operating at a loss`,
      timestamp: null, // stamped with a recent time after all alerts are built
    });
  }
}

// amber: region on-time more than 15 points below the overall average
for (const r of regionsOut) {
  const gap = overallOnTimePct - r.onTimePct;
  if (gap > 15) {
    flagged.add(r.region);
    alerts.push({
      id: nextId(),
      severity: 'amber',
      message: `${r.region} on-time delivery is ${Math.round(gap)}% below average`,
      timestamp: null, // stamped with a recent time after all alerts are built
    });
  }
}

// teal: a couple of positive callouts for the best above-average performers
const performers = regionsOut
  .filter((r) => !flagged.has(r.region) && r.onTimePct > overallOnTimePct)
  .sort((a, b) => b.onTimePct - a.onTimePct)
  .slice(0, 2);
for (const r of performers) {
  alerts.push({
    id: nextId(),
    severity: 'teal',
    message: `${r.region} on-time delivery is ${Math.round(r.onTimePct - overallOnTimePct)}% above average`,
    timestamp: null, // stamped with a recent time after all alerts are built
  });
}

// Active Alerts should read as live: stamp each at a staggered recent time
// relative to now (deterministic — newest first), not a region's last data date.
const ALERT_STEP_MIN = 43;
alerts.forEach((a, i) => {
  a.timestamp = localIso(new Date(now.getTime() - (i * ALERT_STEP_MIN + 6) * 60000));
});

// --- write -----------------------------------------------------------------

const output = { kpis, trend, regions: regionsOut, healthScore, alerts };
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');

console.log(`\nWrote ${path.relative(ROOT, OUT_PATH)}`);
console.log(`  kpis        : ${kpis.length}`);
console.log(`  trend       : ${trend.length} months (${trend[0]?.month} → ${trend[trend.length - 1]?.month})`);
console.log(`  regions     : ${regionsOut.length}`);
console.log(`  healthScore : ${healthScore}`);
console.log(`  alerts      : ${alerts.length} (${alerts.filter((a) => a.severity === 'red').length} red / ${alerts.filter((a) => a.severity === 'amber').length} amber / ${alerts.filter((a) => a.severity === 'teal').length} teal)`);
