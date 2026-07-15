/**
 * Metric — a small bordered stat box (label / big value / optional sub-line),
 * colored by semantic state. Used across the truck & driver detail pages.
 * MetricGrid lays a set of them out in a responsive auto-fit grid.
 */
export function Metric({ label, value, sub, state }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div
        className={state ? `s-${state}` : undefined}
        style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 21, lineHeight: 1.1, wordBreak: 'break-word' }}
      >
        {value}
      </div>
      {sub && <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function MetricGrid({ children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 10 }}>
      {children}
    </div>
  );
}
