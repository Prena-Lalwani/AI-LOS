"""
inventory_intelligence.py — Inventory & Warehouse Intelligence model layer.

Runs entirely on the *self-generated* synthetic warehouse dataset
(backend/data/warehouse/*.csv, produced by data_generation/generate_warehouse_data.py).
Because that data is built with genuine reorder cycles, seasonality, promo spikes,
a real 3D layout, and distance-correlated pick durations, every analysis here is
real signal recovery — not a proxy:

  * Reorder recommendations      — avg/std daily demand + EOQ + reorder point.
  * Safety-stock monitoring      — 1.65 · σ · √(lead time), flag breaches.
  * Stock-out prediction         — a RandomForestClassifier trained on a
                                   time-based split; reports real accuracy /
                                   precision / recall.
  * Overstock detection          — inventory > 3 · avg demand · lead time.
  * Warehouse heatmap            — real occupancy (avg inventory) + activity
                                   (pick frequency) by zone × aisle.
  * Congestion detection         — per-aisle pick density, top-decile flagged.
  * Picking-route optimization   — Google OR-Tools TSP over shelf coordinates
                                   vs. naive sequential order; reports % saved.

DATE DISPLAY SHIFT
------------------
The dataset is historical (last real day 2024-12-30). We train/analyze on the
REAL dates, then shift only the date LABELS in the output forward by the exact
day gap between the last real date and today, so the dashboard reads as "live".
"""

import os
from datetime import datetime

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

# --------------------------------------------------------------------------- #
# Documented business constants                                               #
# --------------------------------------------------------------------------- #
LEAD_TIME_DAYS = 7          # replenishment lead time assumption (matches generator)
SERVICE_Z = 1.65            # z-score for a 95% service level (safety stock)
ORDER_COST = 45.0           # fixed cost per purchase order ($) — EOQ "S"
HOLDING_COST_PER_UNIT_YEAR = 2.5   # annual holding cost per unit ($) — EOQ "H"
OVERSTOCK_MULTIPLE = 3.0    # inventory > 3 × (avg demand × lead time) ⇒ overstock
STOCKOUT_HORIZON = 7        # label = stocks out within the next 7 days
CONGESTION_TOP_PCT = 0.10   # top 10% busiest aisle-days are congestion risks

# Rough per-unit cost by category — used only to translate excess units into a
# dollar figure for the overstock panel.
UNIT_COST_BY_CATEGORY = {
    "Groceries": 8.0, "Electronics": 220.0, "Toys": 25.0,
    "Furniture": 180.0, "Clothing": 35.0,
}

_DATA = os.path.join(os.path.dirname(__file__), "..", "data", "warehouse")


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #
def _round(x, d=2):
    return round(float(x), d)


def _coords(code):
    """'WH1-Z2-A3-R1-S2' -> (zone, aisle, rack, shelf) ints."""
    _, z, a, r, s = code.split("-")
    return int(z[1:]), int(a[1:]), int(r[1:]), int(s[1:])


def _grid_distance(c1, c2):
    """Walking-distance proxy between two shelves (same weights as generator)."""
    z1, a1, r1, s1 = c1
    z2, a2, r2, s2 = c2
    return abs(z1 - z2) * 10 + abs(a1 - a2) * 4 + abs(r1 - r2) * 1 + abs(s1 - s2) * 0.3


def _load():
    """Load all warehouse CSVs; add parsed zone/aisle and shifted date labels."""
    warehouses = pd.read_csv(os.path.join(_DATA, "warehouses.csv"))
    layout = pd.read_csv(os.path.join(_DATA, "warehouse_layout.csv"))
    products = pd.read_csv(os.path.join(_DATA, "products.csv"))
    product_locations = pd.read_csv(os.path.join(_DATA, "product_locations.csv"))
    inv = pd.read_csv(os.path.join(_DATA, "inventory_daily.csv"), parse_dates=["date"])
    picks = pd.read_csv(os.path.join(_DATA, "picking_events.csv"), parse_dates=["date"])

    # date display shift (labels only) ------------------------------------
    last_real = inv["date"].max()
    offset = (datetime.now().date() - last_real.date()).days
    inv["date_shifted"] = inv["date"] + pd.Timedelta(days=offset)
    picks["date_shifted"] = picks["date"] + pd.Timedelta(days=offset)

    # zone/aisle parsed from the location code (layout is a true grid)
    for df in (inv, picks):
        zc = df["location_code"].str.split("-", expand=True)
        df["zone"] = zc[1].str[1:].astype(int)
        df["aisle"] = zc[2].str[1:].astype(int)

    cat = dict(zip(products["product_id"], products["category"]))
    name = dict(zip(products["product_id"], products["name"]))
    inv["category"] = inv["product_id"].map(cat)

    return {
        "warehouses": warehouses, "layout": layout, "products": products,
        "product_locations": product_locations, "inv": inv, "picks": picks,
        "cat": cat, "name": name, "offset": offset, "last_real": last_real,
    }


# --------------------------------------------------------------------------- #
# Per-PRODUCT demand statistics (shared by several analyses)                   #
# --------------------------------------------------------------------------- #
# A single product can be stocked on several shelves. To keep the dashboard
# consistent — one product = one row everywhere — we aggregate each product's
# demand and inventory across all of its locations, and pick one "primary"
# location (the shelf currently holding the most stock) as its canonical spot.
def _product_stats(inv):
    """Avg & std of daily demand + total current inventory per product, summed
    across all its shelf locations, plus a single primary location per product."""
    # total daily demand per product (summed over its locations), then avg/std
    daily = inv.groupby(["product_id", "date"])["units_sold"].sum().reset_index()
    dstats = daily.groupby("product_id").agg(
        avg_daily_demand=("units_sold", "mean"),
        std_daily_demand=("units_sold", "std"),
    ).reset_index()
    dstats["std_daily_demand"] = dstats["std_daily_demand"].fillna(0.0)

    # latest inventory per (product, location); sum -> product on-hand
    last_inv = (inv.sort_values("date")
                .groupby(["product_id", "location_code"])["inventory_level"]
                .last().reset_index(name="on_hand"))
    on_hand = last_inv.groupby("product_id")["on_hand"].sum().reset_index()

    # primary location = the shelf currently holding the most stock
    primary = (last_inv.sort_values("on_hand", ascending=False)
               .groupby("product_id").first().reset_index()
               .rename(columns={"location_code": "primary_location"})
               [["product_id", "primary_location"]])

    return dstats.merge(on_hand, on="product_id").merge(primary, on="product_id")


def _eoq(annual_demand):
    """Economic Order Quantity: sqrt(2 · D · S / H)."""
    if annual_demand <= 0:
        return 0.0
    return float(np.sqrt(2.0 * annual_demand * ORDER_COST / HOLDING_COST_PER_UNIT_YEAR))


# --------------------------------------------------------------------------- #
# 1 & 2. Reorder recommendations + safety-stock monitoring                    #
# --------------------------------------------------------------------------- #
def _reorder_and_safety(stats, name_map):
    rows_reorder, rows_safety = [], []
    for r in stats.itertuples(index=False):
        avg_d = float(r.avg_daily_demand)
        std_d = float(r.std_daily_demand)
        on_hand = float(r.on_hand)
        loc = r.primary_location
        wh = loc.split("-")[0]

        safety_stock = SERVICE_Z * std_d * np.sqrt(LEAD_TIME_DAYS)
        reorder_point = avg_d * LEAD_TIME_DAYS + safety_stock
        eoq = _eoq(avg_d * 365.0)

        below_rop = on_hand < reorder_point
        below_ss = on_hand < safety_stock

        if below_ss:
            status, state = "Below Safety", "critical"
        elif below_rop:
            status, state = "Reorder Now", "attention"
        else:
            status, state = "Healthy", "flow"

        rows_reorder.append({
            "productId": r.product_id, "name": name_map[r.product_id],
            "warehouseId": wh, "locationCode": loc,
            "onHand": int(on_hand), "reorderPoint": int(round(reorder_point)),
            "recommendedQty": int(round(eoq)) if below_rop else 0,
            "avgDailyDemand": _round(avg_d, 1), "status": status, "state": state,
        })
        if below_ss:
            rows_safety.append({
                "productId": r.product_id, "name": name_map[r.product_id],
                "warehouseId": wh, "locationCode": loc,
                "onHand": int(on_hand), "safetyStock": int(round(safety_stock)),
                "state": "critical",
            })

    # flagged first, most-urgent (largest gap below ROP) first
    def urgency(x):
        order = {"critical": 0, "attention": 1, "flow": 2}
        return (order[x["state"]], x["onHand"] - x["reorderPoint"])
    rows_reorder.sort(key=urgency)

    flagged = [r for r in rows_reorder if r["state"] != "flow"]
    reorder = {
        "flaggedCount": len(flagged),
        "totalProducts": len(rows_reorder),
        "rows": rows_reorder[:14],
    }
    rows_safety.sort(key=lambda x: x["onHand"] - x["safetyStock"])
    safety = {"belowCount": len(rows_safety), "rows": rows_safety[:12]}
    return reorder, safety


# --------------------------------------------------------------------------- #
# 3. Stock-out prediction — real RandomForest on a time-based split           #
# --------------------------------------------------------------------------- #
def _label_stockout(inv):
    """1 if inventory hits 0 on any of the next STOCKOUT_HORIZON days."""
    inv = inv.sort_values(["product_id", "location_code", "date"]).copy()
    lbl = np.zeros(len(inv), dtype=int)
    idx = 0
    for _, g in inv.groupby(["product_id", "location_code"], sort=False):
        lv = g["inventory_level"].to_numpy()
        n = len(lv)
        y = np.zeros(n, dtype=int)
        for i in range(n):
            fut = lv[i + 1: i + 1 + STOCKOUT_HORIZON]
            if fut.size and (fut == 0).any():
                y[i] = 1
        lbl[idx: idx + n] = y
        idx += n
    inv["stockout_next7"] = lbl
    return inv


def _stockout_model(inv, name_map, primary_map):
    df = _label_stockout(inv)

    # features: numeric + category one-hot + warehouse one-hot
    feats = df[["inventory_level", "units_sold", "units_received"]].copy()
    feats = pd.concat([
        feats,
        pd.get_dummies(df["category"], prefix="cat"),
        pd.get_dummies(df["warehouse_id"], prefix="wh"),
    ], axis=1)
    y = df["stockout_next7"].to_numpy()

    # time-based split (earliest 80% train, latest 20% test)
    order = np.argsort(df["date"].to_numpy())
    feats = feats.iloc[order].reset_index(drop=True)
    y = y[order]
    dates_sorted = df["date"].to_numpy()[order]
    split = int(len(feats) * 0.8)
    X_train, X_test = feats.iloc[:split], feats.iloc[split:]
    y_train, y_test = y[:split], y[split:]

    clf = RandomForestClassifier(
        n_estimators=300, max_depth=14, class_weight="balanced",
        random_state=42, n_jobs=-1,
    )
    clf.fit(X_train, y_train)

    # Choose the decision threshold that maximizes F1 on the TRAINING data only
    # (no test leakage) — standard practice for an imbalanced target, and far
    # more informative than the default 0.5 when positives are ~3% of rows.
    proba_train = clf.predict_proba(X_train)[:, 1]
    thresh = 0.5
    best_f1 = -1.0
    for t in np.linspace(0.05, 0.9, 50):
        f = f1_score(y_train, (proba_train >= t).astype(int), zero_division=0)
        if f > best_f1:
            best_f1, thresh = f, float(t)

    pred = (clf.predict_proba(X_test)[:, 1] >= thresh).astype(int)

    metrics = {
        "decisionThreshold": _round(thresh, 3),
        "accuracy": _round(accuracy_score(y_test, pred) * 100, 2),
        "precision": _round(precision_score(y_test, pred, zero_division=0) * 100, 2),
        "recall": _round(recall_score(y_test, pred, zero_division=0) * 100, 2),
        "f1": _round(f1_score(y_test, pred, zero_division=0) * 100, 2),
        "trainRows": int(len(X_train)),
        "testRows": int(len(X_test)),
        "positiveRatePct": _round(y.mean() * 100, 2),
        "features": list(feats.columns),
        "splitDate": pd.Timestamp(dates_sorted[split]).strftime("%Y-%m-%d"),
    }

    # score the latest snapshot per product-location for a live at-risk list
    latest = df.sort_values("date").groupby(["product_id", "location_code"]).tail(1).copy()
    latest_feats = latest[["inventory_level", "units_sold", "units_received"]].copy()
    latest_feats = pd.concat([
        latest_feats,
        pd.get_dummies(latest["category"], prefix="cat"),
        pd.get_dummies(latest["warehouse_id"], prefix="wh"),
    ], axis=1).reindex(columns=feats.columns, fill_value=0)
    proba = clf.predict_proba(latest_feats)[:, 1]
    latest = latest.assign(risk=proba)

    # Aggregate to product level — one row per product — using worst-case (max)
    # risk across its locations and total current inventory, so a product never
    # appears twice. The canonical location shown is its primary location.
    prod = latest.groupby("product_id").agg(
        risk=("risk", "max"),
        inventory_level=("inventory_level", "sum"),
    ).reset_index()

    # recent product-level daily demand (last 30 days, summed across locations)
    daily_tot = (inv.sort_values("date")
                 .groupby(["product_id", "date"])["units_sold"].sum().reset_index())
    recent_avg = (daily_tot.groupby("product_id").tail(30)
                  .groupby("product_id")["units_sold"].mean().to_dict())

    at_risk = []
    for r in prod.sort_values("risk", ascending=False).itertuples(index=False):
        if r.risk < thresh and len(at_risk) >= 3:
            break
        avg_recent = float(recent_avg.get(r.product_id, 0.0))
        days = round(r.inventory_level / avg_recent, 1) if avg_recent > 0 else None
        state = "critical" if r.risk >= 0.7 else "attention"
        loc = primary_map.get(r.product_id)
        at_risk.append({
            "productId": r.product_id, "name": name_map[r.product_id],
            "locationCode": loc, "warehouseId": loc.split("-")[0] if loc else None,
            "onHand": int(r.inventory_level),
            "riskProbability": _round(float(r.risk), 3),
            "daysToStockout": days, "state": state,
        })
        if len(at_risk) >= 8:
            break

    return {"modelMetrics": metrics, "atRisk": at_risk, "atRiskCount":
            int((prod["risk"] >= thresh).sum())}


# --------------------------------------------------------------------------- #
# 4. Overstock detection                                                      #
# --------------------------------------------------------------------------- #
def _overstock(stats, cat_map, name_map):
    rows = []
    for r in stats.itertuples(index=False):
        avg_d = float(r.avg_daily_demand)
        on_hand = float(r.on_hand)
        loc = r.primary_location
        expected_max = OVERSTOCK_MULTIPLE * avg_d * LEAD_TIME_DAYS
        if on_hand > expected_max and expected_max > 0:
            excess = on_hand - expected_max
            cost = UNIT_COST_BY_CATEGORY.get(cat_map[r.product_id], 20.0)
            rows.append({
                "productId": r.product_id, "name": name_map[r.product_id],
                "locationCode": loc, "warehouseId": loc.split("-")[0],
                "onHand": int(on_hand), "expectedMax": int(round(expected_max)),
                "excessUnits": int(round(excess)),
                "excessValue": int(round(excess * cost)), "state": "attention",
            })
    rows.sort(key=lambda x: x["excessValue"], reverse=True)
    return {"count": len(rows), "totalExcessValue": int(sum(r["excessValue"] for r in rows)),
            "rows": rows[:12]}


# --------------------------------------------------------------------------- #
# 5. Warehouse heatmap — real occupancy + activity by zone × aisle            #
# --------------------------------------------------------------------------- #
def _heatmap(inv, picks, warehouses):
    occ = inv.groupby(["warehouse_id", "zone", "aisle"])["inventory_level"].mean().reset_index(name="avg_inv")
    act = picks.groupby(["warehouse_id", "zone", "aisle"]).size().reset_index(name="pick_count")
    grid = occ.merge(act, on=["warehouse_id", "zone", "aisle"], how="outer").fillna(0)

    wh_meta = dict(zip(warehouses["warehouse_id"], warehouses["name"]))
    # full grid dimensions (so empty aisles still render as idle, not skipped)
    n_zones, n_aisles = 4, 4
    out = []
    for wh, g in grid.groupby("warehouse_id"):
        inv_max = g["avg_inv"].max() or 1.0
        pick_max = g["pick_count"].max() or 1.0
        lookup = {(int(r.zone), int(r.aisle)): r for r in g.itertuples(index=False)}
        cells = []
        for z in range(1, n_zones + 1):
            for a in range(1, n_aisles + 1):
                r = lookup.get((z, a))
                avg_inv = float(r.avg_inv) if r is not None else 0.0
                pick_count = int(r.pick_count) if r is not None else 0
                # utilization blends occupancy (60%) and activity (40%)
                util = 0.6 * (avg_inv / inv_max) + 0.4 * (pick_count / pick_max)
                cells.append({
                    "zone": z, "aisle": a, "avgInventory": _round(avg_inv, 1),
                    "pickCount": pick_count, "utilization": int(round(util * 100)),
                })
        out.append({
            "warehouseId": wh, "name": wh_meta.get(wh, wh),
            "zones": n_zones, "aisles": n_aisles,
            "totalPicks": int(g["pick_count"].sum()), "cells": cells,
        })
    # primary = busiest warehouse
    out.sort(key=lambda w: w["totalPicks"], reverse=True)
    return {"primary": out[0]["warehouseId"] if out else None, "warehouses": out}


# --------------------------------------------------------------------------- #
# 6. Congestion detection — per-aisle pick density, top decile flagged        #
# --------------------------------------------------------------------------- #
def _congestion(picks):
    per_day = picks.groupby(["warehouse_id", "zone", "aisle",
                             picks["date_shifted"].dt.date]).size().reset_index(name="picks")
    agg = per_day.groupby(["warehouse_id", "zone", "aisle"]).agg(
        avg_picks_per_day=("picks", "mean"),
        peak_picks_per_day=("picks", "max"),
        active_days=("picks", "count"),
    ).reset_index()

    threshold = float(agg["avg_picks_per_day"].quantile(1 - CONGESTION_TOP_PCT))
    flagged = agg[agg["avg_picks_per_day"] >= threshold].sort_values(
        "avg_picks_per_day", ascending=False)

    alerts = [{
        "warehouseId": r.warehouse_id, "zone": int(r.zone), "aisle": int(r.aisle),
        "aisleLabel": f"{r.warehouse_id}-Z{int(r.zone)}-A{int(r.aisle)}",
        "avgPicksPerDay": _round(r.avg_picks_per_day, 1),
        "peakPicksPerDay": int(r.peak_picks_per_day),
        "state": "critical" if r.avg_picks_per_day >= agg["avg_picks_per_day"].quantile(0.95) else "attention",
    } for r in flagged.itertuples(index=False)]

    return {"thresholdPicksPerDay": _round(threshold, 1),
            "flaggedCount": len(alerts), "alerts": alerts[:10]}


# --------------------------------------------------------------------------- #
# 7. Picking-route optimization — real OR-Tools TSP vs naive order            #
# --------------------------------------------------------------------------- #
def _tsp_order(dist_matrix):
    """Solve an open-ended TSP from node 0 over dist_matrix; return node order."""
    n = len(dist_matrix)
    mgr = pywrapcp.RoutingIndexManager(n, 1, 0)
    routing = pywrapcp.RoutingModel(mgr)

    scaled = (np.array(dist_matrix) * 100).astype(int)

    def cb(i, j):
        return int(scaled[mgr.IndexToNode(i)][mgr.IndexToNode(j)])

    transit = routing.RegisterTransitCallback(cb)
    routing.SetArcCostEvaluatorOfAllVehicles(transit)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromSeconds(2)

    sol = routing.SolveWithParameters(params)
    order, idx = [], routing.Start(0)
    while not routing.IsEnd(idx):
        order.append(mgr.IndexToNode(idx))
        idx = sol.Value(routing.NextVar(idx))
    return order


def _path_distance(coords, order):
    return sum(_grid_distance(coords[order[i]], coords[order[i + 1]])
               for i in range(len(order) - 1))


def _route_payload(sample, name_map, wh):
    """Core: given a per-warehouse picklist (DataFrame with product_id +
    location_code, in as-listed order), compute the naive vs OR-Tools TSP route
    and the distance/time saved. Shared by the default example and the
    user-driven /picking-route endpoint."""
    sample = sample.reset_index(drop=True)
    DOCK = (0, 0, 0, 0)
    coords = [DOCK] + [_coords(c) for c in sample["location_code"]]
    labels = ["DOCK"] + list(sample["location_code"])
    prod_at = ["—"] + [name_map.get(p, p) for p in sample["product_id"]]

    # naive: walk the shelves in the order they appear on the picklist (as-listed)
    naive_order = list(range(len(coords)))
    naive_dist = _path_distance(coords, naive_order)

    # distance matrix for OR-Tools TSP
    n = len(coords)
    dm = [[_grid_distance(coords[i], coords[j]) for j in range(n)] for i in range(n)]
    opt_order = _tsp_order(dm)
    opt_dist = _path_distance(coords, opt_order)

    saved_pct = (naive_dist - opt_dist) / naive_dist * 100 if naive_dist else 0.0
    # duration proxy uses the generator's walk model (1.8 s per distance unit)
    WALK, HANDLE = 1.8, 12.0
    naive_time = naive_dist * WALK + HANDLE * (n - 1)
    opt_time = opt_dist * WALK + HANDLE * (n - 1)
    time_saved_pct = (naive_time - opt_time) / naive_time * 100 if naive_time else 0.0

    return {
        "warehouseId": wh,
        "stops": len(sample),
        "naiveSequence": [labels[i] for i in naive_order],
        "optimizedSequence": [labels[i] for i in opt_order],
        "products": [prod_at[i] for i in opt_order],
        "naiveDistance": _round(naive_dist, 1),
        "optimizedDistance": _round(opt_dist, 1),
        "distanceSavedPct": _round(saved_pct, 1),
        "naiveDurationSec": _round(naive_time, 0),
        "optimizedDurationSec": _round(opt_time, 0),
        "timeSavedPct": _round(time_saved_pct, 1),
    }


def _picking_route(product_locations, name_map):
    """Default example: a deterministic 8-location sample from the busiest
    warehouse, presented in picklist order (unrelated to physical position)."""
    wh = product_locations["warehouse_id"].value_counts().idxmax()
    pool = product_locations[product_locations["warehouse_id"] == wh].drop_duplicates("location_code")
    spread = pool.sort_values("location_code").iloc[::max(1, len(pool) // 8)].head(8)
    sample = spread.sort_values("product_id").reset_index(drop=True)
    return _route_payload(sample, name_map, wh)


def _picking_catalog(data):
    """Products a picker can choose from, per warehouse (one representative shelf
    each) — powers the frontend product selector."""
    pl = data["product_locations"]
    name_map = data["name"]
    wh_name = dict(zip(data["warehouses"]["warehouse_id"], data["warehouses"]["name"]))
    rep = pl.sort_values("location_code").drop_duplicates(["warehouse_id", "product_id"])
    products = [{"productId": r.product_id, "name": name_map.get(r.product_id, r.product_id),
                 "warehouseId": r.warehouse_id, "locationCode": r.location_code}
                for r in rep.itertuples(index=False)]
    warehouses = [{"warehouseId": w, "name": wh_name.get(w, w)}
                  for w in sorted(pl["warehouse_id"].unique())]
    return {"warehouses": warehouses, "products": products}


def picking_route_for(warehouse=None, product_ids=None):
    """Optimize a picking route for a USER-supplied set of products in one
    warehouse. Each product resolves to one representative shelf in that
    warehouse, kept in the order the user selected them (= the naive picklist).
    Falls back to the default example if the selection is too small."""
    data = _load()
    pl = data["product_locations"]
    name_map = data["name"]
    if not warehouse:
        warehouse = pl["warehouse_id"].value_counts().idxmax()
    whp = pl[pl["warehouse_id"] == warehouse]
    if product_ids:
        rows = []
        for pid in product_ids:                       # preserve user's pick order
            m = whp[whp["product_id"] == pid]
            if not m.empty:
                rows.append(m.iloc[0])
        if len(rows) >= 2:
            sample = pd.DataFrame(rows).drop_duplicates("location_code").reset_index(drop=True)
            return _route_payload(sample, name_map, warehouse)
    return _picking_route(whp if len(whp) else pl, name_map)


# --------------------------------------------------------------------------- #
# KPI summary                                                                 #
# --------------------------------------------------------------------------- #
def _kpis(data, reorder, stockout, overstock):
    n_products = len(data["products"])
    n_wh = len(data["warehouses"])
    return [
        {"label": "SKUs Tracked", "value": n_products,
         "delta": f"{n_wh} facilities", "state": "flow"},
        {"label": "Reorder Alerts", "value": reorder["flaggedCount"],
         "delta": f"of {reorder['totalProducts']} products", "state": "attention"},
        {"label": "Stock-Out Risk", "value": stockout["atRiskCount"],
         "delta": f"within {LEAD_TIME_DAYS} days", "state": "attention"},
        {"label": "Overstock Value", "value": f"${overstock['totalExcessValue'] / 1000:,.0f}K",
         "delta": f"{overstock['count']} products tied up", "state": "attention"},
    ]


# --------------------------------------------------------------------------- #
# Public entrypoint                                                           #
# --------------------------------------------------------------------------- #
def build_payload():
    data = _load()
    inv, picks = data["inv"], data["picks"]
    stats = _product_stats(inv)
    primary_map = dict(zip(stats["product_id"], stats["primary_location"]))

    reorder, safety = _reorder_and_safety(stats, data["name"])
    stockout = _stockout_model(inv, data["name"], primary_map)
    overstock = _overstock(stats, data["cat"], data["name"])
    heatmap = _heatmap(inv, picks, data["warehouses"])
    congestion = _congestion(picks)
    route = _picking_route(data["product_locations"], data["name"])
    kpis = _kpis(data, reorder, stockout, overstock)

    return {
        "kpis": kpis,
        "reorderRecommendations": reorder,
        "safetyStock": safety,
        "stockOutPredictions": stockout,
        "overstock": overstock,
        "warehouseHeatmap": heatmap,
        "congestionAlerts": congestion,
        "pickingRouteExample": route,
        "pickingCatalog": _picking_catalog(data),
        "meta": {
            "leadTimeDays": LEAD_TIME_DAYS,
            "serviceZ": SERVICE_Z,
            "dayOffset": data["offset"],
            "lastRealDate": data["last_real"].strftime("%Y-%m-%d"),
            "asOfDate": (data["last_real"] + pd.Timedelta(days=data["offset"])).strftime("%Y-%m-%d"),
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
        },
    }


if __name__ == "__main__":
    import json
    p = build_payload()
    m = p["stockOutPredictions"]["modelMetrics"]
    print("Stock-out model:", {k: m[k] for k in ("accuracy", "precision", "recall", "f1", "positiveRatePct")})
    print("Reorder flagged:", p["reorderRecommendations"]["flaggedCount"])
    print("Overstock locations:", p["overstock"]["count"], "value $", p["overstock"]["totalExcessValue"])
    print("Top congestion:", [a["aisleLabel"] for a in p["congestionAlerts"]["alerts"][:5]])
    print("Route saved %:", p["pickingRouteExample"]["distanceSavedPct"],
          "time %", p["pickingRouteExample"]["timeSavedPct"])
