import PageHeader from '../../components/PageHeader.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import HealthScoreRing from '../../components/HealthScoreRing.jsx';
import AlertList from '../../components/AlertList.jsx';
import TrendChart from '../../components/TrendChart.jsx';
import ModuleCard from '../../components/ModuleCard.jsx';
import RoiCard from '../../components/RoiCard.jsx';
import { MODULES } from '../../modules.js';
// Real data layer generated from the DataCo dataset (scripts/buildExecIntelligence.mjs).
import execData from '../../data/execIntelligenceData.json';
// Only the recommendation cards remain illustrative fixtures — the summary,
// summary stats and health sub-scores are now derived from execData below.
import { recommendations } from '../../data/exec.js';

const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const HEALTH_THRESHOLD = 75; // network health at/above this reads as on-track (teal)

/** '2023-07' -> 'Jul 2023' for the trend legend. */
function formatMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
/** signed % / points string for the narrative (e.g. -34.2 -> '−34.2%'). */
const signed = (n, suffix) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}${suffix}`;
const fmtM = (v) => `$${(v / 1e6).toFixed(1)}M`;

// --- adapters: map the JSON shapes onto the props the existing components expect ---
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** { value, unit } -> display string. '$' = currency, '%' = percent, else grouped number. */
function formatKpiValue(value, unit) {
  if (unit === '$') return usd.format(value);
  if (unit === '%') return `${value}%`;
  return value.toLocaleString('en-US');
}

/** Month-over-month delta -> KpiCard delta string ('%' KPIs move in points, others in %). */
function formatKpiDelta(delta, unit) {
  const sign = delta > 0 ? '+' : '';
  const suffix = unit === '%' ? ' pts vs last mo' : '% vs last mo';
  return `${sign}${delta}${suffix}`;
}

/** Positive delta reads as flowing (teal); negative needs attention (amber); flat = neutral. */
const kpiState = (delta) => (delta > 0 ? 'flow' : delta < 0 ? 'attention' : 'neutral');

/** alert severity -> the state token AlertList's dot uses. */
const severityToState = { red: 'critical', amber: 'attention', teal: 'flow' };

/** ISO timestamp -> compact relative label, matching the ribbon's short "2m / 1h" style. */
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  let s = Math.max(0, (Date.now() - then) / 1000);
  const units = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
  for (const [label, secs] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n}${label} ago`;
  }
  return 'just now';
}

export default function Executive() {
  // KPIs / alerts / trend derived from the real data layer via the adapters above.
  const kpis = execData.kpis.map((k) => ({
    label: k.label,
    value: formatKpiValue(k.value, k.unit),
    delta: formatKpiDelta(k.delta, k.unit),
    state: kpiState(k.delta),
  }));

  const alerts = execData.alerts.map((a) => ({
    text: a.message,
    time: timeAgo(a.timestamp),
    severity: severityToState[a.severity] || 'neutral',
  }));

  // Chart values scaled to $M so the existing "$…M" axis styling still reads cleanly.
  const trend = execData.trend.map((t) => ({ month: t.month, revenue: t.revenue / 1e6, profit: t.profit / 1e6 }));
  const revMax = Math.max(...trend.map((t) => t.revenue));
  const yMax = Math.ceil(revMax * 5) / 5; // round up to the next 0.2 for axis headroom
  const trendRange = execData.trend.length
    ? `${formatMonth(execData.trend[0].month)} – ${formatMonth(execData.trend.at(-1).month)}`
    : '';

  // --- everything below is derived from the real data layer, so the narrative,
  //     stat boxes and health bars can never contradict the KPI cards above. ---
  const byLabel = Object.fromEntries(execData.kpis.map((k) => [k.label, k]));
  const revenue = byLabel['Total Revenue'];
  const profit = byLabel['Total Profit'];
  const onTime = byLabel['On-Time Delivery'];
  const orders = byLabel['Total Orders'];
  const marginPct = revenue && profit ? (profit.value / revenue.value) * 100 : 0;

  const healthScore = execData.healthScore;
  const aboveTarget = healthScore >= HEALTH_THRESHOLD;

  // regions ranked by revenue → drives the honest health sub-scores + narrative
  const regionsBySales = [...execData.regions].sort((a, b) => b.sales - a.sales);
  const topRegion = regionsBySales[0];
  const onTimeVals = execData.regions.map((r) => r.onTimePct);
  const otMin = Math.min(...onTimeVals);
  const otMax = Math.max(...onTimeVals);

  // sub-score bars = on-time delivery for the three biggest markets by revenue —
  // real numbers that explain why the network score sits where it does.
  const subScores = regionsBySales.slice(0, 3).map((r) => ({
    label: r.region,
    val: Math.round(r.onTimePct),
    state: r.onTimePct >= HEALTH_THRESHOLD ? 'flow' : 'attention',
  }));

  // stat boxes inside the summary card, consistent with the ring + KPIs
  const openExceptions = alerts.filter((a) => a.severity !== 'flow').length;
  const summaryStats = [
    { label: 'Network Health', value: String(healthScore), suffix: ' /100', variant: aboveTarget ? 'flow' : 'attention' },
    { label: 'On-Time Delivery', value: `${onTime?.value ?? '—'}%`, variant: (onTime?.value ?? 0) >= HEALTH_THRESHOLD ? 'flow' : 'attention' },
    { label: openExceptions ? 'Open Exceptions' : 'Active Alerts', value: String(openExceptions || alerts.length), variant: openExceptions ? 'attention' : 'flow' },
  ];

  return (
    <>
      <PageHeader
        title="Executive Intelligence"
        subtitle={`Live operational overview · ${today} · Northeast & Midwest network`}
      />

      <RoiCard
        subtitle="Platform-wide, conservative"
        items={[
          { value: '+16–24%', label: 'Net-profit lift', note: 'logistics savings across all modules flow to the bottom line' },
          { value: '$212K', label: 'Working capital freed', state: 'attention', note: 'one-time — cash tied up in overstock' },
          { value: '$124K', label: 'Per 1% on-time gain', note: `on-time delivery ${onTime.value}% → 80% target lifts retention & SLA` },
        ]}
        footnote="Estimated on the modeled operation (~$12.4M revenue/yr). Conservative & illustrative — scales with real volume. Each module page shows its own levers."
      />

      <div className="kpi-grid">
        {kpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </div>

      <div className="split">
        <div className="col">
          <div className="card">
            <div className="card__head">
              <span className="ai-chip">AI</span>
              <h2 style={{ flex: 1 }}>Daily Summary</h2>
            </div>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.62 }}>
              Network health is <strong>{healthScore} / 100</strong>, {aboveTarget ? 'above' : 'below'} the {HEALTH_THRESHOLD} target.
              The primary drag is on-time delivery at <strong>{onTime.value}%</strong> ({signed(onTime.delta, ' pts')} vs last period),
              and it holds within a tight <strong>{otMin}–{otMax}%</strong> band across every region — a systemic process gap,
              not a local one. Revenue of <strong>{fmtM(revenue.value)}</strong> ({signed(revenue.delta, '%')}) and profit
              of <strong>{fmtM(profit.value)}</strong> ({signed(profit.delta, '%')}) hold operating margin at
              {' '}<strong>{marginPct.toFixed(1)}%</strong> across {orders.value.toLocaleString()} orders. {topRegion.region} is
              the largest market at {fmtM(topRegion.sales)}. Recovering on-time delivery is the highest-leverage move —
              each point regained flows straight to retention and margin.
            </p>
            <div className="summary-stats">
              {summaryStats.map((s) => (
                <div className={`stat stat--${s.variant}`} key={s.label}>
                  <div className="stat__label">{s.label}</div>
                  <div className={`stat__value s-${s.variant}`}>
                    {s.value}
                    {s.suffix && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{s.suffix}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Revenue vs Profit</h2>
              <div className="legend">
                <span className="legend__item"><span className="legend__line" style={{ background: 'var(--accent-flow)' }} />Revenue</span>
                <span className="legend__item"><span className="legend__line" style={{ background: 'var(--accent-attention)' }} />Profit</span>
                <span className="legend__item">{trendRange}</span>
              </div>
            </div>
            <TrendChart
              data={trend}
              xKey="month"
              yDomain={[0, yMax]}
              yFormatter={(v) => `$${v.toFixed(1)}M`}
              emphasizeLast
              area={{ key: 'revenue', color: 'var(--accent-flow-bg)' }}
              series={[
                { key: 'profit', color: 'var(--accent-attention)', width: 2 },
                { key: 'revenue', color: 'var(--accent-flow)', width: 2.2 },
              ]}
            />
          </div>
        </div>

        <div className="col">
          <div className="card">
            <h2 style={{ marginBottom: 10 }}>Operational Health</h2>
            <HealthScoreRing score={healthScore} threshold={HEALTH_THRESHOLD} />
            <div className="muted" style={{ fontSize: 11, margin: '2px 0 10px' }}>
              On-time delivery · top {subScores.length} markets by revenue
            </div>
            {subScores.map((s) => (
              <div className="subscore" key={s.label}>
                <span className="subscore__label">{s.label}</span>
                <span className="bar"><span className={`bar__fill s-${s.state}`} style={{ width: `${s.val}%` }} /></span>
                <span className="subscore__value">{s.val}%</span>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card__head" style={{ justifyContent: 'space-between' }}>
              <h2>Active Alerts</h2>
            </div>
            <AlertList alerts={alerts} />
          </div>

          <div className="card">
            <div className="card__head">
              <span className="ai-chip">AI</span>
              <h2>Recommendations</h2>
            </div>
            {recommendations.map((r) => (
              <div className="rec-row" key={r.title}>
                <span className={`rec-accent s-${r.state}`} />
                <div className="rec-body">
                  <div className="rec-title">{r.title}</div>
                  <div className="rec-impact">{r.impact}</div>
                </div>
                <button className="btn btn--sm">Review</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="section-title">Explore Modules</div>
      <div className="module-grid">
        {MODULES.filter((m) => m.path !== '/').map((m) => (
          <ModuleCard key={m.path} icon={m.icon} title={m.short} desc={m.desc} to={m.path} />
        ))}
      </div>
    </>
  );
}
