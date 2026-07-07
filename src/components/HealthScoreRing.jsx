/**
 * HealthScoreRing — circular progress ring for the Operational Health Score.
 * Ring is teal at/above `threshold`, amber below it.
 */
export default function HealthScoreRing({ score = 82, threshold = 75, size = 150 }) {
  const clamped = Math.max(0, Math.min(100, score));
  const r = 54;
  const c = 2 * Math.PI * r;
  const dash = (clamped / 100) * c;
  const above = score >= threshold;
  const color = above ? 'var(--accent-flow)' : 'var(--accent-attention)';

  return (
    <div>
      <div className="ring-wrap">
        <svg width={size} height={size} viewBox="0 0 140 140">
          <circle cx="70" cy="70" r={r} fill="none" stroke="var(--border)" strokeWidth="9" />
          <circle
            cx="70" cy="70" r={r} fill="none" stroke={color} strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={`${dash.toFixed(1)} ${(c - dash).toFixed(1)}`}
            transform="rotate(-90 70 70)"
          />
          <text x="70" y="68" textAnchor="middle" dominantBaseline="central" fontFamily="var(--font-display)" fontWeight="600" fontSize="33" fill="var(--text-primary)">
            {Math.round(score)}
          </text>
          <text x="70" y="90" textAnchor="middle" dominantBaseline="central" fontFamily="var(--font-body)" fontSize="11" fill="var(--text-secondary)">
            / 100
          </text>
        </svg>
      </div>
      <div className="ring-status" style={{ color }}>
        {above ? 'Above Target' : 'Below Target'} (threshold {threshold})
      </div>
    </div>
  );
}
