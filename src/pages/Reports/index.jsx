import { useEffect, useState } from 'react';
import PageHeader from '../../components/PageHeader.jsx';
import RoiCard from '../../components/RoiCard.jsx';
import KpiCard from '../../components/KpiCard.jsx';
import DataTable from '../../components/DataTable.jsx';
import TrendChart from '../../components/TrendChart.jsx';
import { API_BASE } from '../../api.js';

// Live data source: the FastAPI backend (see backend/models/reports_analytics.py).
// This module doesn't compute anything new — it aggregates the already-cached
// outputs of the Executive, Demand, Inventory, Dispatch and Fleet modules and
// can export any report to PDF (reportlab) or Excel (openpyxl).
const BASE = API_BASE;
const LIST_URL = `${BASE}/api/reports/list`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Pretty axis labels for date-like x values; leaves non-dates (e.g. "W1") alone.
function fmtAxisDate(v) {
  if (typeof v !== 'string') return v;
  const mMonth = /^(\d{4})-(\d{2})$/.exec(v);            // YYYY-MM  -> Aug '23
  if (mMonth) return `${MONTHS[+mMonth[2] - 1]} '${mMonth[1].slice(2)}`;
  const mDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);       // YYYY-MM-DD -> Jul 16
  if (mDay) return `${MONTHS[+mDay[2] - 1]} ${+mDay[3]}`;
  return v;
}

// Clean, short money/number axis labels (no ugly 0.99998 tails).
function makeYFormatter(s) {
  return (v) => {
    const a = Math.abs(v);
    let n;
    if (s.yThousands && a >= 1000) n = `${(v / 1000).toFixed(0)}k`;
    else if (a >= 1000) n = Math.round(v).toLocaleString();
    else if (a >= 10) n = `${Math.round(v)}`;
    else if (a >= 1) n = v.toFixed(1);
    else n = v.toFixed(2);
    return `${s.yPrefix || ''}${n}${s.ySuffix || ''}`;
  };
}

// Generic renderer for one report section (kpis / table / chart block).
function Section({ s }) {
  if (s.type === 'kpis') {
    return (
      <div style={{ marginBottom: 16 }}>
        {s.title && <div className="report-subhead">{s.title}</div>}
        <div className="kpi-grid" style={{ marginBottom: 0 }}>
          {s.items.map((it) => (
            <KpiCard key={it.label} label={it.label} value={String(it.value)} delta={it.delta} state={it.state || 'neutral'} />
          ))}
        </div>
      </div>
    );
  }

  if (s.type === 'table') {
    const columns = s.columns.map((c, i) => ({
      header: c.label,
      cell: (r) => (i === 0
        ? <span style={{ fontWeight: 500 }}>{r[c.key]}</span>
        : <span className="mono muted">{r[c.key]}</span>),
    }));
    const template = `1.6fr ${'1fr '.repeat(Math.max(0, s.columns.length - 1))}`.trim();
    return (
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>{s.title}</h2>
        <DataTable columns={columns} rows={s.rows} template={template} />
        {s.note && <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>{s.note}</div>}
      </div>
    );
  }

  if (s.type === 'chart') {
    const vals = s.data.flatMap((row) => s.series.map((se) => row[se.key])).filter((v) => typeof v === 'number');
    const isBar = s.series.some((se) => se.type === 'bar');
    let yDomain;
    if (vals.length) {
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1;
      yDomain = isBar ? [0, hi + pad] : [lo - pad, hi + pad];
    }
    const yFmt = makeYFormatter(s);
    return (
      <div className="card">
        <div className="card__head" style={{ justifyContent: 'space-between' }}>
          <h2>{s.title}</h2>
          <div className="legend">
            {s.series.map((se) => (
              <span className="legend__item" key={se.key}>
                <span className="legend__line" style={{ background: se.color }} />{se.label}
              </span>
            ))}
          </div>
        </div>
        <TrendChart
          data={s.data}
          xKey={s.xKey}
          height={210}
          yDomain={yDomain}
          yFormatter={yFmt}
          xFormatter={fmtAxisDate}
          yWidth={54}
          series={s.series.map((se) => ({
            key: se.key, color: se.color, type: se.type || 'line',
            width: 2.2, barSize: 16, dashed: se.dashed,
          }))}
        />
      </div>
    );
  }
  return null;
}

export default function Reports() {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('All');
  const [selId, setSelId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState(null);
  const [range, setRange] = useState({ from: '', to: '' });

  // fetch the report registry once, auto-select the first report
  useEffect(() => {
    let alive = true;
    fetch(LIST_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (alive) { setList(d.reports); setSelId((cur) => cur || d.reports[0]?.id); } })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  // fetch the selected report's detail (re-fetch when id or date range changes)
  useEffect(() => {
    if (!selId) return undefined;
    let alive = true;
    setDetail(null); setDetailErr(null);
    const qs = new URLSearchParams();
    if (range.from) qs.set('date_from', range.from);
    if (range.to) qs.set('date_to', range.to);
    const url = `${BASE}/api/reports/${selId}${qs.toString() ? `?${qs}` : ''}`;
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setDetailErr(e.message); });
    return () => { alive = false; };
  }, [selId, range]);

  const download = (fmt) => {
    const qs = new URLSearchParams();
    if (range.from) qs.set('date_from', range.from);
    if (range.to) qs.set('date_to', range.to);
    const url = `${BASE}/api/reports/${selId}/export/${fmt}${qs.toString() ? `?${qs}` : ''}`;
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const selectReport = (id) => { setSelId(id); setRange({ from: '', to: '' }); };

  if (error) {
    return (
      <>
        <PageHeader title="Reports & Analytics" subtitle="Scheduled & custom reports across all modules" />
        <div className="card" style={{ maxWidth: 640 }}>
          <h2 style={{ marginBottom: 8 }}>Reports API unavailable</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            Could not reach the reports service at <span className="mono">{LIST_URL}</span> ({error}).
            Start it with <span className="mono">cd backend &amp;&amp; uvicorn main:app --port 8000</span>.
          </p>
        </div>
      </>
    );
  }

  const modules = list
    ? ['All', ...Array.from(new Set(list.map((r) => r.module))).filter((m) => m !== 'All')]
    : ['All'];
  const shown = list ? (filter === 'All' ? list : list.filter((r) => r.module === filter)) : [];

  return (
    <>
      <PageHeader
        title="Reports & Analytics"
        subtitle={
          list
            ? `${list.length} reports · aggregated from all 5 modules · PDF & Excel export`
            : 'Scheduled & custom reports across all modules'
        }
      />

      <RoiCard
        subtitle="Reporting automation"
        items={[
          { value: '~$15K/yr', label: 'Analyst time saved', note: 'auto-aggregated vs manually compiling module data each cycle' },
          { value: `${list ? list.length : 6}`, label: 'Reports auto-built', note: 'across all modules — always current, no copy-paste' },
          { value: 'PDF · Excel', label: 'One-click export', note: 'board-ready, date-range filtered' },
        ]}
        footnote="Time saved is a conservative estimate; reports pull live figures from every module."
      />

      <div className="split">
        {/* selected report detail */}
        <div className="col">
          {detailErr && (
            <div className="card"><p className="muted" style={{ margin: 0, fontSize: 13 }}>Could not load report ({detailErr}).</p></div>
          )}
          {!detail && !detailErr && (
            <div className="muted" style={{ padding: '48px 4px', fontSize: 14 }}>Loading report…</div>
          )}
          {detail && (
            <>
              <div className="card">
                <div className="card__head" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h2 style={{ marginBottom: 4 }}>{detail.title}</h2>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {detail.module} · generated {detail.lastGenerated}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button className="btn btn--sm" onClick={() => download('pdf')}>Export PDF</button>
                    <button className="btn btn--sm" onClick={() => download('excel')}>Export Excel</button>
                  </div>
                </div>
                <p className="muted" style={{ margin: '0 0 2px', fontSize: 13, lineHeight: 1.5 }}>{detail.description}</p>

                {detail.timeSeries && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    <span className="muted" style={{ fontSize: 12 }}>Filter range</span>
                    <input type="date" className="date-input" value={range.from}
                      onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
                    <span className="muted">→</span>
                    <input type="date" className="date-input" value={range.to}
                      onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
                    {(range.from || range.to) && (
                      <button className="btn btn--sm" onClick={() => setRange({ from: '', to: '' })}>Clear</button>
                    )}
                  </div>
                )}
              </div>

              {detail.sections.map((s, i) => <Section key={i} s={s} />)}
            </>
          )}
        </div>

        {/* report registry / list */}
        <div className="col">
          <div className="card">
            <h2 style={{ marginBottom: 10 }}>Available Reports</h2>
            <div className="chips" style={{ marginBottom: 12 }}>
              {modules.map((m) => (
                <button key={m} className={`chip${filter === m ? ' active' : ''}`} onClick={() => setFilter(m)}>{m}</button>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {shown.map((r) => {
                const active = r.id === selId;
                return (
                  <button
                    key={r.id}
                    onClick={() => selectReport(r.id)}
                    style={{
                      textAlign: 'left', cursor: 'pointer', borderRadius: 6, padding: '10px 12px',
                      background: active ? 'var(--accent-flow-bg)' : 'transparent',
                      border: '0.5px solid var(--border)',
                      borderLeft: `3px solid ${active ? 'var(--accent-flow)' : 'var(--border)'}`,
                      color: 'inherit',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{r.title}</span>
                      <span className="pill" style={{ marginLeft: 'auto' }}>{r.module}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.45 }}>{r.description}</div>
                    <div className="mono muted" style={{ fontSize: 10.5, marginTop: 5 }}>
                      next {r.nextScheduled} · illustrative
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
              Scheduled dates are illustrative — no live scheduler is running yet.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
