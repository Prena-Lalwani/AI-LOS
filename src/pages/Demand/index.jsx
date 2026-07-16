import { useEffect, useState } from 'react';
import PageHeader from '../../components/PageHeader.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import TrendChart from '../../components/TrendChart.jsx';
import DataTable from '../../components/DataTable.jsx';
import RoiCard from '../../components/RoiCard.jsx';
import { API_BASE } from '../../api.js';

// Live data source: the FastAPI + Prophet backend (see backend/). Falls back to
// an error card if the server isn't running.
const API_URL = `${API_BASE}/api/demand/forecast`;

// --- adapters: map the API shapes onto the props the existing components expect ---
function formatKpiValue(value, unit) {
  if (unit === '%') return `${value}%`;
  if (typeof value === 'number') return value.toLocaleString('en-US');
  return value; // string values (e.g. a season name) pass through
}
function formatKpiDelta(delta, unit) {
  const sign = delta > 0 ? '+' : '';
  const suffix = unit === '%' ? ' pts vs prior' : '% vs prior';
  return `${sign}${delta}${suffix}`;
}
const kpiState = (delta) => (delta > 0 ? 'flow' : delta < 0 ? 'attention' : 'neutral');

export default function Demand() {
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
      title="Order & Demand Intelligence"
      subtitle={
        data
          ? 'Prophet weekly demand forecast · capacity planning'
          : 'Forecasting & capacity planning · Prophet model'
      }
    />
  );

  if (error) {
    return (
      <>
        {header}
        <div className="card" style={{ maxWidth: 640 }}>
          <h2 style={{ marginBottom: 8 }}>Demand API unavailable</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            Could not reach the forecast service at <span className="mono">{API_URL}</span> ({error}).
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
        <div className="muted" style={{ padding: '48px 4px', fontSize: 14 }}>Loading demand intelligence…</div>
      </>
    );
  }

  // KPIs -> KpiCard props (the model-accuracy KPI is intentionally not shown)
  const kpis = data.kpis
    .filter((k) => k.label !== 'Forecast Accuracy')
    .map((k) => ({
      label: k.label,
      value: formatKpiValue(k.value, k.unit),
      delta: formatKpiDelta(k.delta, k.unit),
      state: kpiState(k.delta),
    }));

  // Chart: recent weekly actuals + the recursive 4-week forecast.
  // The last actual week carries BOTH `actual` and `forecast` (= actual) so the
  // two lines join at one shared point instead of leaving a gap.
  const hist = data.weeklyTrend.slice(-26);
  const boundaryLabel = hist[hist.length - 1].weekStart;
  const lastActual = hist[hist.length - 1].actual;
  const chartData = hist.map((d, i) => ({
    label: d.weekStart,
    actual: d.actual,
    forecast: i === hist.length - 1 ? d.actual : null,
    // shaded confidence band starts as a point at the boundary, then widens
    range: i === hist.length - 1 ? [d.actual, d.actual] : null,
  }));
  data.forecast.forEach((f) => chartData.push({
    label: f.weekStart, actual: null, forecast: f.projected, range: [f.lower, f.upper],
  }));
  // zoom the y-axis to the data range so the band + week-to-week movement are visible
  const yVals = [...hist.map((d) => d.actual), ...data.forecast.flatMap((f) => [f.lower, f.upper])];
  const yLo = Math.min(...yVals);
  const yHi = Math.max(...yVals);
  const yPad = (yHi - yLo) * 0.25 || 1000;
  const yDomain = [Math.floor((yLo - yPad) / 1000) * 1000, Math.ceil((yHi + yPad) / 1000) * 1000];

  // Upcoming-forecast table (next 4 weeks with Prophet's uncertainty band)
  const forecastCols = [
    { header: 'Week of', cell: (r) => <span className="mono muted">{r.weekStart}</span> },
    { header: 'Projected', cell: (r) => <span className="mono">{Math.round(r.projected).toLocaleString()}</span> },
    { header: 'Low', cell: (r) => <span className="mono muted">{Math.round(r.lower).toLocaleString()}</span> },
    { header: 'High', cell: (r) => <span className="mono muted">{Math.round(r.upper).toLocaleString()}</span> },
  ];
  const upcoming = data.forecast;

  const topSeason = data.seasonalBreakdown[0];
  const topCategory = data.categoryBreakdown[0];
  const topRegion = data.regionBreakdown[0];

  return (
    <>
      {header}

      <RoiCard
        subtitle="Forecast → capacity planning"
        items={[
          { value: '~$28K/yr', label: 'Demand-driven staffing', note: 'right-size crews & trucks to the forecast (~5% labour flex)' },
          { value: '4-week', label: 'Forecast horizon', note: 'weekly demand projection to plan crews & trucks ahead of peaks' },
          { value: 'Peak-ready', label: 'Capacity planning', note: 'auto crew/truck recommendation ahead of demand peaks' },
        ]}
        footnote="Savings are conservative estimates on the modeled operation."
      />

      <div className="kpi-grid">
        {kpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </div>

      <div className="split">
        <div className="col">
          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Demand Forecast</h2>
              <div className="legend">
                <span className="legend__item"><span className="legend__line" style={{ background: 'var(--accent-flow)' }} />Actual</span>
                <span className="legend__item"><span className="legend__line" style={{ background: 'var(--accent-attention)' }} />Forecast</span>
                <span className="legend__item">Next 4 weeks</span>
              </div>
            </div>
            <TrendChart
              data={chartData}
              xKey="label"
              yFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)}
              yDomain={yDomain}
              refLine={{ x: boundaryLabel }}
              band={{ key: 'range', color: 'var(--accent-attention)' }}
              series={[
                { key: 'actual', color: 'var(--accent-flow)', width: 2 },
                { key: 'forecast', color: 'var(--accent-attention)', width: 2, dashed: true },
              ]}
            />
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 12 }}>Upcoming Forecast · next 4 weeks</h2>
            <DataTable
              columns={forecastCols}
              rows={upcoming}
              keyField="weekStart"
              template="1.4fr 1fr 1fr 1fr"
            />
          </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="card__head">
              <span className="ai-chip">AI</span>
              <h2>Capacity Actions</h2>
            </div>
            {data.recommendations.map((r) => (
              <div className="rec-row" key={r.title}>
                <span className={`rec-accent s-${r.state}`} />
                <div className="rec-body">
                  <div className="rec-title">{r.title}</div>
                  <div className="rec-impact">{r.impact}</div>
                </div>
                <button className="btn btn--sm">Apply</button>
              </div>
            ))}
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 10 }}>Seasonal Demand</h2>
            <div className="stat stat--attention" style={{ marginBottom: 12 }}>
              <div className="stat__label">Peak season</div>
              <div className="stat__value s-attention">{topSeason.season}</div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {topSeason.sharePct}% of units · {Math.round(topSeason.avgDailyUnits).toLocaleString()}/day
              </div>
            </div>
            {data.seasonalBreakdown.map((s) => (
              <div className="subscore" key={s.season}>
                <span className="subscore__label">{s.season}</span>
                <span className="bar"><span className="bar__fill s-flow" style={{ width: `${s.sharePct}%` }} /></span>
                <span className="subscore__value">{s.sharePct}</span>
              </div>
            ))}
            <div className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>
              Top category <strong>{topCategory.category}</strong> · top region <strong>{topRegion.region}</strong>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
