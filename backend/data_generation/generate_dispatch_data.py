"""
generate_dispatch_data.py — self-generated synthetic dispatch dataset.

Produces a self-consistent set of CSVs under backend/data/dispatch/ that drive
the Dispatch Intelligence module. It REUSES the 3 warehouses already generated in
backend/data/warehouse/warehouses.csv (Chicago / Dallas / Los Angeles) — it does
not recreate them — and scatters drivers, trucks, customers, fuel stations and
orders around those real warehouse coordinates.

The historical data (orders + trip logs) is anchored to a fixed past window
ending 2024-12-30; the model layer shifts the date labels forward to "today" at
serve time (same pattern as the warehouse/inventory module).

Crucially, trip_logs.actual_duration_min is a *genuine* function of num_stops,
total_distance_km, traffic_level and weather_condition (plus modest noise) — so a
regressor trained on it recovers real signal, it is not random.

Deterministic: np.random.seed(42) (+ Faker/random seeds) so re-running produces
byte-identical CSVs. Prints row counts for every file when done.

Run:
    cd backend
    python -m data_generation.generate_dispatch_data
      (or)  python data_generation/generate_dispatch_data.py
"""

import math
import os
import random

import numpy as np
import pandas as pd
from faker import Faker

# --------------------------------------------------------------------------- #
# Determinism                                                                  #
# --------------------------------------------------------------------------- #
SEED = 42
np.random.seed(SEED)
random.seed(SEED)
fake = Faker()
Faker.seed(SEED)

# --------------------------------------------------------------------------- #
# Paths                                                                        #
# --------------------------------------------------------------------------- #
_HERE = os.path.dirname(__file__)
WAREHOUSE_CSV = os.path.join(_HERE, "..", "data", "warehouse", "warehouses.csv")
OUT_DIR = os.path.join(_HERE, "..", "data", "dispatch")
os.makedirs(OUT_DIR, exist_ok=True)

# --------------------------------------------------------------------------- #
# Simulation constants                                                         #
# --------------------------------------------------------------------------- #
N_DRIVERS = 25
N_VEHICLES = 15
N_CUSTOMERS = 200
N_FUEL_STATIONS = 12
N_ORDER_DAYS = 30
ORDERS_PER_DAY_MIN, ORDERS_PER_DAY_MAX = 40, 80
N_TRIP_LOGS = 2_000
DELIVERY_RADIUS_KM = 80.0                          # customers scatter within ~80km
ANCHOR_END = pd.Timestamp("2024-12-30")            # last historical day; shifted
                                                   # forward to "today" at serve time

LICENSE_TYPES = ["CDL-A", "CDL-B", "CDL-C"]
WEATHER = ["clear", "rain", "fog", "snow"]
WEATHER_P = [0.62, 0.22, 0.09, 0.07]
TRAFFIC = ["low", "medium", "high"]
TRAFFIC_P = [0.45, 0.38, 0.17]

# Multipliers that make actual trip duration LEARNABLE from the features. These
# are the true relationships the RandomForestRegressor is meant to recover.
TRAFFIC_MULT = {"low": 1.00, "medium": 1.25, "high": 1.60}
WEATHER_MULT = {"clear": 1.00, "rain": 1.15, "fog": 1.22, "snow": 1.42}
LOG_SPEED_KMPH = 55.0                              # effective speed baked into logs
SERVICE_MIN_PER_STOP = 9.0                         # minutes handled per stop


# --------------------------------------------------------------------------- #
# Geo helpers                                                                  #
# --------------------------------------------------------------------------- #
def _offset_latlng(lat, lng, dist_km, bearing_rad):
    """Move (lat,lng) by dist_km along bearing (equirectangular approximation)."""
    dlat = (dist_km * math.cos(bearing_rad)) / 111.0
    dlng = (dist_km * math.sin(bearing_rad)) / (111.0 * math.cos(math.radians(lat)))
    return lat + dlat, lng + dlng


# --------------------------------------------------------------------------- #
# 0. Load the existing warehouses (do NOT recreate them)                       #
# --------------------------------------------------------------------------- #
warehouses = pd.read_csv(WAREHOUSE_CSV)
WH_IDS = warehouses["warehouse_id"].tolist()
WH = {r.warehouse_id: r for r in warehouses.itertuples(index=False)}


def _spread_counts(total, n_buckets):
    """Split `total` across n_buckets as evenly as possible (deterministic)."""
    base = total // n_buckets
    counts = [base] * n_buckets
    for i in range(total - base * n_buckets):
        counts[i] += 1
    return counts


# --------------------------------------------------------------------------- #
# 1. drivers.csv                                                               #
# --------------------------------------------------------------------------- #
def gen_drivers():
    rows = []
    per_wh = _spread_counts(N_DRIVERS, len(WH_IDS))
    did = 1
    for wh, n in zip(WH_IDS, per_wh):
        for _ in range(n):
            rows.append({
                "driver_id": f"DRV-{did:03d}",
                "name": fake.name(),
                "home_warehouse_id": wh,
                "max_hours_per_shift": int(np.random.randint(8, 11)),   # 8..10
                "hourly_cost": round(float(np.random.uniform(22, 38)), 2),
                "license_type": random.choices(LICENSE_TYPES, weights=[0.6, 0.3, 0.1])[0],
            })
            did += 1
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 2. vehicles.csv                                                              #
# --------------------------------------------------------------------------- #
# Three truck sizes: smaller trucks carry less but sip fuel; big rigs haul more
# but burn more. This makes capacity and fuel efficiency genuinely correlated.
TRUCK_CLASSES = [
    {"cap": (700, 1000),  "eff": (13.0, 15.0)},   # light
    {"cap": (1100, 1500), "eff": (10.5, 12.5)},   # medium
    {"cap": (1700, 2100), "eff": (8.0, 10.0)},    # heavy
]


def gen_vehicles():
    rows = []
    per_wh = _spread_counts(N_VEHICLES, len(WH_IDS))
    vid = 1
    # ~10% in maintenance -> pick a deterministic set of indices
    maint_idx = set(np.random.choice(N_VEHICLES, size=max(1, round(N_VEHICLES * 0.10)),
                                     replace=False).tolist())
    for wh, n in zip(WH_IDS, per_wh):
        for _ in range(n):
            cls = TRUCK_CLASSES[(vid - 1) % 3]
            status = "maintenance" if (vid - 1) in maint_idx else "active"
            rows.append({
                "vehicle_id": f"TRK-{vid:03d}",
                "warehouse_id": wh,
                "capacity_units": int(np.random.randint(cls["cap"][0], cls["cap"][1] + 1)),
                "fuel_efficiency_km_per_liter": round(float(np.random.uniform(*cls["eff"])), 1),
                "avg_speed_kmph": int(np.random.randint(55, 76)),
                "status": status,
            })
            vid += 1
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 3. customers.csv — clustered within ~80km of each warehouse                  #
# --------------------------------------------------------------------------- #
def gen_customers():
    rows = []
    per_wh = _spread_counts(N_CUSTOMERS, len(WH_IDS))
    cid = 1
    for wh, n in zip(WH_IDS, per_wh):
        w = WH[wh]
        # 4 sub-cluster centres per warehouse (realistic delivery pockets)
        n_clusters = 4
        centres = []
        for _ in range(n_clusters):
            d = float(np.random.uniform(10, DELIVERY_RADIUS_KM * 0.75))
            b = float(np.random.uniform(0, 2 * math.pi))
            centres.append(_offset_latlng(w.latitude, w.longitude, d, b))
        for j in range(n):
            clat, clng = centres[j % n_clusters]
            # scatter around the cluster centre, but keep inside the 80km disc
            d = min(float(abs(np.random.normal(0, 12))), DELIVERY_RADIUS_KM)
            b = float(np.random.uniform(0, 2 * math.pi))
            lat, lng = _offset_latlng(clat, clng, d, b)
            rows.append({
                "customer_id": f"CUST-{cid:04d}",
                "latitude": round(lat, 6),
                "longitude": round(lng, 6),
                "region": w.region,
            })
            cid += 1
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 4. fuel_stations.csv — spread across the delivery zones                      #
# --------------------------------------------------------------------------- #
def gen_fuel_stations():
    rows = []
    per_wh = _spread_counts(N_FUEL_STATIONS, len(WH_IDS))
    sid = 1
    for wh, n in zip(WH_IDS, per_wh):
        w = WH[wh]
        for _ in range(n):
            d = float(np.random.uniform(15, DELIVERY_RADIUS_KM))
            b = float(np.random.uniform(0, 2 * math.pi))
            lat, lng = _offset_latlng(w.latitude, w.longitude, d, b)
            rows.append({
                "station_id": f"FS-{sid:02d}",
                "latitude": round(lat, 6),
                "longitude": round(lng, 6),
                "fuel_price_per_liter": round(float(np.random.uniform(1.28, 1.62)), 3),
            })
            sid += 1
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 5. orders.csv — 40..80 orders per day per warehouse over 30 days             #
# --------------------------------------------------------------------------- #
def _time_window():
    """A 2-4h delivery window inside an 08:00-18:00 working day (HH:MM)."""
    start_h = int(np.random.randint(8, 15))          # 08..14
    start_m = int(np.random.choice([0, 30]))
    length_h = int(np.random.randint(2, 5))          # 2..4 hours
    end_h = min(start_h + length_h, 18)
    return f"{start_h:02d}:{start_m:02d}", f"{end_h:02d}:{start_m:02d}"


def gen_orders(customers):
    cust_by_wh = {wh: customers[customers["region"] == WH[wh].region]["customer_id"].tolist()
                  for wh in WH_IDS}
    dates = pd.date_range(end=ANCHOR_END, periods=N_ORDER_DAYS, freq="D")
    rows = []
    oid = 1
    for d in dates:
        for wh in WH_IDS:
            n = int(np.random.randint(ORDERS_PER_DAY_MIN, ORDERS_PER_DAY_MAX + 1))
            for _ in range(n):
                tw_start, tw_end = _time_window()
                rows.append({
                    "order_id": f"ORD-{oid:06d}",
                    "date": d.strftime("%Y-%m-%d"),
                    "warehouse_id": wh,
                    "customer_id": random.choice(cust_by_wh[wh]),
                    "weight_units": int(np.random.randint(15, 141)),
                    "priority": "urgent" if np.random.random() < 0.2 else "standard",
                    "time_window_start": tw_start,
                    "time_window_end": tw_end,
                })
                oid += 1
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 6. trip_logs.csv — 2,000 historical completed trips (ML training set)        #
# --------------------------------------------------------------------------- #
def gen_trip_logs(drivers, vehicles):
    veh_by_wh = {wh: vehicles[vehicles["warehouse_id"] == wh]["vehicle_id"].tolist()
                 for wh in WH_IDS}
    drv_by_wh = {wh: drivers[drivers["home_warehouse_id"] == wh]["driver_id"].tolist()
                 for wh in WH_IDS}
    # trips spread across ~180 historical days ending at the anchor
    day_span = pd.date_range(end=ANCHOR_END, periods=180, freq="D")
    rows = []
    for i in range(1, N_TRIP_LOGS + 1):
        wh = random.choice(WH_IDS)
        veh = random.choice(veh_by_wh[wh])
        drv = random.choice(drv_by_wh[wh])
        d = random.choice(day_span)

        num_stops = int(np.random.randint(5, 26))                     # 5..25 stops
        # distance grows with stop count (each leg ~6-14km) plus a little noise
        total_distance_km = round(
            num_stops * float(np.random.uniform(6, 14)) + float(np.random.uniform(-8, 8)), 1)
        total_distance_km = max(total_distance_km, 5.0)

        weather = random.choices(WEATHER, weights=WEATHER_P)[0]
        traffic = random.choices(TRAFFIC, weights=TRAFFIC_P)[0]

        # naive plan: distance at baseline speed + fixed service per stop
        base = total_distance_km / LOG_SPEED_KMPH * 60.0 + num_stops * SERVICE_MIN_PER_STOP
        planned_duration_min = int(round(base))

        # actual is the plan warped by traffic & weather, plus ~6% noise
        noise = float(np.random.normal(0, 0.06))
        actual = base * TRAFFIC_MULT[traffic] * WEATHER_MULT[weather] * (1.0 + noise)
        actual_duration_min = int(round(max(actual, base * 0.9)))

        rows.append({
            "trip_id": f"TRIP-{i:05d}",
            "date": pd.Timestamp(d).strftime("%Y-%m-%d"),
            "vehicle_id": veh,
            "driver_id": drv,
            "warehouse_id": wh,
            "num_stops": num_stops,
            "total_distance_km": total_distance_km,
            "weather_condition": weather,
            "traffic_level": traffic,
            "planned_duration_min": planned_duration_min,
            "actual_duration_min": actual_duration_min,
        })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #
def main():
    drivers = gen_drivers()
    vehicles = gen_vehicles()
    customers = gen_customers()
    fuel_stations = gen_fuel_stations()
    orders = gen_orders(customers)
    trip_logs = gen_trip_logs(drivers, vehicles)

    files = {
        "drivers.csv": drivers,
        "vehicles.csv": vehicles,
        "customers.csv": customers,
        "fuel_stations.csv": fuel_stations,
        "orders.csv": orders,
        "trip_logs.csv": trip_logs,
    }
    print("Reused warehouses from", os.path.normpath(WAREHOUSE_CSV),
          "->", ", ".join(WH_IDS))
    for fname, df in files.items():
        path = os.path.join(OUT_DIR, fname)
        df.to_csv(path, index=False)
        print(f"  {fname:<20} {len(df):>6,} rows")
    # a couple of sanity aggregates
    active = (vehicles["status"] == "active").sum()
    print(f"Active vehicles: {active}/{len(vehicles)} · "
          f"orders span {orders['date'].min()}..{orders['date'].max()}")


if __name__ == "__main__":
    main()
