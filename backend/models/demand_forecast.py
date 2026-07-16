"""
demand_forecast.py — Order & Demand Intelligence model layer (WEEKLY).

Loads the retail store inventory CSV, aggregates a single WEEKLY total-demand
time series, trains a real Prophet model, and produces a 4-week forward forecast
using a recursive "feed the prediction back" scheme: forecast week +1, append
that prediction to the series as if it were real data, refit, forecast week +2,
and so on for 4 weeks. Weeks 2-4 are therefore forecast-on-forecast.

Why weekly: daily totals in this dataset are almost pure noise (a backtest showed
Prophet only ties a mean baseline at ~92% daily). Aggregating to weeks averages
that noise out and lifts measured accuracy to ~98%, which is also the natural
granularity for staffing/truck planning.

DATE DISPLAY SHIFT
------------------
The dataset is historical (last real date 2024-01-01). The model trains on the
REAL dates/order; only the date LABELS sent to the frontend are shifted forward
by the exact day gap between the last real date and today (datetime.now()), so
the weekly trend ends near "today" and the 4-week forecast lands in the future.
"""

import os
import math
from datetime import datetime

import pandas as pd
from prophet import Prophet

# --- tunable business constants (easy to adjust later) ---------------------
UNITS_PER_WORKER_PER_DAY = 500     # 1 warehouse worker per 500 projected units/day
UNITS_PER_TRUCK_PER_DAY = 2000     # 1 truck per 2,000 projected units/day
FORECAST_WEEKS = 4                 # forward horizon (~28 days)
WEEKLY_HOLDOUT = 12                # weeks held out to MEASURE accuracy

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "retail_store_inventory.csv")


# --- helpers ---------------------------------------------------------------

def _round(x, d=2):
    return round(float(x), d)


def _shift(ts, offset_days):
    """Shift a timestamp forward by N days -> 'YYYY-MM-DD' display label."""
    return (ts + pd.Timedelta(days=offset_days)).strftime("%Y-%m-%d")


def _mape(actual, predicted):
    a = pd.Series(list(actual)).reset_index(drop=True).astype(float)
    p = pd.Series(list(predicted)).reset_index(drop=True).astype(float)
    mask = a != 0
    return float((abs(a[mask] - p[mask]) / a[mask]).mean() * 100) if mask.any() else 0.0


def _fit_weekly(train):
    """Prophet for a weekly series: trend + promo regressor only.
    (No weekly seasonality — the data is already weekly. No yearly seasonality —
    ~2 years of weekly points isn't enough to learn it and it hurt accuracy.)"""
    m = Prophet(yearly_seasonality=False, weekly_seasonality=False, daily_seasonality=False)
    m.add_regressor("promo")
    m.fit(train)
    return m


def _load():
    """Return (weekly Prophet frame [ds,y,promo], raw row-level df)."""
    df = pd.read_csv(DATA_PATH, encoding="latin1")
    df["Date"] = pd.to_datetime(df["Date"], format="%Y-%m-%d")
    daily = df.groupby("Date").agg(y=("Units Sold", "sum"), promo=("Holiday/Promotion", "mean"))
    wk = daily.resample("W-SUN").agg(y=("y", "sum"), promo=("promo", "mean"), days=("y", "count"))
    wk = wk[wk["days"] == 7].drop(columns="days")  # full weeks only
    ts = wk.reset_index().rename(columns={"Date": "ds"})[["ds", "y", "promo"]]
    return ts.sort_values("ds").reset_index(drop=True), df


def _recursive_forecast(ts, n_weeks):
    """Forecast n_weeks by appending each week's PREDICTION back into the series
    before forecasting the next (recursive / feed-back)."""
    work = ts.copy()
    promo_map = dict(zip(ts["ds"], ts["promo"]))
    avg_promo = float(ts["promo"].mean())
    out = []
    for i in range(n_weeks):
        model = _fit_weekly(work)
        fut = model.make_future_dataframe(periods=1, freq="W-SUN")
        fut["promo"] = fut["ds"].map(promo_map).fillna(avg_promo)
        row = model.predict(fut).iloc[-1]
        out.append({
            "ds": row["ds"],
            "yhat": max(0.0, float(row["yhat"])),
            "lower": max(0.0, float(row["yhat_lower"])),
            "upper": max(0.0, float(row["yhat_upper"])),
            "recursive": i > 0,   # week 1 is off real data; weeks 2-4 feed predictions back
        })
        # append this prediction as if it were an observed week
        promo_map[row["ds"]] = avg_promo
        work = pd.concat(
            [work, pd.DataFrame([{"ds": row["ds"], "y": max(0.0, float(row["yhat"])), "promo": avg_promo}])],
            ignore_index=True,
        )
    return out


def build_payload():
    ts, df = _load()
    last_date = ts["ds"].max()
    promo_map = dict(zip(ts["ds"], ts["promo"]))
    avg_promo = float(ts["promo"].mean())

    # --- measured accuracy on a weekly holdout (direct multi-week forecast) --
    train = ts.iloc[:-WEEKLY_HOLDOUT]
    test = ts.iloc[-WEEKLY_HOLDOUT:].reset_index(drop=True)
    hm = _fit_weekly(train)
    fut = hm.make_future_dataframe(periods=WEEKLY_HOLDOUT, freq="W-SUN")
    fut["promo"] = fut["ds"].map(promo_map).fillna(avg_promo)
    pred = hm.predict(fut).set_index("ds").loc[test["ds"]]["yhat"].values
    weekly_mape = _mape(test["y"].values, pred)
    accuracy = max(0.0, 100.0 - weekly_mape)

    # HONESTY CHECK — how much does Prophet actually beat naive baselines on the
    # SAME holdout? Weekly totals are near-flat, so most of the headline accuracy
    # is just "the level", not forecasting skill. We report the best naive
    # baseline (mean-of-history vs last-value persistence) and the model's lift.
    mean_val = float(train["y"].mean())
    last_val = float(train["y"].iloc[-1])
    baseline_mape = min(_mape(test["y"].values, [mean_val] * len(test)),
                        _mape(test["y"].values, [last_val] * len(test)))
    baseline_accuracy = max(0.0, 100.0 - baseline_mape)
    skill_pts = accuracy - baseline_accuracy   # accuracy points the model adds

    # accuracy trend: prior holdout window (train excluding last 2 windows)
    train_p = ts.iloc[:-2 * WEEKLY_HOLDOUT]
    test_p = ts.iloc[-2 * WEEKLY_HOLDOUT:-WEEKLY_HOLDOUT].reset_index(drop=True)
    pm = _fit_weekly(train_p)
    fut_p = pm.make_future_dataframe(periods=WEEKLY_HOLDOUT, freq="W-SUN")
    fut_p["promo"] = fut_p["ds"].map(promo_map).fillna(avg_promo)
    pred_p = pm.predict(fut_p).set_index("ds").loc[test_p["ds"]]["yhat"].values
    accuracy_prior = max(0.0, 100.0 - _mape(test_p["y"].values, pred_p))

    # --- recursive 4-week forward forecast ---------------------------------
    fc = _recursive_forecast(ts, FORECAST_WEEKS)

    # --- date display shift (labels only) ----------------------------------
    offset = (datetime.now().date() - last_date.date()).days

    weekly_trend = [
        {"weekStart": _shift(r.ds, offset), "actual": _round(r.y)}
        for r in ts.itertuples(index=False)
    ]
    forecast = [
        {
            "weekStart": _shift(f["ds"], offset),
            "projected": _round(f["yhat"]),
            "lower": _round(f["lower"]),
            "upper": _round(f["upper"]),
            "recursive": f["recursive"],
        }
        for f in fc
    ]

    # --- breakdowns (plain pandas) -----------------------------------------
    grand = float(df["Units Sold"].sum())
    sg = df.groupby("Seasonality").agg(total=("Units Sold", "sum"), days=("Date", "nunique")).reset_index()
    seasonal_breakdown = sorted(
        [{"season": r.Seasonality, "totalUnits": _round(r.total),
          "avgDailyUnits": _round(r.total / r.days if r.days else 0),
          "sharePct": _round(r.total / grand * 100 if grand else 0, 1)} for r in sg.itertuples(index=False)],
        key=lambda x: x["totalUnits"], reverse=True)

    cg = df.groupby("Category")["Units Sold"].sum().reset_index(name="u")
    category_breakdown = sorted(
        [{"category": r.Category, "unitsSold": _round(r.u)} for r in cg.itertuples(index=False)],
        key=lambda x: x["unitsSold"], reverse=True)

    rg = df.groupby("Region")["Units Sold"].sum().reset_index(name="u")
    region_breakdown = sorted(
        [{"region": r.Region, "unitsSold": _round(r.u)} for r in rg.itertuples(index=False)],
        key=lambda x: x["unitsSold"], reverse=True)

    # --- workforce / truck recommendations (from projected weekly demand) ---
    proj_weekly = [f["projected"] for f in forecast]
    avg_week = sum(proj_weekly) / len(proj_weekly) if proj_weekly else 0.0
    avg_day = avg_week / 7
    peak = max(forecast, key=lambda f: f["projected"]) if forecast else {"projected": 0, "weekStart": None}
    peak_day = peak["projected"] / 7

    workers = math.ceil(avg_day / UNITS_PER_WORKER_PER_DAY)
    trucks = math.ceil(avg_day / UNITS_PER_TRUCK_PER_DAY)
    peak_workers = math.ceil(peak_day / UNITS_PER_WORKER_PER_DAY)
    peak_trucks = math.ceil(peak_day / UNITS_PER_TRUCK_PER_DAY)

    recommendations = [
        {"title": f"Staff {workers} warehouse workers/day",
         "impact": f"Covers ~{round(avg_day):,} projected units/day · 1 per {UNITS_PER_WORKER_PER_DAY}",
         "state": "flow"},
        {"title": f"Dispatch {trucks} trucks/day",
         "impact": f"Covers ~{round(avg_day):,} projected units/day · 1 per {UNITS_PER_TRUCK_PER_DAY:,}",
         "state": "flow"},
        {"title": f"Scale to {peak_workers} workers · {peak_trucks} trucks on peak week",
         "impact": f"Peak ~{round(peak_day):,} units/day · week of {peak['weekStart']}",
         "state": "attention"},
    ]

    # --- KPIs (shape mirrors the Executive data layer) ---------------------
    recent4 = float(ts["y"].iloc[-4:].mean())
    prior4 = float(ts["y"].iloc[-8:-4].mean())
    wow = round((recent4 - prior4) / abs(prior4) * 100, 1) if prior4 else 0.0
    sum_fc = sum(proj_weekly)
    trailing4 = float(ts["y"].iloc[-4:].sum())
    fc_delta = round((sum_fc - trailing4) / abs(trailing4) * 100, 1) if trailing4 else 0.0
    peak_season = seasonal_breakdown[0] if seasonal_breakdown else None
    avg_season = sum(s["totalUnits"] for s in seasonal_breakdown) / len(seasonal_breakdown) if seasonal_breakdown else 0

    kpis = [
        {"label": "Forecast Accuracy", "value": _round(accuracy, 1),
         "delta": _round(accuracy - accuracy_prior, 1), "unit": "%"},
        {"label": "Avg Weekly Demand", "value": round(float(ts["y"].mean())), "delta": wow, "unit": ""},
        {"label": "Next 4 Weeks", "value": round(sum_fc), "delta": fc_delta, "unit": ""},
        {"label": "Peak Season", "value": peak_season["season"] if peak_season else "n/a",
         "delta": _round(peak_season["totalUnits"] / avg_season * 100 - 100, 1) if peak_season and avg_season else 0.0,
         "unit": ""},
    ]

    return {
        "kpis": kpis,
        "weeklyTrend": weekly_trend,
        "forecast": forecast,
        "seasonalBreakdown": seasonal_breakdown,
        "categoryBreakdown": category_breakdown,
        "regionBreakdown": region_breakdown,
        "recommendations": recommendations,
        "meta": {
            "granularity": "weekly",
            "method": "recursive (predictions fed back each week)",
            "forecastWeeks": FORECAST_WEEKS,
            "measuredWeeklyMAPE": _round(weekly_mape, 2),
            "baselineAccuracy": _round(baseline_accuracy, 1),
            "baselineMAPE": _round(baseline_mape, 2),
            "skillVsBaselinePts": _round(skill_pts, 1),
            "dayOffset": offset,
            "lastRealDate": last_date.strftime("%Y-%m-%d"),
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
        },
    }
