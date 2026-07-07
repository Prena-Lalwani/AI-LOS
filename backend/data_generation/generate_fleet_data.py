"""
generate_fleet_data.py — self-generated synthetic Fleet Intelligence dataset.

Produces three CSVs under backend/data/fleet/ that drive the Fleet Intelligence
module. It REUSES the 15 trucks and 25 drivers already generated for Dispatch
(backend/data/dispatch/vehicles.csv + drivers.csv) — it does NOT recreate them —
so the fleet, dispatch and warehouse views all speak about the same assets.

The whole point of this dataset is that the machine-learning layer downstream
recovers *real* signal, not noise:

  * vehicle_telemetry.csv — 15 vehicles × 365 daily rows (=5,475). Sensors sit at
    healthy baselines with slow age-related drift (engine runs a touch hotter and
    oil pressure sags as the odometer climbs). Brake-pad wear accumulates with
    distance and RESETS to ~0 at each brake replacement. Crucially, in the 15 days
    LEADING UP TO a simulated breakdown the relevant sensors degrade on a ramp
    (engine temp climbs, oil pressure / battery / tyre pressure sag) and ~half of
    the days in the 5-15-day precursor window also get an acute spike/dip. That
    ramp is what a supervised model learns; the acute spikes are what an
    unsupervised IsolationForest catches. Anomalous vehicle-days land at ~3%.

  * maintenance_history.csv — ~400 records: frequent routine services, scattered
    repairs, brake replacements (fired when wear crosses threshold) and — the ones
    that matter — BREAKDOWN records whose date + component match the anomaly
    windows injected above. Labelling a telemetry day "breakdown within 10 days"
    therefore lines up with genuinely degrading sensors.

  * driver_trip_summary.csv — ~2,000 trip rows. Each DRIVER carries a hidden
    behaviour profile (roughness → harsh braking/accel, and a fuel-economy factor)
    that is consistent across ALL their trips, so driver comparisons are real, not
    random. Each VEHICLE has an activity level (some trucks barely move → they fall
    in the bottom-20% utilisation band) and a few trucks lose fuel economy over the
    final ~40 days — an early degradation signal the fuel analytics surfaces and
    cross-references with breakdown risk.

Historical dates are anchored to a fixed past window ending 2024-12-30; the model
layer shifts the labels forward to "today" at serve time (same pattern as the
warehouse / inventory / dispatch modules).

Deterministic: np.random.seed(42) (+ random seed) so re-running produces
byte-identical CSVs. Prints row counts + a signal summary when done.

Run:
    cd backend
    python -m data_generation.generate_fleet_data
      (or)  python data_generation/generate_fleet_data.py
"""

import os
import random

import numpy as np
import pandas as pd

# --------------------------------------------------------------------------- #
# Determinism                                                                  #
# --------------------------------------------------------------------------- #
SEED = 42
np.random.seed(SEED)
random.seed(SEED)

# --------------------------------------------------------------------------- #
# Paths — reuse the Dispatch fleet, write into data/fleet/                     #
# --------------------------------------------------------------------------- #
_HERE = os.path.dirname(__file__)
DISPATCH_DIR = os.path.join(_HERE, "..", "data", "dispatch")
VEHICLES_CSV = os.path.join(DISPATCH_DIR, "vehicles.csv")
DRIVERS_CSV = os.path.join(DISPATCH_DIR, "drivers.csv")
OUT_DIR = os.path.join(_HERE, "..", "data", "fleet")
os.makedirs(OUT_DIR, exist_ok=True)

# --------------------------------------------------------------------------- #
# Simulation constants                                                         #
# --------------------------------------------------------------------------- #
N_DAYS = 365
ANCHOR_END = pd.Timestamp("2024-12-30")            # last historical day; shifted
DATES = pd.date_range(end=ANCHOR_END, periods=N_DAYS, freq="D")

N_TRIPS = 2_000

# Healthy sensor baselines (a well vehicle on an ordinary day).
BASE_ENGINE_TEMP_AVG = 88.0        # °C
BASE_ENGINE_TEMP_MAX_GAP = 12.0    # max sits ~12°C above the average
BASE_OIL_PRESSURE = 42.0           # psi
BASE_BATTERY_V = 13.9              # volts (engine running / charging)
BASE_TIRE_PSI = 35.0               # psi

# Brake-pad wear accrues with distance; a pad is replaced near this threshold.
BRAKE_WEAR_PER_KM = 100.0 / 42_000.0   # ~full wear over ~42k km of service
BRAKE_REPLACE_AT = 100.0

# Precursor window: sensors degrade on a ramp over the 15 days before a
# breakdown; the 5-15 day slice also gets acute spikes ~half the time.
PRECURSOR_DAYS = 15
ACUTE_LO, ACUTE_HI = 5, 15         # "precede a breakdown by 5-15 days"
ACUTE_PROB = 0.5

# Breakdown components and the sensor signature each one degrades.
BREAKDOWN_COMPONENTS = ["engine", "brakes", "battery", "tires", "transmission"]

# Maintenance cost / downtime envelopes by type (USD, hours).
COST = {
    "routine":   (120, 480),
    "repair":    (350, 1600),
    "breakdown": (1400, 6200),
}
DOWNTIME = {
    "routine":   (1.0, 4.0),
    "repair":    (4.0, 18.0),
    "breakdown": (12.0, 72.0),
}


# --------------------------------------------------------------------------- #
# 0. Load the existing fleet (do NOT recreate it)                             #
# --------------------------------------------------------------------------- #
vehicles = pd.read_csv(VEHICLES_CSV)
drivers = pd.read_csv(DRIVERS_CSV)
VEH_IDS = vehicles["vehicle_id"].tolist()
VEH = {r.vehicle_id: r for r in vehicles.itertuples(index=False)}


# --------------------------------------------------------------------------- #
# Per-vehicle hidden state: usage level, starting odometer, breakdown events,  #
# late-period fuel-economy decay.                                              #
# --------------------------------------------------------------------------- #
def _vehicle_profiles():
    """Assign each vehicle a daily-usage level, an initial odometer (age proxy),
    its breakdown events (day-index + component) and whether its fuel economy
    decays over the final weeks. Older / harder-worked trucks break down more."""
    profiles = {}
    # ~24 breakdowns spread across the fleet, weighted toward busier/older trucks.
    # Draw a per-vehicle intensity, then allocate breakdown counts from it.
    intensity = {vid: float(np.random.uniform(0.4, 1.6)) for vid in VEH_IDS}
    # trucks flagged 'maintenance' in the roster are the tired ones → nudge up
    for vid in VEH_IDS:
        if str(VEH[vid].status) == "maintenance":
            intensity[vid] += 0.8

    # pick the ~3 trucks (of 15) whose fuel economy sags in the last ~40 days
    decay_vehicles = set(np.random.choice(VEH_IDS, size=3, replace=False).tolist())
    # pick ~3 trucks that are CURRENTLY degrading toward an imminent breakdown a
    # few days past the last telemetry day — this is what makes "current
    # breakdown risk" and "recent anomalies" light up on the served "today".
    impending_vehicles = set(np.random.choice(VEH_IDS, size=3, replace=False).tolist())

    for vid in VEH_IDS:
        base_km = float(np.random.uniform(70, 240))          # avg km on a driving day
        start_odo = float(np.random.uniform(18_000, 190_000))
        # breakdown count: 0-3, more likely on high-intensity trucks
        lam = intensity[vid]
        n_bd = int(min(3, np.random.poisson(lam=lam)))
        events = []
        used_days = []
        for _ in range(n_bd):
            # keep windows inside the series (need 15 days of precursor before,
            # and a little history after) and bias toward the second half.
            for _try in range(20):
                day = int(np.random.randint(PRECURSOR_DAYS + 5, N_DAYS - 3))
                if all(abs(day - u) > 25 for u in used_days):   # space them out
                    break
            used_days.append(day)
            comp = random.choice(BREAKDOWN_COMPONENTS)
            events.append({"day": day, "component": comp})
        # impending breakdown: 2-6 days AFTER the last telemetry day. Its 15-day
        # precursor ramp therefore covers the final rows, so the most recent
        # snapshot reads as high-risk. It gets a (near-future-dated) breakdown
        # record too, so labels + reported metrics stay consistent.
        if vid in impending_vehicles:
            events.append({"day": N_DAYS - 1 + int(np.random.randint(2, 7)),
                           "component": random.choice(BREAKDOWN_COMPONENTS)})
        profiles[vid] = {
            "base_km": base_km,
            "start_odo": start_odo,
            "events": sorted(events, key=lambda e: e["day"]),
            "fuel_decays": vid in decay_vehicles,
        }
    return profiles, decay_vehicles


PROFILES, DECAY_VEHICLES = _vehicle_profiles()


# --------------------------------------------------------------------------- #
# 1. vehicle_telemetry.csv                                                     #
# --------------------------------------------------------------------------- #
def _precursor_factor(day_idx, events):
    """Return (ramp, acute, component) for a given day.

    ramp   ∈ [0,1] — smooth degradation that grows as the breakdown approaches
                     (strongest the day before). Drives the supervised signal.
    acute  ∈ {0,1} — a sharp spike/dip injected on ~half the days in the
                     5-15-day precursor slice. Drives the unsupervised signal.
    component      — which sensor signature to degrade (None if healthy day).
    """
    best = (0.0, 0, None)
    for e in events:
        db = e["day"] - day_idx                       # days before the breakdown
        if 1 <= db <= PRECURSOR_DAYS:
            ramp = (PRECURSOR_DAYS + 1 - db) / PRECURSOR_DAYS   # →1 as db→1
            acute = 1 if (ACUTE_LO <= db <= ACUTE_HI and np.random.random() < ACUTE_PROB) else 0
            if ramp > best[0] or acute > best[1]:
                best = (ramp, acute, e["component"])
    return best


def gen_telemetry():
    rows = []
    anomaly_days = 0
    brake_events = []          # (vehicle_id, day_index) → brake replacement records

    for vid in VEH_IDS:
        p = PROFILES[vid]
        odo = p["start_odo"]
        brake_wear = float(np.random.uniform(5, 45))     # varied starting wear
        events = p["events"]

        for i, d in enumerate(DATES):
            dow = d.dayofweek
            # daily distance: lighter on weekends, some genuine no-drive days
            drive = np.random.random() > (0.18 if dow >= 5 else 0.04)
            km = 0.0
            if drive:
                factor = 0.55 if dow >= 5 else 1.0
                km = max(0.0, np.random.normal(p["base_km"] * factor,
                                               p["base_km"] * 0.22))
            odo += km

            # brake wear accrues with distance; replace near threshold + reset
            brake_wear += km * BRAKE_WEAR_PER_KM
            if brake_wear >= BRAKE_REPLACE_AT:
                brake_events.append((vid, i))
                brake_wear = float(np.random.uniform(1, 4))

            # slow age drift: hotter engine + weaker oil pressure with odometer
            age = odo / 300_000.0                        # ~0..0.7 over the fleet
            temp_avg = BASE_ENGINE_TEMP_AVG + age * 6.0 + np.random.normal(0, 1.6)
            oil = BASE_OIL_PRESSURE - age * 5.0 + np.random.normal(0, 1.4)
            batt = BASE_BATTERY_V + np.random.normal(0, 0.12)
            tire = BASE_TIRE_PSI + np.random.normal(0, 0.9)
            temp_max = temp_avg + BASE_ENGINE_TEMP_MAX_GAP + abs(np.random.normal(0, 1.8))

            # ---- precursor degradation before a breakdown -------------------
            ramp, acute, comp = _precursor_factor(i, events)
            if comp is not None and (ramp > 0 or acute):
                spike = 1.0 if acute else 0.0
                if comp == "engine":
                    temp_avg += ramp * 14.0 + spike * np.random.uniform(6, 12)
                    temp_max += ramp * 20.0 + spike * np.random.uniform(8, 16)
                    oil -= ramp * 11.0 + spike * np.random.uniform(3, 7)
                elif comp == "transmission":
                    temp_avg += ramp * 9.0 + spike * np.random.uniform(4, 8)
                    temp_max += ramp * 12.0 + spike * np.random.uniform(5, 10)
                    oil -= ramp * 7.0 + spike * np.random.uniform(2, 5)
                elif comp == "battery":
                    batt -= ramp * 1.9 + spike * np.random.uniform(0.4, 0.9)
                elif comp == "tires":
                    tire -= ramp * 8.0 + spike * np.random.uniform(2, 5)
                elif comp == "brakes":
                    # push wear up hard so it's clearly near end-of-life
                    brake_wear = min(99.5, brake_wear + ramp * 30.0 + spike * 8.0)
                    temp_avg += ramp * 3.0
                # count a "material" anomaly day (what we call ~3%)
                if acute or ramp >= 0.6:
                    anomaly_days += 1

            # clamp to physically sane ranges
            temp_avg = float(np.clip(temp_avg, 70, 130))
            temp_max = float(np.clip(temp_max, temp_avg + 3, 155))
            oil = float(np.clip(oil, 12, 60))
            batt = float(np.clip(batt, 10.5, 14.6))
            tire = float(np.clip(tire, 20, 40))

            # fuel + idle: fuel from distance & vehicle efficiency; late-period
            # economy decay on selected trucks (early degradation signal)
            eff = float(VEH[vid].fuel_efficiency_km_per_liter)
            decay = 1.0
            if p["fuel_decays"] and i >= N_DAYS - 40:
                decay = 1.0 - 0.22 * ((i - (N_DAYS - 40)) / 40.0)   # up to -22%
            fuel = (km / (eff * decay)) if km > 0 else 0.0
            fuel += abs(np.random.normal(0, 0.4)) if km > 0 else 0.0
            idle = max(0.0, np.random.normal(38 if drive else 6, 14))

            rows.append({
                "date": d.strftime("%Y-%m-%d"),
                "vehicle_id": vid,
                "odometer_km": round(odo, 1),
                "engine_temp_avg_c": round(temp_avg, 1),
                "engine_temp_max_c": round(temp_max, 1),
                "oil_pressure_psi": round(oil, 1),
                "battery_voltage": round(batt, 2),
                "brake_pad_wear_pct": round(brake_wear, 1),
                "tire_pressure_avg_psi": round(tire, 1),
                "fuel_consumed_liters": round(fuel, 2),
                "idle_time_minutes": int(round(idle)),
            })

    return pd.DataFrame(rows), brake_events, anomaly_days


# --------------------------------------------------------------------------- #
# 2. maintenance_history.csv                                                   #
# --------------------------------------------------------------------------- #
def _cost_downtime(mtype):
    lo, hi = COST[mtype]
    cost = round(float(np.random.uniform(lo, hi)), 2)
    lo, hi = DOWNTIME[mtype]
    down = round(float(np.random.uniform(lo, hi)), 1)
    return cost, down


def gen_maintenance(brake_events):
    """Assemble ~400 records: breakdowns (aligned to the injected anomaly
    windows), brake replacements (from the wear-threshold events), scheduled
    routine services, and scattered repairs."""
    records = []

    # 2a. breakdowns — dated exactly on the injected breakdown day + component.
    # Impending events sit a few days past the last telemetry day; date them
    # relative to the anchor so their (near-future) record still lines up with
    # the precursor ramp injected into the final telemetry rows.
    for vid in VEH_IDS:
        for e in PROFILES[vid]["events"]:
            if e["day"] < N_DAYS:
                dt = DATES[e["day"]]
            else:
                dt = ANCHOR_END + pd.Timedelta(days=e["day"] - (N_DAYS - 1))
            cost, down = _cost_downtime("breakdown")
            records.append({
                "vehicle_id": vid,
                "date": dt.strftime("%Y-%m-%d"),
                "maintenance_type": "breakdown",
                "component": e["component"],
                "cost": cost,
                "downtime_hours": down,
            })

    # 2b. brake replacements — recorded as routine 'brakes' at each reset day
    for vid, day_idx in brake_events:
        cost, down = _cost_downtime("routine")
        records.append({
            "vehicle_id": vid,
            "date": DATES[day_idx].strftime("%Y-%m-%d"),
            "maintenance_type": "routine",
            "component": "brakes",
            "cost": cost,
            "downtime_hours": down,
        })

    # 2c. scheduled routine services — every ~24-38 days per vehicle
    for vid in VEH_IDS:
        day = int(np.random.randint(8, 30))
        while day < N_DAYS:
            comp = random.choices(
                ["engine", "tires", "battery", "transmission", "brakes"],
                weights=[0.34, 0.24, 0.16, 0.14, 0.12])[0]
            cost, down = _cost_downtime("routine")
            records.append({
                "vehicle_id": vid,
                "date": DATES[day].strftime("%Y-%m-%d"),
                "maintenance_type": "routine",
                "component": comp,
                "cost": cost,
                "downtime_hours": down,
            })
            day += int(np.random.randint(24, 39))

    # 2d. scattered repairs — top up toward ~400 total records
    target_total = 400
    n_repairs = max(0, target_total - len(records))
    for _ in range(n_repairs):
        vid = random.choice(VEH_IDS)
        day = int(np.random.randint(0, N_DAYS))
        comp = random.choice(["engine", "brakes", "tires", "battery", "transmission"])
        cost, down = _cost_downtime("repair")
        records.append({
            "vehicle_id": vid,
            "date": DATES[day].strftime("%Y-%m-%d"),
            "maintenance_type": "repair",
            "component": comp,
            "cost": cost,
            "downtime_hours": down,
        })

    df = pd.DataFrame(records).sort_values(["date", "vehicle_id"]).reset_index(drop=True)
    df.insert(0, "record_id", [f"MNT-{i:05d}" for i in range(1, len(df) + 1)])
    return df


# --------------------------------------------------------------------------- #
# 3. driver_trip_summary.csv                                                   #
# --------------------------------------------------------------------------- #
def _driver_profiles():
    """Hidden per-driver behaviour: a roughness factor (drives harsh braking /
    acceleration) and a fuel-economy factor (smooth, economical drivers get more
    km per litre). Consistent across every trip that driver takes."""
    profiles = {}
    for drv in drivers.itertuples(index=False):
        rough = float(np.clip(np.random.normal(1.0, 0.35), 0.4, 2.1))
        # smoother drivers (low rough) tend to be more economical → correlate
        fuel_factor = float(np.clip(np.random.normal(1.05 - 0.12 * (rough - 1.0), 0.06),
                                    0.82, 1.22))
        profiles[drv.driver_id] = {
            "warehouse": drv.home_warehouse_id,
            "rough": rough,
            "fuel_factor": fuel_factor,
        }
    return profiles


def gen_trips():
    dprof = _driver_profiles()
    # driver / vehicle pools per warehouse (keep assignments coherent with dispatch)
    drv_by_wh, veh_by_wh = {}, {}
    for drv in drivers.itertuples(index=False):
        drv_by_wh.setdefault(drv.home_warehouse_id, []).append(drv.driver_id)
    for v in vehicles.itertuples(index=False):
        veh_by_wh.setdefault(v.warehouse_id, []).append(v.vehicle_id)
    warehouses = list(veh_by_wh.keys())

    # per-vehicle activity weight → some trucks barely move (bottom-20% underused)
    veh_activity = {vid: float(np.random.uniform(0.15, 1.0)) for vid in VEH_IDS}
    for vid in VEH_IDS:
        if str(VEH[vid].status) == "maintenance":
            veh_activity[vid] *= 0.35        # sidelined trucks run few trips
    veh_ids = list(veh_activity.keys())
    veh_w = np.array([veh_activity[v] for v in veh_ids])
    veh_w = veh_w / veh_w.sum()

    rows = []
    for t in range(1, N_TRIPS + 1):
        vid = str(np.random.choice(veh_ids, p=veh_w))
        wh = VEH[vid].warehouse_id
        drv_id = random.choice(drv_by_wh[wh])
        dp = dprof[drv_id]
        i = int(np.random.randint(0, N_DAYS))
        d = DATES[i]

        distance = float(np.clip(np.random.normal(120, 55), 18, 320))
        v_speed = float(VEH[vid].avg_speed_kmph)
        avg_speed = float(np.clip(np.random.normal(v_speed, 5) - (dp["rough"] - 1) * 3,
                                  30, 95))

        # harsh events scale with distance and the driver's roughness
        legs = distance / 20.0
        hb = int(np.random.poisson(max(0.05, legs * 0.45 * dp["rough"])))
        ha = int(np.random.poisson(max(0.05, legs * 0.38 * dp["rough"])))

        # fuel: distance / (vehicle eff × driver economy × late-period decay)
        eff = float(VEH[vid].fuel_efficiency_km_per_liter)
        decay = 1.0
        if PROFILES[vid]["fuel_decays"] and i >= N_DAYS - 40:
            decay = 1.0 - 0.22 * ((i - (N_DAYS - 40)) / 40.0)
        fuel_used = distance / max(4.0, eff * dp["fuel_factor"] * decay)
        fuel_used *= (1.0 + np.random.normal(0, 0.04))
        idle = max(0.0, np.random.normal(22 + (dp["rough"] - 1) * 8, 9))

        rows.append({
            "trip_id": f"TRIP-{t:05d}",
            "driver_id": drv_id,
            "vehicle_id": vid,
            "date": d.strftime("%Y-%m-%d"),
            "distance_km": round(distance, 1),
            "fuel_used_liters": round(fuel_used, 2),
            "harsh_braking_events": hb,
            "harsh_acceleration_events": ha,
            "avg_speed_kmph": round(avg_speed, 1),
            "idle_time_minutes": int(round(idle)),
        })

    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #
def main():
    telemetry, brake_events, anomaly_days = gen_telemetry()
    maintenance = gen_maintenance(brake_events)
    trips = gen_trips()

    files = {
        "vehicle_telemetry.csv": telemetry,
        "maintenance_history.csv": maintenance,
        "driver_trip_summary.csv": trips,
    }
    print("Reused fleet from", os.path.normpath(VEHICLES_CSV),
          "+", os.path.normpath(DRIVERS_CSV),
          f"-> {len(VEH_IDS)} vehicles, {len(drivers)} drivers")
    for fname, df in files.items():
        path = os.path.join(OUT_DIR, fname)
        df.to_csv(path, index=False)
        print(f"  {fname:<26} {len(df):>6,} rows")

    # signal summary
    n_breakdowns = int((maintenance["maintenance_type"] == "breakdown").sum())
    n_brake_resets = len(brake_events)
    pct_anom = 100.0 * anomaly_days / len(telemetry)
    type_counts = maintenance["maintenance_type"].value_counts().to_dict()
    print(f"Breakdown events: {n_breakdowns} · brake replacements: {n_brake_resets} · "
          f"anomaly vehicle-days: {anomaly_days} ({pct_anom:.1f}%)")
    print(f"Maintenance mix: {type_counts}")
    print(f"Fuel-economy-decaying trucks (late 40d): {sorted(DECAY_VEHICLES)}")
    print(f"Telemetry span {telemetry['date'].min()}..{telemetry['date'].max()}")


if __name__ == "__main__":
    main()
