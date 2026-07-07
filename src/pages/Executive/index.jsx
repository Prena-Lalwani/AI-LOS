import PageHeader from '../../components/PageHeader.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import HealthScoreRing from '../../components/HealthScoreRing.jsx';
import AlertList from '../../components/AlertList.jsx';
import TrendChart from '../../components/TrendChart.jsx';
import ModuleCard from '../../components/ModuleCard.jsx';
import { MODULES } from '../../modules.js';
// Real data layer generated from the DataCo dataset (scripts/buildExecIntelligence.mjs).
import execData from '../../data/execIntelligenceData.json';
// Still-mock fixtures: the health sub-score bars, summary stats, recommendations
// and the narrative Daily Summary aren't produced by the data layer yet.
import { health, summaryStats, recommendations } from '../../data/exec.js';

const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

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

  // Region roll-up has no UI slot on this page yet — available for a future regions view.
  const regions = execData.regions; // eslint-disable-line no-unused-vars

  return (
    <>
      <PageHeader
        title="Executive Intelligence"
        subtitle={`Live operational overview · ${today} · Northeast & Midwest network`}
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
              The network is flowing within target. On-time delivery holds at <strong>94.2%</strong>, up 1.4 points
              week-over-week on improved dwell times at the Columbus and Harrisburg hubs. Two areas need attention:
              fleet utilization slipped to 87% after 3 units entered unplanned maintenance, and cost per mile rose to
              $1.92 on elevated fuel pricing along the I-40 corridor. Revenue is pacing <strong>+8.1% MTD at $4.82M</strong>.
              AI projects on-time recovery to 95.5% tomorrow if 4 tractors are rebalanced from the Midwest hub ahead of
              the Thursday demand peak.
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
                <span className="legend__item">Jan 2015 – Jan 2018</span>
              </div>
            </div>
            <TrendChart
              data={trend}
              xKey="month"
              yDomain={[0, yMax]}
              yFormatter={(v) => `$${v.toFixed(1)}M`}
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
            <HealthScoreRing score={execData.healthScore} threshold={health.threshold} />
            {health.subScores.map((s) => (
              <div className="subscore" key={s.label}>
                <span className="subscore__label">{s.label}</span>
                <span className="bar"><span className={`bar__fill s-${s.state}`} style={{ width: `${s.val}%` }} /></span>
                <span className="subscore__value">{s.val}</span>
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
