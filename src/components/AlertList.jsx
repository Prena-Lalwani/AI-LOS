/**
 * AlertList — compact alert rows, each with a severity dot.
 * severity: 'flow' | 'attention' | 'critical' (red reserved for blocking only).
 */
export default function AlertList({ alerts = [] }) {
  return (
    <div>
      {alerts.map((a, i) => (
        <div className="alert-row" key={i}>
          <span className={`dot s-${a.severity}`} />
          <span className="alert-row__text">{a.text}</span>
          <span className="alert-row__time">{a.time}</span>
        </div>
      ))}
    </div>
  );
}
