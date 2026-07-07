"""
fleet_intelligence.py — Fleet Intelligence model layer.

Runs on the self-generated synthetic fleet dataset
(backend/data/fleet/*.csv, produced by data_generation/generate_fleet_data.py)
plus the shared 15 trucks / 25 drivers from the Dispatch module. Every analysis
here is real — the numbers are computed from the data, not hand-written:

  * Predictive maintenance (supervised ML) — each vehicle-day is labelled 1 if a
    breakdown-type maintenance record falls within the NEXT 10 days for that
    vehicle. An XGBoost classifier is trained on the raw sensor snapshot PLUS
    engineered rolling-7-day mean and 7-day change (trend) features for engine
    temperature and oil / tyre pressure — trends matter more than raw snapshots
    for degradation. Time-based split (earliest 80% train, latest 20% test) with
    real accuracy / precision / recall. Emits each vehicle's CURRENT breakdown
    risk % from its most recent telemetry row.

  * Anomaly detection (unsupervised ML) — an IsolationForest fit on the same
    feature matrix flags statistically anomalous vehicle-days independent of the
    labels above, catching issues the supervised model was not trained to expect.
    Reports which vehicles are anomalous in the most recent data.

  * Vehicle utilisation — days-active vs total days and total distance per vehicle
    from the trip summary; the bottom 20% by a blended utilisation score are
    flagged underused.

  * Driver performance — harsh braking / acceleration and fuel efficiency
    (distance ÷ fuel) aggregated per driver, ranked, with a fleet z-score to flag
    drivers statistically worse than the fleet average.

  * Fuel analytics — per-vehicle and per-driver km/litre; each vehicle's last-30-
    day efficiency is compared with its own earlier baseline and flagged if it is
    degrading (an early maintenance signal, cross-referenced with breakdown risk).

  * Maintenance scheduling — a prioritised list combining breakdown risk AND
    recent anomalies; vehicles with both get top priority, and a suggested service
    window is the vehicle's next typically-idle weekday.

DATE DISPLAY SHIFT
------------------
The CSVs are historical (anchored to 2024-12-30). We shift every date forward by
the gap between the last telemetry date and today, so "current" reads as today —
same pattern as the warehouse / inventory / dispatch modules.

Both models are trained once (see train_models) and the payload built from the
cached fit — main.py does this at startup and caches the result in memory.
"""

import os
from datetime import datetime

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score
from xgboost import XGBClassifier

# --------------------------------------------------------------------------- #
# Documented business constants                                               #
# --------------------------------------------------------------------------- #
LABEL_HORIZON_DAYS = 10          # "breakdown within the next N days" → positive
ROLL_WINDOW = 7                  # rolling window (days) for mean / trend features
RECENT_DAYS = 14                 # "most recent data" window for anomaly reporting
FUEL_RECENT_DAYS = 30            # recent window for fuel-efficiency degradation
FUEL_DEGRADE_PCT = 5.0           # flag if recent km/L is >5% below own baseline
UNDERUSED_QUANTILE = 0.20        # bottom 20% of utilisation → underused
DRIVER_Z_THRESHOLD = 1.0         # z-score beyond which a driver is "worse than fleet"
TRAIN_FRACTION = 0.80            # time-based split point

_DATA = os.path.join(os.path.dirname(__file__), "..", "data", "fleet")
_DISPATCH = os.path.join(os.path.dirname(__file__), "..", "data", "dispatch")

# Raw sensor columns + the engineered rolling features fed to both models.
_RAW_FEATURES = [
    "engine_temp_avg_c", "engine_temp_max_c", "oil_pressure_psi",
    "battery_voltage", "brake_pad_wear_pct", "tire_pressure_avg_psi",
]
_ROLL_BASE = [
    "engine_temp_avg_c", "engine_temp_max_c", "oil_pressure_psi", "tire_pressure_avg_psi",
]


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #
def _round(x, d=2):
    return round(float(x), d)


def _state(flag_attention, flag_critical=False):
    if flag_critical:
        return "critical"
    return "attention" if flag_attention else "flow"


# --------------------------------------------------------------------------- #
# Load + date shift + feature engineering                                     #
# --------------------------------------------------------------------------- #
def _load():
    telemetry = pd.read_csv(os.path.join(_DATA, "vehicle_telemetry.csv"), parse_dates=["date"])
    maintenance = pd.read_csv(os.path.join(_DATA, "maintenance_history.csv"), parse_dates=["date"])
    trips = pd.read_csv(os.path.join(_DATA, "driver_trip_summary.csv"), parse_dates=["date"])
    vehicles = pd.read_csv(os.path.join(_DISPATCH, "vehicles.csv"))
    drivers = pd.read_csv(os.path.join(_DISPATCH, "drivers.csv"))

    last_real = telemetry["date"].max()
    offset = (datetime.now().date() - last_real.date()).days
    for df in (telemetry, maintenance, trips):
        df["date_shifted"] = df["date"] + pd.Timedelta(days=offset)

    return {
        "telemetry": telemetry, "maintenance": maintenance, "trips": trips,
        "vehicles": vehicles, "drivers": drivers,
        "offset": offset, "last_real": last_real,
    }


def _engineer(telemetry, maintenance):
    """Add the supervised label + rolling-7-day mean/trend features per vehicle.

    label            = 1 if a breakdown record occurs within LABEL_HORIZON_DAYS
                       after this vehicle-day.
    <feat>_roll7     = trailing 7-day mean of the sensor.
    <feat>_trend7    = sensor now minus its value 7 days ago (degradation slope).
    """
    df = telemetry.sort_values(["vehicle_id", "date"]).reset_index(drop=True)

    # ---- rolling mean + 7-day change, computed within each vehicle ----------
    for col in _ROLL_BASE:
        g = df.groupby("vehicle_id", sort=False)[col]
        df[f"{col}_roll7"] = g.transform(
            lambda s: s.rolling(ROLL_WINDOW, min_periods=1).mean())
        df[f"{col}_trend7"] = g.transform(lambda s: s - s.shift(ROLL_WINDOW)).fillna(0.0)

    # ---- supervised label: breakdown within the next 10 days ----------------
    df["label"] = 0
    bd = maintenance[maintenance["maintenance_type"] == "breakdown"]
    for r in bd.itertuples(index=False):
        mask = (
            (df["vehicle_id"] == r.vehicle_id)
            & (df["date"] >= r.date - pd.Timedelta(days=LABEL_HORIZON_DAYS))
            & (df["date"] < r.date)
        )
        df.loc[mask, "label"] = 1

    return df


def _feature_cols():
    roll = [f"{c}_roll7" for c in _ROLL_BASE] + [f"{c}_trend7" for c in _ROLL_BASE]
    return _RAW_FEATURES + roll


# --------------------------------------------------------------------------- #
# Model training (called once, cached by main.py)                             #
# --------------------------------------------------------------------------- #
def train_models(data=None):
    """Train the XGBoost breakdown classifier and the IsolationForest anomaly
    detector on the engineered telemetry. Returns everything the payload builder
    needs — fitted models, the feature frame, and the real test-set metrics."""
    if data is None:
        data = _load()
    feat_df = _engineer(data["telemetry"], data["maintenance"])
    cols = _feature_cols()

    # ---- time-based split (earliest 80% train, latest 20% test) -------------
    ordered = feat_df.sort_values("date").reset_index(drop=True)
    split = int(len(ordered) * TRAIN_FRACTION)
    train, test = ordered.iloc[:split], ordered.iloc[split:]
    X_train, y_train = train[cols], train["label"].to_numpy()
    X_test, y_test = test[cols], test["label"].to_numpy()

    # class imbalance (~3% positive) → weight the positive class
    pos = max(1, int(y_train.sum()))
    neg = int((y_train == 0).sum())
    clf = XGBClassifier(
        n_estimators=300, max_depth=4, learning_rate=0.05,
        subsample=0.9, colsample_bytree=0.9,
        scale_pos_weight=neg / pos, eval_metric="logloss",
        random_state=42, n_jobs=-1,
    )
    clf.fit(X_train, y_train)

    pred = clf.predict(X_test)
    metrics = {
        "accuracy": _round(accuracy_score(y_test, pred) * 100, 1),
        "precision": _round(precision_score(y_test, pred, zero_division=0) * 100, 1),
        "recall": _round(recall_score(y_test, pred, zero_division=0) * 100, 1),
        "f1": _round(f1_score(y_test, pred, zero_division=0) * 100, 1),
        "trainRows": int(len(train)), "testRows": int(len(test)),
        "positiveRate": _round(float(feat_df["label"].mean()) * 100, 2),
        "testPositives": int(y_test.sum()),
        "model": "XGBoostClassifier",
        "labelHorizonDays": LABEL_HORIZON_DAYS,
    }

    # ---- IsolationForest on the same feature matrix (unsupervised) ----------
    iso = IsolationForest(n_estimators=200, contamination=0.03, random_state=42, n_jobs=-1)
    iso.fit(feat_df[cols])

    return {
        "clf": clf, "iso": iso, "cols": cols,
        "feat_df": feat_df, "metrics": metrics,
        "data": data,
    }


# --------------------------------------------------------------------------- #
# Section builders                                                             #
# --------------------------------------------------------------------------- #
def _maintenance_risk(fit):
    """Per-vehicle current breakdown risk % — the classifier's probability on the
    most recent telemetry row for each vehicle."""
    df, clf, cols = fit["feat_df"], fit["clf"], fit["cols"]
    latest = df.sort_values("date").groupby("vehicle_id").tail(1).copy()
    proba = clf.predict_proba(latest[cols])[:, 1]
    latest = latest.assign(risk=proba).sort_values("risk", ascending=False)

    rows = []
    for r in latest.itertuples(index=False):
        risk_pct = _round(r.risk * 100, 1)
        rows.append({
            "vehicleId": r.vehicle_id,
            "riskPct": risk_pct,
            "riskLevel": "High" if risk_pct >= 50 else ("Medium" if risk_pct >= 20 else "Low"),
            "brakePadWearPct": _round(r.brake_pad_wear_pct, 1),
            "engineTempAvgC": _round(r.engine_temp_avg_c, 1),
            "engineTempTrend7": _round(r.engine_temp_avg_c_trend7, 1),
            "oilPressurePsi": _round(r.oil_pressure_psi, 1),
            "oilPressureTrend7": _round(r.oil_pressure_psi_trend7, 1),
            "batteryVoltage": _round(r.battery_voltage, 2),
            "odometerKm": _round(r.odometer_km, 0),
            "state": _state(risk_pct >= 20, risk_pct >= 50),
        })
    return rows, {"high": sum(1 for r in rows if r["riskPct"] >= 50),
                  "medium": sum(1 for r in rows if 20 <= r["riskPct"] < 50)}


def _anomalies(fit):
    """IsolationForest anomaly flags on the most recent RECENT_DAYS of data,
    aggregated per vehicle (independent of the supervised model)."""
    df, iso, cols = fit["feat_df"], fit["iso"], fit["cols"]
    df = df.copy()
    df["anom_score"] = -iso.score_samples(df[cols])      # higher = more anomalous
    df["is_anom"] = iso.predict(df[cols]) == -1

    cutoff = df["date_shifted"].max() - pd.Timedelta(days=RECENT_DAYS)
    recent = df[df["date_shifted"] >= cutoff]

    out = []
    for vid, g in recent.groupby("vehicle_id"):
        n_anom = int(g["is_anom"].sum())
        if n_anom == 0:
            continue
        worst = g.loc[g["anom_score"].idxmax()]
        out.append({
            "vehicleId": vid,
            "anomalousDays": n_anom,
            "windowDays": RECENT_DAYS,
            "peakScore": _round(float(g["anom_score"].max()), 3),
            "worstDate": worst["date_shifted"].strftime("%Y-%m-%d"),
            "engineTempMaxC": _round(float(worst["engine_temp_max_c"]), 1),
            "oilPressurePsi": _round(float(worst["oil_pressure_psi"]), 1),
            "batteryVoltage": _round(float(worst["battery_voltage"]), 2),
            "state": "critical" if n_anom >= 4 else "attention",
        })
    out.sort(key=lambda x: (-x["anomalousDays"], -x["peakScore"]))
    total_recent_anom = int(recent["is_anom"].sum())
    return out, {"vehiclesFlagged": len(out), "anomalousDaysRecent": total_recent_anom,
                 "windowDays": RECENT_DAYS}


def _utilisation(data):
    """Days-active vs total days and total distance per vehicle from the trip
    summary; bottom UNDERUSED_QUANTILE by a blended score → underused."""
    trips = data["trips"]
    total_days = int((trips["date"].max() - trips["date"].min()).days) + 1
    all_veh = data["vehicles"]["vehicle_id"].tolist()

    g = trips.groupby("vehicle_id")
    active = g["date"].apply(lambda s: s.dt.normalize().nunique())
    dist = g["distance_km"].sum()
    ntrips = g.size()

    rows = []
    for vid in all_veh:
        a = int(active.get(vid, 0))
        d = _round(float(dist.get(vid, 0.0)), 1)
        n = int(ntrips.get(vid, 0))
        active_pct = _round(100.0 * a / total_days, 1)
        rows.append({"vehicleId": vid, "daysActive": a, "totalDays": total_days,
                     "activePct": active_pct, "totalDistanceKm": d, "trips": n})

    # blended utilisation score = normalised days-active × normalised distance
    max_d = max((r["totalDistanceKm"] for r in rows), default=1.0) or 1.0
    for r in rows:
        r["score"] = _round((r["activePct"] / 100.0) * (r["totalDistanceKm"] / max_d), 4)
    scores = np.array([r["score"] for r in rows])
    threshold = float(np.quantile(scores, UNDERUSED_QUANTILE)) if len(scores) else 0.0
    for r in rows:
        r["underused"] = r["score"] <= threshold
        r["state"] = "attention" if r["underused"] else "flow"

    rows.sort(key=lambda r: r["score"])
    underused = [r["vehicleId"] for r in rows if r["underused"]]
    return rows, {"totalDays": total_days, "underusedCount": len(underused),
                  "underused": underused, "threshold": _round(threshold, 4)}


def _driver_performance(data):
    """Harsh events + fuel efficiency (km/L) per driver, ranked, with a fleet
    z-score flagging drivers statistically worse than the fleet average."""
    trips = data["trips"]
    names = data["drivers"].set_index("driver_id")["name"].to_dict()

    g = trips.groupby("driver_id")
    agg = pd.DataFrame({
        "trips": g.size(),
        "distanceKm": g["distance_km"].sum(),
        "fuelL": g["fuel_used_liters"].sum(),
        "harshBrake": g["harsh_braking_events"].sum(),
        "harshAccel": g["harsh_acceleration_events"].sum(),
        "avgSpeed": g["avg_speed_kmph"].mean(),
    })
    agg["fuelEff"] = agg["distanceKm"] / agg["fuelL"]                 # km per litre
    agg["harshPer100km"] = 100.0 * (agg["harshBrake"] + agg["harshAccel"]) / agg["distanceKm"]

    # fleet z-scores: high harsh-per-100km is bad; low fuel efficiency is bad
    hz = (agg["harshPer100km"] - agg["harshPer100km"].mean()) / (agg["harshPer100km"].std(ddof=0) or 1)
    fz = (agg["fuelEff"].mean() - agg["fuelEff"]) / (agg["fuelEff"].std(ddof=0) or 1)
    agg["harshZ"] = hz
    agg["fuelZ"] = fz
    # composite: higher = worse driver (rougher + thirstier)
    agg["riskZ"] = (hz + fz) / 2.0
    # 0-100 safety score, higher = safer (invert harsh z, centre at 85)
    agg["safety"] = (85 - hz * 12).clip(40, 99)

    agg = agg.sort_values("riskZ")   # best (lowest risk) first
    rank = 1
    rows = []
    for drv_id, r in agg.iterrows():
        worse = bool(r["riskZ"] >= DRIVER_Z_THRESHOLD)
        rows.append({
            "driverId": drv_id, "name": names.get(drv_id, drv_id),
            "rank": rank, "trips": int(r["trips"]),
            "fuelEfficiencyKmL": _round(r["fuelEff"], 2),
            "harshBrakingEvents": int(r["harshBrake"]),
            "harshAccelEvents": int(r["harshAccel"]),
            "harshPer100km": _round(r["harshPer100km"], 2),
            "avgSpeedKmph": _round(r["avgSpeed"], 1),
            "safetyScore": int(round(r["safety"])),
            "riskZ": _round(r["riskZ"], 2),
            "worseThanFleet": worse,
            "state": "attention" if worse else "flow",
        })
        rank += 1

    worst = rows[-3:][::-1]     # highest riskZ
    best = rows[:3]
    flagged = [r for r in rows if r["worseThanFleet"]]
    summary = {
        "drivers": len(rows),
        "flaggedCount": len(flagged),
        "fleetAvgFuelEff": _round(float(agg["fuelEff"].mean()), 2),
        "fleetAvgHarshPer100km": _round(float(agg["harshPer100km"].mean()), 2),
        "best": [{"driverId": r["driverId"], "name": r["name"],
                  "fuelEfficiencyKmL": r["fuelEfficiencyKmL"], "safetyScore": r["safetyScore"]}
                 for r in best],
        "worst": [{"driverId": r["driverId"], "name": r["name"],
                   "fuelEfficiencyKmL": r["fuelEfficiencyKmL"], "safetyScore": r["safetyScore"],
                   "harshPer100km": r["harshPer100km"]} for r in worst],
    }
    return rows, summary


def _fuel_analytics(data):
    """Per-vehicle km/L trend + recent-vs-baseline degradation flag, plus an
    8-week fleet efficiency series and a per-driver efficiency table."""
    trips = data["trips"].copy()
    trips["eff"] = trips["distance_km"] / trips["fuel_used_liters"]
    max_d = trips["date_shifted"].max()

    # ---- per-vehicle: recent 30 days vs its own earlier baseline ------------
    cutoff = max_d - pd.Timedelta(days=FUEL_RECENT_DAYS)
    per_vehicle = []
    degrading = []
    for vid, g in trips.groupby("vehicle_id"):
        recent = g[g["date_shifted"] >= cutoff]
        baseline = g[g["date_shifted"] < cutoff]
        if len(recent) < 3 or len(baseline) < 3:
            continue
        r_eff = float(recent["eff"].mean())
        b_eff = float(baseline["eff"].mean())
        change_pct = _round((r_eff - b_eff) / b_eff * 100, 1)
        is_deg = change_pct <= -FUEL_DEGRADE_PCT
        row = {
            "vehicleId": vid,
            "recentKmL": _round(r_eff, 2),
            "baselineKmL": _round(b_eff, 2),
            "changePct": change_pct,
            "degrading": is_deg,
            "state": "attention" if is_deg else "flow",
        }
        per_vehicle.append(row)
        if is_deg:
            degrading.append(vid)
    per_vehicle.sort(key=lambda r: r["changePct"])

    # ---- fleet weekly efficiency series (last 8 weeks) ----------------------
    trips["week"] = trips["date_shifted"].dt.to_period("W").apply(lambda p: p.start_time)
    weekly = trips.groupby("week")["eff"].mean().sort_index().tail(8)
    fuel_weeks = [{"label": f"W{i+1}", "date": w.strftime("%Y-%m-%d"), "kmL": _round(v, 2)}
                  for i, (w, v) in enumerate(weekly.items())]

    # ---- per-driver efficiency (compact) ------------------------------------
    dg = trips.groupby("driver_id")
    per_driver = [{"driverId": did, "kmL": _round(float(v), 2)}
                  for did, v in (dg["distance_km"].sum() / dg["fuel_used_liters"].sum()).items()]
    per_driver.sort(key=lambda r: -r["kmL"])

    fleet_eff = _round(float(trips["distance_km"].sum() / trips["fuel_used_liters"].sum()), 2)
    return {
        "fleetAvgKmL": fleet_eff,
        "fuelWeeks": fuel_weeks,
        "perVehicle": per_vehicle,
        "perDriver": per_driver,
        "degradingVehicles": degrading,
        "recentWindowDays": FUEL_RECENT_DAYS,
        "degradeThresholdPct": FUEL_DEGRADE_PCT,
    }


def _suggested_window(vid, trips, max_shifted):
    """Suggest the vehicle's next typically-idle weekday as a service window —
    the least-used day-of-week for that vehicle, on the nearest upcoming date."""
    g = trips[trips["vehicle_id"] == vid]
    if g.empty:
        target_dow = 5     # default to Saturday for a truck with no trips
    else:
        counts = g["date_shifted"].dt.dayofweek.value_counts()
        target_dow = int(min(range(7), key=lambda d: counts.get(d, 0)))
    # nearest upcoming date (from tomorrow) matching that day-of-week
    base = max_shifted.normalize() + pd.Timedelta(days=1)
    delta = (target_dow - base.dayofweek) % 7
    day = base + pd.Timedelta(days=delta)
    return day.strftime("%Y-%m-%d")


def _maintenance_schedule(risk_rows, anomaly_rows, fuel, data):
    """Combine breakdown risk + recent anomalies (+ fuel degradation) into a
    prioritised service list. High risk AND recent anomalies → top priority."""
    anom_by_veh = {a["vehicleId"]: a for a in anomaly_rows}
    deg = set(fuel["degradingVehicles"])
    trips = data["trips"]
    max_shifted = trips["date_shifted"].max()

    sched = []
    for r in risk_rows:
        vid = r["vehicleId"]
        a = anom_by_veh.get(vid)
        has_anom = a is not None
        is_deg = vid in deg
        # priority score: risk drives it, anomalies and fuel decay add urgency
        score = r["riskPct"] + (25 if has_anom else 0) + (10 if is_deg else 0)
        if r["riskPct"] >= 50 and has_anom:
            priority, state = "Critical", "critical"
        elif r["riskPct"] >= 50 or (r["riskPct"] >= 20 and has_anom):
            priority, state = "High", "attention"
        elif r["riskPct"] >= 20 or has_anom or is_deg:
            priority, state = "Medium", "attention"
        else:
            priority, state = "Routine", "flow"

        reasons = []
        if r["riskPct"] >= 20:
            reasons.append(f"{r['riskPct']}% breakdown risk")
        if has_anom:
            reasons.append(f"{a['anomalousDays']} anomalous day(s)")
        if is_deg:
            reasons.append("fuel economy degrading")
        if r["brakePadWearPct"] >= 80:
            reasons.append(f"brake wear {r['brakePadWearPct']}%")

        sched.append({
            "vehicleId": vid,
            "priority": priority,
            "score": _round(score, 1),
            "riskPct": r["riskPct"],
            "anomalousDays": a["anomalousDays"] if has_anom else 0,
            "fuelDegrading": is_deg,
            "reason": "; ".join(reasons) if reasons else "Scheduled routine service",
            "suggestedWindow": _suggested_window(vid, trips, max_shifted),
            "state": state,
        })

    order = {"Critical": 0, "High": 1, "Medium": 2, "Routine": 3}
    sched.sort(key=lambda s: (order[s["priority"]], -s["score"]))
    return sched


# --------------------------------------------------------------------------- #
# Build the dashboard payload                                                  #
# --------------------------------------------------------------------------- #
def build_payload(fit=None):
    if fit is None:
        fit = train_models()
    data = fit["data"]

    risk_rows, risk_summary = _maintenance_risk(fit)
    anomaly_rows, anomaly_summary = _anomalies(fit)
    util_rows, util_summary = _utilisation(data)
    driver_rows, driver_summary = _driver_performance(data)
    fuel = _fuel_analytics(data)
    schedule = _maintenance_schedule(risk_rows, anomaly_rows, fuel, data)

    m = fit["metrics"]
    fleet_health = _round(
        100.0
        - risk_summary["high"] * 6
        - risk_summary["medium"] * 2
        - anomaly_summary["vehiclesFlagged"] * 3
        - len(fuel["degradingVehicles"]) * 2,
        0,
    )
    fleet_health = max(0, min(100, int(fleet_health)))
    in_service = int((data["vehicles"]["status"] == "active").sum())
    avg_util = _round(float(np.mean([r["activePct"] for r in util_rows])), 0) if util_rows else 0

    kpis = [
        {"label": "Fleet Health", "value": str(fleet_health), "delta": "/ 100",
         "state": "flow" if fleet_health >= 75 else "attention"},
        {"label": "Avg Utilization", "value": f"{avg_util}%",
         "delta": f"{util_summary['underusedCount']} underused",
         "state": "attention" if util_summary["underusedCount"] else "flow"},
        {"label": "Units In Service", "value": str(in_service),
         "delta": f"of {len(data['vehicles'])}", "state": "flow"},
        {"label": "Due Maintenance",
         "value": str(sum(1 for s in schedule if s["priority"] in ("Critical", "High", "Medium"))),
         "delta": f"{risk_summary['high']} high-risk",
         "state": "attention" if risk_summary["high"] else "flow"},
    ]

    return {
        "kpis": kpis,
        "maintenanceRisk": {
            "modelMetrics": {
                "accuracy": m["accuracy"], "precision": m["precision"],
                "recall": m["recall"], "f1": m["f1"],
                "model": m["model"], "labelHorizonDays": m["labelHorizonDays"],
                "trainRows": m["trainRows"], "testRows": m["testRows"],
                "testPositives": m["testPositives"], "positiveRatePct": m["positiveRate"],
            },
            "vehicles": risk_rows,
            "highRiskCount": risk_summary["high"],
            "mediumRiskCount": risk_summary["medium"],
        },
        "anomalies": {
            "vehicles": anomaly_rows,
            "summary": anomaly_summary,
            "model": "IsolationForest",
        },
        "vehicleUtilization": {"vehicles": util_rows, "summary": util_summary},
        "driverPerformance": {"drivers": driver_rows, "summary": driver_summary},
        "fuelAnalytics": fuel,
        "maintenanceSchedule": schedule,
        "meta": {
            "dayOffset": data["offset"],
            "telemetryRows": int(len(data["telemetry"])),
            "maintenanceRecords": int(len(data["maintenance"])),
            "tripRecords": int(len(data["trips"])),
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
        },
    }


if __name__ == "__main__":
    fit = train_models()
    p = build_payload(fit)
    m = p["maintenanceRisk"]["modelMetrics"]
    print(f"Breakdown classifier ({m['model']}): "
          f"acc={m['accuracy']}% prec={m['precision']}% rec={m['recall']}% f1={m['f1']}% "
          f"(test {m['testRows']} rows, {m['testPositives']} positives)")
    print(f"High-risk vehicles: {p['maintenanceRisk']['highRiskCount']} · "
          f"medium: {p['maintenanceRisk']['mediumRiskCount']}")
    a = p["anomalies"]["summary"]
    print(f"Anomalies (last {a['windowDays']}d): {a['vehiclesFlagged']} vehicles, "
          f"{a['anomalousDaysRecent']} anomalous vehicle-days")
    u = p["vehicleUtilization"]["summary"]
    print(f"Underused vehicles ({u['underusedCount']}): {u['underused']}")
    ds = p["driverPerformance"]["summary"]
    print(f"Drivers: {ds['drivers']} · flagged worse-than-fleet: {ds['flaggedCount']}")
    print(f"  Best:  {[b['name'] for b in ds['best']]}")
    print(f"  Worst: {[w['name'] for w in ds['worst']]}")
    print(f"Fuel: fleet {p['fuelAnalytics']['fleetAvgKmL']} km/L · "
          f"degrading: {p['fuelAnalytics']['degradingVehicles']}")
    print(f"Schedule top: "
          f"{[(s['vehicleId'], s['priority']) for s in p['maintenanceSchedule'][:5]]}")
