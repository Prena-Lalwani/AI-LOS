import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';

/**
 * TrendChart — thin wrapper around Recharts pre-styled to the token system.
 * Never uses default Recharts colors: every series passes an explicit color
 * (use 'var(--accent-flow)' / 'var(--accent-attention)' / 'var(--text-secondary)').
 *
 * Props:
 *   data       – array of row objects
 *   xKey       – dataKey for the X axis
 *   series     – [{ key, color, type?: 'line'|'bar', dashed?, width?, opacity?, barSize? }]
 *   area       – optional { key, color } soft fill under a line
 *   refLine    – optional { x } dashed vertical marker (rendered in amber)
 *   height     – px (default 220)
 *   yFormatter – optional Y tick formatter
 *   xFormatter – optional X tick formatter
 *   yDomain    – optional [min, max]
 *   yWidth     – optional Y axis width in px (default 46)
 *   emphasizeLast – if true, mark the final point of each line series with a
 *                   filled dot (a "you are here / now" cue for live trends)
 */
function makeEndDot(color, lastIndex) {
  // Recharts calls this for every point; draw a dot only at the final index.
  return function EndDot({ cx, cy, index }) {
    if (index !== lastIndex || cx == null || cy == null) return <g key={index} />;
    return (
      <circle key={index} cx={cx} cy={cy} r={4} fill={color}
        stroke="var(--bg-panel)" strokeWidth={2} />
    );
  };
}

export default function TrendChart({
  data,
  xKey,
  series,
  area,
  band,
  refLine,
  height = 220,
  yFormatter,
  xFormatter,
  yDomain,
  yWidth = 46,
  emphasizeLast = false,
}) {
  const lastIndex = (data?.length || 0) - 1;
  const axis = {
    stroke: 'var(--border)',
    tick: { fill: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11 },
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 14, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.6} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={{ stroke: 'var(--border)' }} tick={axis.tick}
          tickFormatter={xFormatter} minTickGap={20} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={yWidth}
          tick={axis.tick}
          domain={yDomain}
          tickFormatter={yFormatter}
        />
        <Tooltip
          cursor={{ stroke: 'var(--border)' }}
          contentStyle={{
            background: 'var(--bg-panel)',
            border: '0.5px solid var(--border)',
            borderRadius: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
          }}
          labelStyle={{ color: 'var(--text-secondary)' }}
        />
        {area && <Area type="monotone" dataKey={area.key} stroke="none" fill={area.color} fillOpacity={0.5} isAnimationActive={false} />}
        {band && <Area type="monotone" dataKey={band.key} stroke="none" fill={band.color} fillOpacity={0.18} connectNulls={false} isAnimationActive={false} />}
        {refLine != null && <ReferenceLine x={refLine.x} stroke="var(--accent-attention)" strokeDasharray="3 3" />}
        {series.map((s) =>
          s.type === 'bar' ? (
            <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[3, 3, 0, 0]} barSize={s.barSize || 18} isAnimationActive={false} />
          ) : (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={s.width || 2.2}
              strokeDasharray={s.dashed ? '4 4' : undefined}
              strokeOpacity={s.opacity || 1}
              dot={emphasizeLast && !s.dashed ? makeEndDot(s.color, lastIndex) : false}
              isAnimationActive={false}
            />
          )
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
