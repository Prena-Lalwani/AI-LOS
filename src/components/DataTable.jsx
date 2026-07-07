/**
 * DataTable — lightweight grid table. Column widths come from `template`
 * (a CSS grid-template-columns string). Each column provides a `cell` render
 * function so callers can format IDs/timestamps in monospace, render status
 * dots, action buttons, etc.
 *
 *   columns = [{ header: 'Truck', cell: (row) => <span className="mono">{row.truck}</span> }]
 */
export default function DataTable({ columns, rows, template, keyField }) {
  const gridTemplate = template || `repeat(${columns.length}, 1fr)`;
  return (
    <div className="dtable">
      <div className="dtable__head" style={{ gridTemplateColumns: gridTemplate }}>
        {columns.map((c, i) => (
          <span key={i}>{c.header}</span>
        ))}
      </div>
      {rows.map((row, ri) => (
        <div className="dtable__row" style={{ gridTemplateColumns: gridTemplate }} key={keyField ? row[keyField] : ri}>
          {columns.map((c, ci) => (
            <span key={ci}>{c.cell(row)}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Helper for the common status cell: colored dot + label. */
export function StatusCell({ state, label }) {
  return (
    <span className={`status-cell s-${state}`}>
      <span className={`dot s-${state}`} />
      {label}
    </span>
  );
}
