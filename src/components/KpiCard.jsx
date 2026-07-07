/**
 * KpiCard — label + big Barlow-Condensed number + optional delta badge.
 * `state` ('flow' | 'attention' | 'critical' | 'neutral') colors the delta.
 */
export default function KpiCard({ label, value, delta, state = 'neutral' }) {
  return (
    <div className={`kpi-card kpi-card--${state}`}>
      <span className="kpi-card__label">{label}</span>
      <span className="kpi-card__value">{value}</span>
      {delta != null && <span className={`kpi-card__delta s-${state}`}>{delta}</span>}
    </div>
  );
}
