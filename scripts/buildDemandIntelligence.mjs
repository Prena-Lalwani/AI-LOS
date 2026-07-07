/* ===========================================================================
 * buildDemandIntelligence.mjs
 * ---------------------------------------------------------------------------
 * Reads the retail store inventory CSV and produces a single JSON file
 * (src/data/demandIntelligenceData.json) for the Order & Demand Intelligence
 * page: { kpis, dailyTrend, weeklyTrend, monthlyTrend, seasonalBreakdown,
 *         categoryBreakdown, regionBreakdown, forecast, recommendations }.
 *
 * Run:  npm run data:demand    (or)  node scripts/buildDemandIntelligence.mjs
 *
 * Same conventions as scripts/buildExecIntelligence.mjs:
 *  - Read as latin1 to survive any non-UTF8 bytes.
 *  - Dependency-free, quote-aware CSV parser; columns addressed by header name.
 *
 * DATE OFFSET (display only)
 *  - The source dataset spans 2022-01-01 to 2024-01-01. To make the dashboard
 *    look current, every output date is shifted forward by a fixed number of
 *    months so the latest data month lands on the current real-world month
 *    (computed dynamically via new Date(), so it stays current on every re-run).
 *  - The shift is uniform across the historical series (daily/weekly/monthly)
 *    AND the 90-day forward forecast, so the trend ends at "today" and the
 *    forecast genuinely extends into the future. All relative gaps, seasonality
 *    and growth stay identical — ONLY date labels change; units, prices,
 *    percentages, category/region names and every other field are untouched.
 * =========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'Datasets', 'Demand Intelligence', 'retail_store_inventory.csv');
const OUT_PATH = path.join(ROOT, 'src', 'data', 'demandIntelligenceData.json');

// --- tunable business constants (easy to adjust later) ---------------------
const UNITS_PER_WORKER_PER_DAY = 500;   // 1 warehouse worker per 500 projected units/day
const UNITS_PER_TRUCK_PER_DAY = 2000;   // 1 truck per 2,000 projected units/day
const FORECAST_HORIZON_DAYS = 90;       // length of the forward projection

// --- helpers ---------------------------------------------------------------

/** Quote-aware CSV row generator (handles "" escapes, quoted commas, CRLF). */
function* parseCSV(str) {
  let field = '';
  let row = [];
  let inQuotes = false;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const ch = str[i];
    if (inQuotes) {
      if (ch === '"') {
        if (str[i + 1] === '"') { field += '"'; i++; }
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
const pctChange = (curr, prev) => (prev ? round(((curr - prev) / Math.abs(prev)) * 100, 1) : 0);
const pad2 = (x) => String(x).padStart(2, '0');
const daysInMonth = (y, m) => new Date(y, m, 0).getDate(); // m is 1-12

/** Shift a "YYYY-MM" key forward by `offset` months. */
function shiftMonthKey(key, offset) {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + offset;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}

/** Shift a "YYYY-MM-DD" date forward by `offset` months (day clamped). Label-only. */
function shiftDateStr(str, offset) {
  const [y, m, d] = str.split('-').map(Number);
  const total = y * 12 + (m - 1) + offset;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${pad2(nm)}-${pad2(nd)}`;
}

const fmtDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
/** Monday-of-week (YYYY-MM-DD) for a given date, using local Date math. */
function weekStartOf(y, m, d) {
  const dt = new Date(y, m - 1, d);
  const back = (dt.getDay() + 6) % 7; // 0=Mon … 6=Sun
  dt.setDate(dt.getDate() - back);
  return fmtDate(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

// --- read + parse ----------------------------------------------------------

console.log(`Reading ${path.relative(ROOT, CSV_PATH)} (latin1)…`);
const raw = fs.readFileSync(CSV_PATH, 'latin1');
const rows = parseCSV(raw);

const header = rows.next().value;
if (!header) throw new Error('CSV appears to be empty.');
const col = {};
header.forEach((name, i) => { col[name.trim()] = i; });

const need = ['Date', 'Units Sold', 'Demand Forecast', 'Category', 'Region', 'Seasonality'];
for (const c of need) {
  if (col[c] === undefined) throw new Error(`Missing expected column: "${c}"`);
}
const iDate = col['Date'];
const iUnits = col['Units Sold'];
const iForecast = col['Demand Forecast'];
const iCategory = col['Category'];
const iRegion = col['Region'];
const iSeason = col['Seasonality'];

// --- accumulate ------------------------------------------------------------

const daily = new Map();     // "YYYY-MM-DD" -> { actual, forecast }
const category = new Map();  // name -> units
const region = new Map();    // name -> units
const season = new Map();    // name -> { units, days:Set }
const yearUnits = new Map(); // year -> units (for YoY growth)

let totalUnits = 0;
let totalRows = 0;
let minDate = '9999-99-99';
let maxDate = '0000-00-00';

for (const r of rows) {
  if (r.length === 1 && r[0] === '') continue;
  if (r.length < header.length) continue;

  const dateStr = (r[iDate] || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
  const units = toNum(r[iUnits]);
  const forecast = toNum(r[iForecast]);
  const cat = (r[iCategory] || 'Unknown').trim();
  const reg = (r[iRegion] || 'Unknown').trim();
  const sea = (r[iSeason] || 'Unknown').trim();

  totalUnits += units;
  totalRows += 1;
  if (dateStr < minDate) minDate = dateStr;
  if (dateStr > maxDate) maxDate = dateStr;

  let day = daily.get(dateStr);
  if (!day) { day = { actual: 0, forecast: 0 }; daily.set(dateStr, day); }
  day.actual += units;
  day.forecast += forecast;

  category.set(cat, (category.get(cat) || 0) + units);
  region.set(reg, (region.get(reg) || 0) + units);

  let se = season.get(sea);
  if (!se) { se = { units: 0, days: new Set() }; season.set(sea, se); }
  se.units += units;
  se.days.add(dateStr);

  const yr = Number(dateStr.slice(0, 4));
  yearUnits.set(yr, (yearUnits.get(yr) || 0) + units);
}

const numDays = daily.size;
console.log(`Parsed ${totalRows.toLocaleString()} rows · ${numDays} days (${minDate} → ${maxDate}).`);

// --- date offset (dynamic, display only) -----------------------------------

const now = new Date();
const [latestY, latestM] = maxDate.split('-').map(Number);
const MONTH_OFFSET = (now.getFullYear() - latestY) * 12 + (now.getMonth() + 1 - latestM);
console.log(`Date offset: +${MONTH_OFFSET} months (${latestY}-${pad2(latestM)} -> ${shiftMonthKey(`${latestY}-${pad2(latestM)}`, MONTH_OFFSET)}).`);

// --- historical daily / weekly / monthly series ----------------------------

const sortedDates = [...daily.keys()].sort();

const dailyTrend = sortedDates.map((date) => {
  const d = daily.get(date);
  return { date: shiftDateStr(date, MONTH_OFFSET), actual: round(d.actual), forecast: round(d.forecast) };
});

const weekMap = new Map();  // weekStart -> { actual, forecast }
const monthMap = new Map(); // "YYYY-MM" -> { actual, forecast }
for (const date of sortedDates) {
  const [y, m, d] = date.split('-').map(Number);
  const d0 = daily.get(date);

  const wk = weekStartOf(y, m, d);
  let w = weekMap.get(wk);
  if (!w) { w = { actual: 0, forecast: 0 }; weekMap.set(wk, w); }
  w.actual += d0.actual; w.forecast += d0.forecast;

  const mk = `${y}-${pad2(m)}`;
  let mo = monthMap.get(mk);
  if (!mo) { mo = { actual: 0, forecast: 0 }; monthMap.set(mk, mo); }
  mo.actual += d0.actual; mo.forecast += d0.forecast;
}

const weeklyTrend = [...weekMap.keys()].sort().map((wk) => {
  const w = weekMap.get(wk);
  return { weekStart: shiftDateStr(wk, MONTH_OFFSET), actual: round(w.actual), forecast: round(w.forecast) };
});
const monthlyTrend = [...monthMap.keys()].sort().map((mk) => {
  const mo = monthMap.get(mk);
  return { month: shiftMonthKey(mk, MONTH_OFFSET), actual: round(mo.actual), forecast: round(mo.forecast) };
});

// --- forecast accuracy (daily-total MAPE) ----------------------------------

let mapeSum = 0;
let mapeN = 0;
const monthlyErr = new Map(); // "YYYY-MM" -> { errSum, n }
for (const date of sortedDates) {
  const { actual, forecast } = daily.get(date);
  if (actual <= 0) continue;
  const err = Math.abs(actual - forecast) / actual;
  mapeSum += err; mapeN += 1;
  const mk = date.slice(0, 7);
  let me = monthlyErr.get(mk);
  if (!me) { me = { errSum: 0, n: 0 }; monthlyErr.set(mk, me); }
  me.errSum += err; me.n += 1;
}
const mape = mapeN ? (mapeSum / mapeN) * 100 : 0;
const forecastAccuracy = Math.max(0, 100 - mape);

const errMonths = [...monthlyErr.keys()].sort();
const accOf = (mk) => { const me = monthlyErr.get(mk); return me && me.n ? 100 - (me.errSum / me.n) * 100 : 0; };
const accRecent = errMonths.length ? accOf(errMonths[errMonths.length - 1]) : 0;
const accPrior = errMonths.length > 1 ? accOf(errMonths[errMonths.length - 2]) : 0;

// --- seasonal / category / region breakdowns -------------------------------

const grandUnits = totalUnits;
const seasonalBreakdown = [...season.entries()]
  .map(([name, s]) => ({
    season: name,
    totalUnits: round(s.units),
    avgDailyUnits: round(s.days.size ? s.units / s.days.size : 0),
    sharePct: round(grandUnits ? (s.units / grandUnits) * 100 : 0, 1),
  }))
  .sort((a, b) => b.totalUnits - a.totalUnits);

const categoryBreakdown = [...category.entries()]
  .map(([name, units]) => ({ category: name, unitsSold: round(units) }))
  .sort((a, b) => b.unitsSold - a.unitsSold);

const regionBreakdown = [...region.entries()]
  .map(([name, units]) => ({ region: name, unitsSold: round(units) }))
  .sort((a, b) => b.unitsSold - a.unitsSold);

// --- year-over-year growth (last two full years) ---------------------------

const fullYears = [...yearUnits.keys()].filter((y) => {
  // a "full" year: has data for both Jan and Dec
  return daily.has(`${y}-01-01`) && [...daily.keys()].some((d) => d.startsWith(`${y}-12`));
}).sort();
const y2 = fullYears[fullYears.length - 1];
const y1 = fullYears[fullYears.length - 2];
const yoyGrowth = (y1 && y2 && yearUnits.get(y1)) ? (yearUnits.get(y2) / yearUnits.get(y1)) - 1 : 0;

// --- seasonal-naive 90-day forward forecast --------------------------------
// base = avg daily total for (prior year, same month, same day-of-week);
// projected = base * (1 + YoY growth). Built on the ORIGINAL timeline, then
// shifted forward with everything else.

const ymdow = new Map(); // "year-month-dow" -> { sum, count } of daily totals
for (const date of sortedDates) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const key = `${y}-${m}-${dow}`;
  let e = ymdow.get(key);
  if (!e) { e = { sum: 0, count: 0 }; ymdow.set(key, e); }
  e.sum += daily.get(date).actual; e.count += 1;
}
const overallAvgDaily = numDays ? totalUnits / numDays : 0;

const [ly, lm, ld] = maxDate.split('-').map(Number);
const forecast = [];
for (let i = 1; i <= FORECAST_HORIZON_DAYS; i++) {
  const fd = new Date(ly, lm - 1, ld);
  fd.setDate(fd.getDate() + i);
  const fy = fd.getFullYear();
  const fm = fd.getMonth() + 1;
  const fdow = fd.getDay();
  const key = `${fy - 1}-${fm}-${fdow}`; // same day-of-week & month, prior year
  const e = ymdow.get(key);
  const base = e && e.count ? e.sum / e.count : overallAvgDaily;
  const projected = round(base * (1 + yoyGrowth));
  const origDate = fmtDate(fy, fm, fd.getDate());
  forecast.push({ date: shiftDateStr(origDate, MONTH_OFFSET), projected });
}

// --- workforce / truck recommendations -------------------------------------

const projValues = forecast.map((f) => f.projected);
const avgProjDaily = projValues.reduce((a, b) => a + b, 0) / (projValues.length || 1);
let peakProjDaily = 0;
let peakDate = forecast[0]?.date || null;
for (const f of forecast) if (f.projected > peakProjDaily) { peakProjDaily = f.projected; peakDate = f.date; }

const workers = Math.ceil(avgProjDaily / UNITS_PER_WORKER_PER_DAY);
const trucks = Math.ceil(avgProjDaily / UNITS_PER_TRUCK_PER_DAY);
const peakWorkers = Math.ceil(peakProjDaily / UNITS_PER_WORKER_PER_DAY);
const peakTrucks = Math.ceil(peakProjDaily / UNITS_PER_TRUCK_PER_DAY);

const recommendations = [
  {
    title: `Staff ${workers} warehouse workers/day`,
    impact: `Baseline for ~${Math.round(avgProjDaily).toLocaleString()} projected units/day · 1 per ${UNITS_PER_WORKER_PER_DAY}`,
    state: 'flow',
  },
  {
    title: `Dispatch ${trucks} trucks/day`,
    impact: `Baseline for ~${Math.round(avgProjDaily).toLocaleString()} projected units/day · 1 per ${UNITS_PER_TRUCK_PER_DAY.toLocaleString()}`,
    state: 'flow',
  },
  {
    title: `Scale to ${peakWorkers} workers · ${peakTrucks} trucks on peak day`,
    impact: `Peak ${peakProjDaily.toLocaleString()} projected units on ${peakDate}`,
    state: 'attention',
  },
];

// --- kpis (mirrors the Executive data-layer shape: label/value/delta/unit) --

const sumForecast = projValues.reduce((a, b) => a + b, 0);
const trailing90Actual = sortedDates.slice(-90).reduce((a, d) => a + daily.get(d).actual, 0);

const monthKeysSorted = [...monthMap.keys()].sort();
const recentMonthUnits = monthMap.get(monthKeysSorted[monthKeysSorted.length - 1])?.actual || 0;
const priorMonthUnits = monthKeysSorted.length > 1 ? (monthMap.get(monthKeysSorted[monthKeysSorted.length - 2])?.actual || 0) : 0;

const peakSeason = seasonalBreakdown[0];
const avgSeasonTotal = seasonalBreakdown.reduce((a, s) => a + s.totalUnits, 0) / (seasonalBreakdown.length || 1);

const kpis = [
  { label: 'Forecast Accuracy', value: round(forecastAccuracy, 1), delta: round(accRecent - accPrior, 1), unit: '%' },
  { label: 'Avg Daily Demand', value: round(overallAvgDaily), delta: pctChange(recentMonthUnits, priorMonthUnits), unit: '' },
  { label: 'Next 90d Projected', value: round(sumForecast), delta: pctChange(sumForecast, trailing90Actual), unit: '' },
  { label: 'Peak Season', value: peakSeason ? peakSeason.season : 'n/a', delta: peakSeason ? round((peakSeason.totalUnits / avgSeasonTotal - 1) * 100, 1) : 0, unit: '' },
];

// --- write -----------------------------------------------------------------

const output = {
  kpis,
  dailyTrend,
  weeklyTrend,
  monthlyTrend,
  seasonalBreakdown,
  categoryBreakdown,
  regionBreakdown,
  forecast,
  recommendations,
};
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');

console.log(`\nWrote ${path.relative(ROOT, OUT_PATH)}`);
console.log(`  kpis             : ${kpis.map((k) => `${k.label}=${k.value}${k.unit}`).join(' · ')}`);
console.log(`  dailyTrend       : ${dailyTrend.length} days (${dailyTrend[0]?.date} → ${dailyTrend[dailyTrend.length - 1]?.date})`);
console.log(`  weeklyTrend      : ${weeklyTrend.length} weeks`);
console.log(`  monthlyTrend     : ${monthlyTrend.length} months`);
console.log(`  seasonalBreakdown: ${seasonalBreakdown.map((s) => `${s.season} ${s.sharePct}%`).join(' · ')}`);
console.log(`  categoryBreakdown: ${categoryBreakdown.length} · regionBreakdown: ${regionBreakdown.length}`);
console.log(`  YoY growth       : ${round(yoyGrowth * 100, 2)}% (${y1} → ${y2})`);
console.log(`  forecast         : ${forecast.length} days (${forecast[0]?.date} → ${forecast[forecast.length - 1]?.date})`);
console.log(`  recommendations  : ${recommendations.length}`);
