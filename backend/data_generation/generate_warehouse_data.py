"""
generate_warehouse_data.py — self-generated synthetic warehouse dataset.

Produces a fully self-consistent set of CSVs under backend/data/warehouse/ that
drive the Inventory & Warehouse Intelligence module. Because we control the
generator, the data contains *genuine* structure the ML/optimization layer can
actually recover:

  * daily inventory has real reorder sawtooth cycles (lead-time delivery queue),
    weekday/weekend rhythm, and category-based holiday seasonality, plus ~5% of
    days carry a promotional demand spike;
  * picking events carry pick durations that are a real function of the physical
    walking distance between consecutive shelf locations (zone/aisle grid);
  * the warehouse layout is a true 3D grid, so heatmaps and route optimization
    operate on real coordinates rather than a proxy.

Deterministic: np.random.seed(42) (+ Faker/​random seeds) so re-running produces
byte-identical CSVs. Prints row counts for every file when done.

Run:
    cd backend
    python -m data_generation.generate_warehouse_data
      (or)  python data_generation/generate_warehouse_data.py
"""

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
OUT_DIR = os.path.join(_HERE, "..", "data", "warehouse")
os.makedirs(OUT_DIR, exist_ok=True)

# --------------------------------------------------------------------------- #
# Simulation constants                                                         #
# --------------------------------------------------------------------------- #
N_DAYS = 365
START_DATE = pd.Timestamp("2024-01-01")           # historical anchor; labels are
                                                  # shifted forward at serve time
LEAD_TIME_DAYS = 7                                # matches the module's EOQ lead time
N_PICKING_EVENTS = 15_000
SPIKE_PROB = 0.05                                 # ~5% of days get a promo spike

# Layout grid per warehouse: 4 zones x 4 aisles x 5 racks x 3 shelves = 240
ZONES, AISLES, RACKS, SHELVES = 4, 4, 5, 3
SHELVES_PER_WH = ZONES * AISLES * RACKS * SHELVES  # 240

CATEGORIES = ["Groceries", "Electronics", "Toys", "Furniture", "Clothing"]

# Per-category demand profile: base mean daily units per location, weekend
# multiplier, and whether the category rides the holiday-season spike.
CATEGORY_PROFILE = {
    "Groceries":   {"base": 42, "weekend": 1.35, "holiday": 1.15},
    "Electronics": {"base": 14, "weekend": 1.10, "holiday": 2.60},
    "Toys":        {"base": 18, "weekend": 1.25, "holiday": 2.90},
    "Furniture":   {"base": 6,  "weekend": 1.05, "holiday": 1.20},
    "Clothing":    {"base": 22, "weekend": 1.20, "holiday": 1.70},
}

# Holiday season window (day-of-year index): mid-Nov through end of Dec.
HOLIDAY_START, HOLIDAY_PEAK, HOLIDAY_END = 318, 358, 364


# --------------------------------------------------------------------------- #
# 1. warehouses.csv                                                            #
# --------------------------------------------------------------------------- #
def gen_warehouses():
    rows = [
        {"warehouse_id": "WH1", "name": "Chicago Central DC",  "region": "Midwest",
         "latitude": 41.8781, "longitude": -87.6298, "total_capacity_units": 520_000},
        {"warehouse_id": "WH2", "name": "Dallas South Hub",    "region": "South",
         "latitude": 32.7767, "longitude": -96.7970, "total_capacity_units": 460_000},
        {"warehouse_id": "WH3", "name": "Los Angeles West DC", "region": "West",
         "latitude": 34.0522, "longitude": -118.2437, "total_capacity_units": 610_000},
    ]
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 2. warehouse_layout.csv                                                      #
# --------------------------------------------------------------------------- #
def gen_layout(warehouses):
    rows = []
    for wh in warehouses["warehouse_id"]:
        for z in range(1, ZONES + 1):
            for a in range(1, AISLES + 1):
                for r in range(1, RACKS + 1):
                    for s in range(1, SHELVES + 1):
                        code = f"{wh}-Z{z}-A{a}-R{r}-S{s}"
                        # shelf capacity varies a little by rack height (lower racks bigger)
                        cap = int(np.random.randint(400, 900) - (r - 1) * 20)
                        rows.append({
                            "warehouse_id": wh, "zone": z, "aisle": a,
                            "rack": r, "shelf": s, "location_code": code,
                            "capacity_units": cap,
                        })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 3. products.csv                                                              #
# --------------------------------------------------------------------------- #
def gen_products():
    # 20 products, 4 per category, with plausible weight/volume per category.
    names = {
        "Groceries":   ["Canned Soup 24pk", "Bottled Water 12pk", "Rice Sack 10kg", "Coffee Beans 1kg"],
        "Electronics": ["4K Smart TV 55\"", "Wireless Earbuds", "Laptop 14\"", "Bluetooth Speaker"],
        "Toys":        ["Building Block Set", "RC Race Car", "Plush Bear XL", "Board Game Deluxe"],
        "Furniture":   ["Office Chair Ergo", "Bookshelf 5-Tier", "Coffee Table Oak", "Bed Frame Queen"],
        "Clothing":    ["Winter Jacket", "Denim Jeans", "Cotton T-Shirt 5pk", "Running Shoes"],
    }
    weight_range = {
        "Groceries":   (0.8, 12.0), "Electronics": (0.2, 18.0),
        "Toys":        (0.3, 4.0),  "Furniture":   (8.0, 45.0),
        "Clothing":    (0.2, 1.6),
    }
    rows = []
    pid = 1
    for cat in CATEGORIES:
        for nm in names[cat]:
            wlo, whi = weight_range[cat]
            weight = round(float(np.random.uniform(wlo, whi)), 2)
            # volume loosely tracks weight but with category-specific density
            volume = round(float(weight * np.random.uniform(0.004, 0.02)), 4)
            rows.append({
                "product_id": f"P{pid:03d}", "name": nm, "category": cat,
                "unit_weight_kg": weight, "unit_volume_m3": volume,
            })
            pid += 1
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 4. product_locations.csv                                                     #
# --------------------------------------------------------------------------- #
def gen_product_locations(products, layout):
    # Each product lives at 3-5 shelf locations, possibly spread across warehouses.
    codes_by_wh = {wh: grp["location_code"].tolist()
                   for wh, grp in layout.groupby("warehouse_id")}
    all_wh = list(codes_by_wh.keys())
    used = {wh: set() for wh in all_wh}
    rows = []
    for pid in products["product_id"]:
        n_loc = int(np.random.randint(3, 6))              # 3..5
        # spread across 1-3 warehouses
        n_wh = int(np.random.randint(1, 4))
        chosen_whs = list(np.random.choice(all_wh, size=min(n_wh, len(all_wh)), replace=False))
        for i in range(n_loc):
            wh = chosen_whs[i % len(chosen_whs)]
            # pick a fresh shelf in that warehouse
            candidates = [c for c in codes_by_wh[wh] if c not in used[wh]]
            code = str(np.random.choice(candidates))
            used[wh].add(code)
            rows.append({"product_id": pid, "location_code": code, "warehouse_id": wh})
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 5. inventory_daily.csv                                                       #
# --------------------------------------------------------------------------- #
def _seasonal_factor(day_idx, cat_profile):
    """Holiday-season ramp: triangular bump peaking at HOLIDAY_PEAK."""
    holiday = cat_profile["holiday"]
    if holiday <= 1.0 or not (HOLIDAY_START <= day_idx <= HOLIDAY_END):
        return 1.0
    if day_idx <= HOLIDAY_PEAK:
        frac = (day_idx - HOLIDAY_START) / max(1, (HOLIDAY_PEAK - HOLIDAY_START))
    else:
        frac = (HOLIDAY_END - day_idx) / max(1, (HOLIDAY_END - HOLIDAY_PEAK))
    return 1.0 + (holiday - 1.0) * frac


def gen_inventory_daily(product_locations, products):
    cat_by_pid = dict(zip(products["product_id"], products["category"]))
    dates = [START_DATE + pd.Timedelta(days=d) for d in range(N_DAYS)]
    weekday_is_weekend = np.array([d.weekday() >= 5 for d in dates])

    rows = []
    for _, pl in product_locations.iterrows():
        pid, code, wh = pl["product_id"], pl["location_code"], pl["warehouse_id"]
        cat = cat_by_pid[pid]
        prof = CATEGORY_PROFILE[cat]

        # per-location popularity so locations of the same product differ
        popularity = float(np.random.uniform(0.6, 1.4))
        mean_demand = prof["base"] * popularity

        # ~15% of locations are chronically OVER-ordered slow movers (poor demand
        # planning → dead stock). The rest run a deliberately lean policy so normal
        # demand variance and promo spikes cause real stock-outs spread across the
        # whole year (not only the holiday tail), which makes the time-based ML
        # split learnable. Together they give a dataset with BOTH failure modes.
        overstocked = np.random.random() < 0.15
        reorder_point = mean_demand * LEAD_TIME_DAYS            # ~lead-time cover
        if overstocked:
            order_qty = max(int(mean_demand * 90), 200)         # ~3 months over-order
            inventory = float(order_qty * 1.5 + reorder_point)  # start heavily stocked
        else:
            order_qty = max(int(mean_demand * 21), 30)          # ~3 weeks cover
            inventory = float(order_qty + reorder_point * 0.5)  # modest starting buffer

        pending = {}   # {arrival_day_idx: units}
        for di, date in enumerate(dates):
            # 1) receive scheduled deliveries
            received = pending.pop(di, 0)
            inventory += received

            # 2) demand for the day
            factor = 1.0
            if weekday_is_weekend[di]:
                factor *= prof["weekend"]
            factor *= _seasonal_factor(di, prof)
            spike = np.random.random() < SPIKE_PROB
            if spike:
                factor *= float(np.random.uniform(2.0, 4.0))
            lam = max(0.1, mean_demand * factor)
            demand = int(np.random.poisson(lam))
            sold = min(demand, int(inventory))
            inventory -= sold

            # 3) reorder when below ROP and nothing already inbound
            if inventory < reorder_point and not pending:
                pending[di + LEAD_TIME_DAYS] = order_qty

            rows.append({
                "date": date.strftime("%Y-%m-%d"),
                "product_id": pid,
                "location_code": code,
                "warehouse_id": wh,
                "inventory_level": int(inventory),
                "units_sold": int(sold),
                "units_received": int(received),
            })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 6. picking_events.csv                                                        #
# --------------------------------------------------------------------------- #
def _coords(code):
    """Parse 'WH1-Z2-A3-R1-S2' -> (zone, aisle, rack, shelf) ints."""
    _, z, a, r, s = code.split("-")
    return int(z[1:]), int(a[1:]), int(r[1:]), int(s[1:])


def _grid_distance(c1, c2):
    """Walking-distance proxy between two shelves in the same warehouse.
    Zones are far apart, aisles moderate, racks/shelves close."""
    z1, a1, r1, s1 = c1
    z2, a2, r2, s2 = c2
    return abs(z1 - z2) * 10 + abs(a1 - a2) * 4 + abs(r1 - r2) * 1 + abs(s1 - s2) * 0.3


def gen_picking_events(product_locations):
    # locations available per warehouse (product lives here) for realistic picks
    pls_by_wh = {wh: grp[["product_id", "location_code"]].to_dict("records")
                 for wh, grp in product_locations.groupby("warehouse_id")}
    whs = list(pls_by_wh.keys())

    BASE_HANDLE = 12.0          # seconds of fixed handling per pick
    WALK_PER_UNIT = 1.8         # seconds per unit of grid distance
    DOCK = (0, 0, 0, 0)         # entrance/dock reference for the first pick

    rows = []
    for e in range(1, N_PICKING_EVENTS + 1):
        wh = str(np.random.choice(whs))
        records = pls_by_wh[wh]
        n_items = int(np.random.randint(1, 6))            # 1..5 products
        picks = [records[i] for i in np.random.randint(0, len(records), size=n_items)]

        event_id = f"E{e:05d}"
        # weekday-weighted date over the year
        day_idx = int(np.random.randint(0, N_DAYS))
        date = (START_DATE + pd.Timedelta(days=day_idx)).strftime("%Y-%m-%d")

        prev = DOCK
        for p in picks:
            code = p["location_code"]
            cur = _coords(code)
            dist = _grid_distance(prev, cur)
            duration = BASE_HANDLE + dist * WALK_PER_UNIT + float(np.random.uniform(0, 6))
            rows.append({
                "event_id": event_id,
                "date": date,
                "warehouse_id": wh,
                "product_id": p["product_id"],
                "location_code": code,
                "quantity_picked": int(np.random.randint(1, 11)),
                "pick_duration_seconds": round(duration, 1),
            })
            prev = cur
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #
def main():
    print(f"[gen] writing CSVs to {os.path.abspath(OUT_DIR)}")

    warehouses = gen_warehouses()
    layout = gen_layout(warehouses)
    products = gen_products()
    product_locations = gen_product_locations(products, layout)
    inventory_daily = gen_inventory_daily(product_locations, products)
    picking_events = gen_picking_events(product_locations)

    files = {
        "warehouses.csv": warehouses,
        "warehouse_layout.csv": layout,
        "products.csv": products,
        "product_locations.csv": product_locations,
        "inventory_daily.csv": inventory_daily,
        "picking_events.csv": picking_events,
    }
    for fname, df in files.items():
        path = os.path.join(OUT_DIR, fname)
        df.to_csv(path, index=False)

    print("\n[gen] done — row counts:")
    for fname, df in files.items():
        print(f"  {fname:<24} {len(df):>7,} rows")


if __name__ == "__main__":
    main()
