"""
evaluate_forecast.py — standalone Prophet backtest (NOT used by the app/API).

Runs a holdout backtest at DAILY and WEEKLY granularity, compares Prophet against
simple baselines (mean / persistence / seasonal-naive), and writes readable HTML
reports (+ CSVs) so accuracy is easy to judge. Weekly aggregation averages out the
random daily noise, so it should forecast noticeably better.

Uses the REAL dataset dates (no display shift) so the comparison is honest.

Run:
    cd backend
    venv\\Scripts\\python.exe evaluate_forecast.py                 (Windows)
    ./venv/bin/python evaluate_forecast.py                          (macOS/Linux)
    # optional custom holdouts:  evaluate_forecast.py <daily_days> <weekly_weeks>
"""

import sys
import os

import pandas as pd
from prophet import Prophet

from models.demand_forecast import DATA_PATH

DAILY_HOLDOUT = int(sys.argv[1]) if len(sys.argv) > 1 else 30    # ~1 month of days
WEEKLY_HOLDOUT = int(sys.argv[2]) if len(sys.argv) > 2 else 12   # ~3 months of weeks
HERE = os.path.dirname(__file__)


# --- helpers ---------------------------------------------------------------

def _mape(actual, predicted):
    a = pd.Series(list(actual)).reset_index(drop=True).astype(float)
    p = pd.Series(list(predicted)).reset_index(drop=True).astype(float)
    mask = a != 0
    return float((abs(a[mask] - p[mask]) / a[mask]).mean() * 100) if mask.any() else 0.0


def _fit(train, weekly_seasonality, yearly_seasonality=True):
    m = Prophet(yearly_seasonality=yearly_seasonality,
                weekly_seasonality=weekly_seasonality, daily_seasonality=False)
    m.add_regressor("promo")
    m.fit(train)
    return m


def load_series(freq):
    """Return a Prophet-ready frame (ds, y, promo) at 'D' or 'W' granularity."""
    df = pd.read_csv(DATA_PATH, encoding="latin1")
    df["Date"] = pd.to_datetime(df["Date"], format="%Y-%m-%d")
    daily = df.groupby("Date").agg(y=("Units Sold", "sum"),
                                   promo=("Holiday/Promotion", "mean"))
    if freq == "W":
        wk = daily.resample("W-SUN").agg(y=("y", "sum"), promo=("promo", "mean"),
                                         days=("y", "count"))
        wk = wk[wk["days"] == 7].drop(columns="days")   # full weeks only
        out = wk.reset_index().rename(columns={"Date": "ds"})
    else:
        out = daily.reset_index().rename(columns={"Date": "ds"})
    return out[["ds", "y", "promo"]].sort_values("ds").reset_index(drop=True)


def baselines(ts, holdout, season_period):
    """MAPE of mean / persistence / seasonal-naive on the held-out tail."""
    train, test = ts.iloc[:-holdout], ts.iloc[-holdout:].reset_index(drop=True)
    y_by_ds = dict(zip(ts["ds"], ts["y"]))
    step = ts["ds"].diff().dropna().median()  # spacing (1 day or 7 days)
    mean_f = [train["y"].mean()] * holdout
    persist_f = [train["y"].iloc[-1]] * holdout
    snaive_f = []
    for dt in test["ds"]:
        prior = dt - step * season_period
        snaive_f.append(y_by_ds.get(prior, train["y"].mean()))
    return {
        "mean": _mape(test["y"], mean_f),
        "persistence": _mape(test["y"], persist_f),
        "seasonal_naive": _mape(test["y"], snaive_f),
    }


def backtest(freq, holdout):
    ts = load_series(freq)
    weekly_seas = (freq == "D")
    # yearly seasonality only for daily; on ~2 years of weekly points it's spurious
    # noise that hurts, so weekly uses trend + promo only.
    yearly_seas = (freq == "D")
    season_period = 7 if freq == "D" else 52

    train, test = ts.iloc[:-holdout], ts.iloc[-holdout:].reset_index(drop=True)
    promo_map = dict(zip(ts["ds"], ts["promo"]))
    avg_promo = float(ts["promo"].mean())

    model = _fit(train, weekly_seas, yearly_seasonality=yearly_seas)
    future = model.make_future_dataframe(periods=holdout, freq=("W" if freq == "W" else "D"))
    future["promo"] = future["ds"].map(promo_map).fillna(avg_promo)
    fc = model.predict(future).set_index("ds")

    rows = []
    for _, r in test.iterrows():
        yhat = float(fc.loc[r["ds"], "yhat"])
        lo, hi = float(fc.loc[r["ds"], "yhat_lower"]), float(fc.loc[r["ds"], "yhat_upper"])
        a = float(r["y"])
        ae = abs(a - yhat)
        rows.append({
            "date": r["ds"].strftime("%Y-%m-%d"), "actual": round(a), "predicted": round(yhat),
            "lower": round(lo), "upper": round(hi), "abs_error": round(ae, 1),
            "pct_error": round((ae / a * 100) if a else 0, 2), "within_band": bool(lo <= a <= hi),
        })
    out = pd.DataFrame(rows)
    prophet_mape = out["pct_error"].mean()
    base = baselines(ts, holdout, season_period)
    skill = (base["mean"] - prophet_mape) / base["mean"] * 100 if base["mean"] else 0
    metrics = {
        "mape": prophet_mape,
        "mae": out["abs_error"].mean(),
        "rmse": ((out["actual"] - out["predicted"]) ** 2).mean() ** 0.5,
        "bias": (out["predicted"] - out["actual"]).mean(),
        "coverage": out["within_band"].mean() * 100,
        "mean_actual": out["actual"].mean(),
        "baselines": base,
        "skill": skill,
        "train": (train["ds"].min().strftime("%Y-%m-%d"), train["ds"].max().strftime("%Y-%m-%d")),
        "test": (test["ds"].min().strftime("%Y-%m-%d"), test["ds"].max().strftime("%Y-%m-%d")),
        "unit": "week" if freq == "W" else "day",
        "n": len(out),
    }
    return out, metrics


# --- HTML report -----------------------------------------------------------

def build_html(rows, m, title):
    W, H, pl, pr, pt, pb = 880, 300, 56, 16, 16, 34
    n = len(rows)
    allv = [v for r in rows for v in (r["actual"], r["predicted"], r["upper"], r["lower"])]
    ymin, ymax = min(allv), max(allv)
    span = (ymax - ymin) or 1
    ymin -= span * 0.08
    ymax += span * 0.08
    sx = lambda i: pl + i * (W - pl - pr) / max(1, n - 1)
    sy = lambda v: pt + (H - pt - pb) * (1 - (v - ymin) / (ymax - ymin))
    band = (" ".join(f"{sx(i):.1f},{sy(r['upper']):.1f}" for i, r in enumerate(rows)) + " " +
            " ".join(f"{sx(i):.1f},{sy(r['lower']):.1f}" for i, r in reversed(list(enumerate(rows)))))
    act = " ".join(f"{sx(i):.1f},{sy(r['actual']):.1f}" for i, r in enumerate(rows))
    prd = " ".join(f"{sx(i):.1f},{sy(r['predicted']):.1f}" for i, r in enumerate(rows))
    ticks = ""
    for t in range(5):
        val = ymin + (ymax - ymin) * t / 4
        y = sy(val)
        ticks += (f'<line x1="{pl}" y1="{y:.1f}" x2="{W-pr}" y2="{y:.1f}" stroke="#e6eaed"/>'
                  f'<text x="{pl-8}" y="{y+3:.1f}" text-anchor="end" font-size="10" fill="#8a97a2">{val/1000:.0f}k</text>')
    xlabels = ""
    step = max(1, n // 8)
    for i in range(0, n, step):
        xlabels += f'<text x="{sx(i):.1f}" y="{H-10}" text-anchor="middle" font-size="9" fill="#8a97a2">{rows[i]["date"][5:]}</text>'
    ec = lambda p: "#0f8f79" if p < 5 else ("#b57518" if p < 10 else "#c1362b")
    trows = ""
    for r in rows:
        c = ec(r["pct_error"])
        bc, bcol = ("✓", "#0f8f79") if r["within_band"] else ("✕", "#c1362b")
        trows += (f'<tr><td class="mono">{r["date"]}</td><td class="mono num">{r["actual"]:,}</td>'
                  f'<td class="mono num">{r["predicted"]:,}</td>'
                  f'<td class="mono num dim">{r["lower"]:,}–{r["upper"]:,}</td>'
                  f'<td class="mono num">{r["abs_error"]:,.0f}</td>'
                  f'<td class="mono num" style="color:{c};font-weight:600">{r["pct_error"]:.2f}%</td>'
                  f'<td class="mono" style="color:{bcol}">{bc}</td></tr>')

    beat = m["skill"] > 0
    skill_col = "#0f8f79" if beat else "#c1362b"
    skill_txt = f"{m['skill']:+.0f}% vs mean baseline · {'beats' if beat else 'does NOT beat'} the dumb guess"
    cards = [
        ("Accuracy", f"{100-m['mape']:.1f}%", f"MAPE {m['mape']:.2f}%", "#0f8f79"),
        ("Skill", f"{m['skill']:+.0f}%", "better than average", skill_col),
        ("MAE", f"{m['mae']:,.0f}", f"units/{m['unit']}", "#1b242c"),
        ("RMSE", f"{m['rmse']:,.0f}", f"units/{m['unit']}", "#1b242c"),
        ("Band coverage", f"{m['coverage']:.0f}%", "inside interval", "#1b242c"),
        ("Mean demand", f"{m['mean_actual']:,.0f}", f"actual units/{m['unit']}", "#1b242c"),
    ]
    card_html = "".join(f'<div class="card"><div class="clabel">{t}</div>'
                        f'<div class="cval" style="color:{col}">{v}</div>'
                        f'<div class="csub">{sub}</div></div>' for (t, v, sub, col) in cards)
    b = m["baselines"]
    brows = "".join(f'<tr><td>{name}</td><td class="mono num">{val:.2f}%</td></tr>'
                    for name, val in [("Prophet", m["mape"]), ("Mean baseline", b["mean"]),
                                      ("Persistence", b["persistence"]), ("Seasonal-naive", b["seasonal_naive"])])

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>{title}</title><style>
*{{box-sizing:border-box}} body{{margin:0;padding:28px;background:#f5f7f8;color:#1b242c;font-family:'Segoe UI',system-ui,sans-serif}}
h1{{margin:0 0 4px;font-size:24px}} .sub{{color:#66727c;font-size:13px;margin-bottom:6px}}
.skill{{font-weight:600;font-size:14px;margin-bottom:18px;color:{skill_col}}}
.cards{{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:22px}}
.card{{background:#fff;border:1px solid #dce1e5;border-radius:10px;padding:14px 16px}}
.clabel{{font-size:12px;color:#66727c}} .cval{{font-size:26px;font-weight:700;line-height:1.1;margin-top:4px}}
.csub{{font-size:11px;color:#8a97a2;margin-top:3px}}
.panel{{background:#fff;border:1px solid #dce1e5;border-radius:10px;padding:18px;margin-bottom:22px}}
.panel h2{{margin:0 0 12px;font-size:16px}} .legend{{font-size:12px;color:#66727c;margin-bottom:8px}}
.swatch{{display:inline-block;width:14px;height:3px;vertical-align:middle;margin:0 4px 0 12px}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th{{text-align:left;color:#66727c;font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:8px 10px;border-bottom:2px solid #dce1e5}}
td{{padding:7px 10px;border-bottom:1px solid #eef1f3}} td.num{{text-align:right}} td.dim{{color:#8a97a2}}
.mono{{font-family:'Consolas','SF Mono',monospace}} tr:hover td{{background:#fafbfc}}
.two{{display:grid;grid-template-columns:2fr 1fr;gap:22px;align-items:start}}
</style></head><body>
<h1>{title}</h1>
<div class="sub">Trained {m['train'][0]} → {m['train'][1]} · held-out {m['test'][0]} → {m['test'][1]} ({n} {m['unit']}s). Real dates, no shift.</div>
<div class="skill">{skill_txt}</div>
<div class="cards">{card_html}</div>
<div class="two">
  <div class="panel"><h2>Actual vs Predicted</h2>
    <div class="legend"><span class="swatch" style="background:#0f8f79"></span>Actual
      <span class="swatch" style="background:#b57518"></span>Predicted
      <span style="display:inline-block;width:14px;height:10px;background:#e3f3ef;border:1px solid #cfe6df;vertical-align:middle;margin:0 4px 0 12px"></span>interval</div>
    <svg viewBox="0 0 {W} {H}" style="width:100%;height:auto">{ticks}
      <polygon points="{band}" fill="#e3f3ef" opacity="0.7"/>
      <polyline points="{prd}" fill="none" stroke="#b57518" stroke-width="2" stroke-dasharray="5 4"/>
      <polyline points="{act}" fill="none" stroke="#0f8f79" stroke-width="2.2"/>{xlabels}</svg>
  </div>
  <div class="panel"><h2>Prophet vs baselines (MAPE)</h2>
    <table><thead><tr><th>Forecaster</th><th style="text-align:right">MAPE</th></tr></thead><tbody>{brows}</tbody></table>
    <div class="csub" style="margin-top:10px">Lower is better. Prophet only "earns its keep" if it beats the mean baseline.</div>
  </div>
</div>
<div class="panel"><h2>Per-{m['unit']} comparison</h2>
  <table><thead><tr><th>{'Week ending' if m['unit']=='week' else 'Date'}</th>
    <th style="text-align:right">Actual</th><th style="text-align:right">Predicted</th><th>Interval</th>
    <th style="text-align:right">Abs error</th><th style="text-align:right">% error</th><th>In band</th></tr></thead>
    <tbody>{trows}</tbody></table></div>
</body></html>"""


def main():
    results = {}
    for freq, holdout in [("D", DAILY_HOLDOUT), ("W", WEEKLY_HOLDOUT)]:
        out, m = backtest(freq, holdout)
        label = "weekly" if freq == "W" else "daily"
        out.to_csv(os.path.join(HERE, f"forecast_eval_{label}.csv"), index=False)
        title = f"Prophet Backtest · {'Weekly' if freq=='W' else 'Daily'} Demand Forecast"
        with open(os.path.join(HERE, f"forecast_eval_{label}.html"), "w", encoding="utf-8") as f:
            f.write(build_html(out.to_dict("records"), m, title))
        results[label] = m

    d, w = results["daily"], results["weekly"]
    print("\n===================== BACKTEST =====================")
    for lbl, m in [("DAILY ", d), ("WEEKLY", w)]:
        print(f"  {lbl} | accuracy {100-m['mape']:5.2f}%  (MAPE {m['mape']:.2f}%)  "
              f"skill {m['skill']:+.0f}%  vs mean {m['baselines']['mean']:.2f}%  persist {m['baselines']['persistence']:.2f}%")
    improvement = d["mape"] - w["mape"]
    print("  ---------------------------------------------------")
    print(f"  Weekly is {improvement:+.2f} pts MAPE vs daily "
          f"({'better' if improvement > 0 else 'worse'}); "
          f"weekly {'beats' if w['skill'] > 0 else 'does NOT beat'} the mean baseline.")
    print("===================================================")
    print("  Reports: forecast_eval_weekly.html , forecast_eval_daily.html")


if __name__ == "__main__":
    main()
