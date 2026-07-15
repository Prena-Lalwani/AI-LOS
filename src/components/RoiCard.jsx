/**
 * RoiCard — a compact "business value / ROI" banner shown on each module page.
 * Each item is a value + label + short mechanism note, colored by state.
 * Figures are conservative estimates on the modeled POC operation; where a page
 * has live numbers (overstock $, load factor, risk counts) they're passed in.
 *
 *   items = [{ value: '$53K/yr', label: 'Overstock carrying', note: '…', state: 'flow' }]
 */
export default function RoiCard({ subtitle, items, footnote }) {
  return (
    <div className="card roi-card">
      <div className="card__head">
        <span className="roi-chip">ROI</span>
        <h2 style={{ flex: 1 }}>Business Value</h2>
        {subtitle && <span className="muted" style={{ fontSize: 12 }}>{subtitle}</span>}
      </div>
      <div className="roi-grid">
        {items.map((it) => (
          <div className={`roi-item s-${it.state || 'flow'}`} key={it.label}>
            <div className={`roi-value s-${it.state || 'flow'}`}>{it.value}</div>
            <div className="roi-label">{it.label}</div>
            {it.note && <div className="roi-note">{it.note}</div>}
          </div>
        ))}
      </div>
      {footnote && <div className="muted roi-foot">{footnote}</div>}
    </div>
  );
}
