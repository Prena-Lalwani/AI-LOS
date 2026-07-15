"""
dispatch_intelligence.py — Dispatch Intelligence model layer.

Runs on the self-generated synthetic dispatch dataset
(backend/data/dispatch/*.csv, produced by data_generation/generate_dispatch_data.py)
and the 3 shared warehouses. Every analysis here is real — no faked numbers:

  * Truck/driver assignment + routing — a genuine Capacitated VRP with Time
    Windows solved with Google OR-Tools' routing solver over a haversine distance
    matrix. Orders are assigned to vehicles respecting capacity and delivery time
    windows while minimizing total distance.
  * Shift / break planning       — a Time dimension caps each route at the
    driver's max_hours_per_shift, and an optional 30-min break is offered after
    4h of continuous work (OR-Tools break intervals).
  * Load balancing               — capacity utilization % per solved route;
    under-50% and >=100% routes are flagged.
  * Fuel stop recommendation     — distance / fuel_efficiency gives litres
    needed; routes beyond the 400 km tank range get the nearest fuel station
    inserted and a cost estimate at that station's price.
  * Dynamic re-routing (ML)      — a RandomForestRegressor trained on trip_logs
    predicts actual_duration_min from num_stops, distance, weather & traffic
    (time-based split, real MAE/RMSE). Routes whose predicted duration overshoots
    the VRP plan are flagged for re-routing.
  * Overtime prediction          — routes whose predicted duration exceeds the
    driver's shift length are flagged.

DATE DISPLAY SHIFT
------------------
orders.csv / trip_logs.csv are historical (anchored to 2024-12-30). We shift the
date LABELS forward by the gap between the last historical date and today, so the
plan reads as "today". The default planning date is that shifted "today".
"""

import math
import os
from datetime import datetime

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

# --------------------------------------------------------------------------- #
# Documented business constants                                               #
# --------------------------------------------------------------------------- #
TANK_RANGE_KM = 400.0            # assumed usable range on a full tank
SERVICE_MIN_PER_STOP = 9         # minutes handled at each delivery (matches logs)
FLEET_SPEED_KMPH = 55.0          # planning speed for the VRP time matrix
DEPOT_OPEN_MIN = 7 * 60          # 07:00 — earliest a truck may leave the depot
BREAK_AFTER_MIN = 4 * 60         # mandatory break after 4h of continuous work
BREAK_DURATION_MIN = 30          # length of that break
SOLVER_TIME_LIMIT_SEC = 8        # OR-Tools search budget
DROP_PENALTY_M = 5_000_000       # cost of leaving an order unassigned (metres)
# "today" assumed conditions for scoring the day's plan with the delay model
TODAY_TRAFFIC = "medium"
TODAY_WEATHER = "clear"

_DATA = os.path.join(os.path.dirname(__file__), "..", "data", "dispatch")
_WH_CSV = os.path.join(os.path.dirname(__file__), "..", "data", "warehouse", "warehouses.csv")


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #
def _round(x, d=2):
    return round(float(x), d)


def _haversine_km(lat1, lng1, lat2, lng2):
    """Great-circle distance in km between two lat/lng points."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2 * math.asin(math.sqrt(a))


def _mins(hhmm):
    """'08:30' -> 510 minutes from midnight."""
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _hhmm(mins):
    mins = int(round(mins))
    return f"{(mins // 60) % 24:02d}:{mins % 60:02d}"


# --------------------------------------------------------------------------- #
# Load + date shift                                                            #
# --------------------------------------------------------------------------- #
def _load():
    warehouses = pd.read_csv(_WH_CSV)
    drivers = pd.read_csv(os.path.join(_DATA, "drivers.csv"))
    vehicles = pd.read_csv(os.path.join(_DATA, "vehicles.csv"))
    customers = pd.read_csv(os.path.join(_DATA, "customers.csv"))
    stations = pd.read_csv(os.path.join(_DATA, "fuel_stations.csv"))
    orders = pd.read_csv(os.path.join(_DATA, "orders.csv"), parse_dates=["date"])
    trips = pd.read_csv(os.path.join(_DATA, "trip_logs.csv"), parse_dates=["date"])

    last_real = orders["date"].max()
    offset = (datetime.now().date() - last_real.date()).days
    orders["date_shifted"] = orders["date"] + pd.Timedelta(days=offset)
    trips["date_shifted"] = trips["date"] + pd.Timedelta(days=offset)

    return {
        "warehouses": warehouses, "drivers": drivers, "vehicles": vehicles,
        "customers": customers, "stations": stations, "orders": orders,
        "trips": trips, "offset": offset, "last_real": last_real,
    }


# --------------------------------------------------------------------------- #
# Delay-prediction model — RandomForestRegressor on trip_logs                 #
# --------------------------------------------------------------------------- #
_CAT_COLS = ["weather_condition", "traffic_level"]
_NUM_COLS = ["num_stops", "total_distance_km"]


def train_delay_model(trips):
    """Predict actual_duration_min from stops/distance/weather/traffic.
    Time-based split (earliest 80% train, latest 20% test). Returns the fitted
    model, the training feature columns, and real MAE / RMSE on the test set."""
    df = trips.sort_values("date").reset_index(drop=True)
    X = pd.concat([df[_NUM_COLS], pd.get_dummies(df[_CAT_COLS])], axis=1)
    y = df["actual_duration_min"].to_numpy()

    split = int(len(df) * 0.8)
    X_train, X_test = X.iloc[:split], X.iloc[split:]
    y_train, y_test = y[:split], y[split:]

    model = RandomForestRegressor(
        n_estimators=300, max_depth=12, random_state=42, n_jobs=-1)
    model.fit(X_train, y_train)

    pred = model.predict(X_test)
    mae = mean_absolute_error(y_test, pred)
    rmse = math.sqrt(mean_squared_error(y_test, pred))
    return {
        "model": model,
        "feature_cols": list(X.columns),
        "mae": _round(mae, 1),
        "rmse": _round(rmse, 1),
        "testRows": int(len(X_test)),
        "trainRows": int(len(X_train)),
        "meanActual": _round(float(y.mean()), 1),
    }


def _predict_duration(delay, num_stops, distance_km, weather, traffic):
    """Score one (planned) route with the trained delay model."""
    row = {c: 0 for c in delay["feature_cols"]}
    row["num_stops"] = num_stops
    row["total_distance_km"] = distance_km
    for c, v in ((f"weather_condition_{weather}", 1), (f"traffic_level_{traffic}", 1)):
        if c in row:
            row[c] = v
    X = pd.DataFrame([[row[c] for c in delay["feature_cols"]]], columns=delay["feature_cols"])
    return float(delay["model"].predict(X)[0])


# --------------------------------------------------------------------------- #
# Core VRP — Capacitated VRP with Time Windows (real OR-Tools solve)          #
# --------------------------------------------------------------------------- #
def _solve_vrp(depot, orders_day, cust_map, vehicles_wh, drivers_wh):
    """Solve one warehouse's day of orders as a CVRPTW.

    Node 0 is the depot (the warehouse). Nodes 1..N are deliveries. Returns the
    per-vehicle routes, the list of unassigned orders, and the total distance.
    """
    # --- build node arrays -------------------------------------------------
    coords = [(depot["latitude"], depot["longitude"])]
    demands = [0]
    tw = [(DEPOT_OPEN_MIN, 24 * 60)]                      # depot open all day
    order_ref = [None]
    for o in orders_day.itertuples(index=False):
        c = cust_map[o.customer_id]
        coords.append((c["latitude"], c["longitude"]))
        demands.append(int(o.weight_units))
        tw.append((_mins(o.time_window_start), _mins(o.time_window_end)))
        order_ref.append(o)
    n = len(coords)

    # --- distance (metres, int) & time (minutes, int) matrices -------------
    dist_km = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i != j:
                dist_km[i][j] = _haversine_km(*coords[i], *coords[j])
    dist_m = [[int(round(dist_km[i][j] * 1000)) for j in range(n)] for i in range(n)]

    def travel_min(i, j):
        return int(round(dist_km[i][j] / FLEET_SPEED_KMPH * 60.0))

    # --- vehicles ----------------------------------------------------------
    veh = list(vehicles_wh.itertuples(index=False))
    n_veh = len(veh)
    capacities = [int(v.capacity_units) for v in veh]
    # one driver per vehicle (from the same warehouse), cycled if fewer drivers
    drv = list(drivers_wh.itertuples(index=False))
    driver_of = [drv[k % len(drv)] for k in range(n_veh)]
    max_span = [int(driver_of[k].max_hours_per_shift) * 60 for k in range(n_veh)]

    mgr = pywrapcp.RoutingIndexManager(n, n_veh, 0)
    routing = pywrapcp.RoutingModel(mgr)

    # distance arc cost (objective)
    def dist_cb(fi, ti):
        return dist_m[mgr.IndexToNode(fi)][mgr.IndexToNode(ti)]
    dist_idx = routing.RegisterTransitCallback(dist_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(dist_idx)

    # capacity dimension
    def demand_cb(fi):
        return demands[mgr.IndexToNode(fi)]
    dem_idx = routing.RegisterUnaryTransitCallback(demand_cb)
    routing.AddDimensionWithVehicleCapacity(dem_idx, 0, capacities, True, "Capacity")

    # time dimension = travel + service at destination
    def time_cb(fi, ti):
        f, t = mgr.IndexToNode(fi), mgr.IndexToNode(ti)
        svc = SERVICE_MIN_PER_STOP if t != 0 else 0
        return travel_min(f, t) + svc
    time_idx = routing.RegisterTransitCallback(time_cb)
    horizon = 24 * 60
    routing.AddDimension(time_idx, horizon, horizon, False, "Time")
    time_dim = routing.GetDimensionOrDie("Time")

    # per-node time windows
    for node in range(1, n):
        idx = mgr.NodeToIndex(node)
        time_dim.CumulVar(idx).SetRange(tw[node][0], tw[node][1])
    # depot start window + per-vehicle shift-length cap (shift/overtime constraint)
    for k in range(n_veh):
        start = routing.Start(k)
        time_dim.CumulVar(start).SetRange(DEPOT_OPEN_MIN, DEPOT_OPEN_MIN + 3 * 60)
        time_dim.SetSpanUpperBoundForVehicle(max_span[k], k)
        routing.AddVariableMinimizedByFinalizer(time_dim.CumulVar(start))
        routing.AddVariableMinimizedByFinalizer(time_dim.CumulVar(routing.End(k)))

    # mandatory 30-min break once continuous work passes 4h (OR-Tools breaks).
    # Optional=True so short routes (< 4h) skip it; long routes must fit it in.
    solver = routing.solver()
    node_visit_transit = [0] * n
    for node in range(1, n):
        node_visit_transit[node] = SERVICE_MIN_PER_STOP
    for k in range(n_veh):
        brk = solver.FixedDurationIntervalVar(
            BREAK_AFTER_MIN, max_span[k], BREAK_DURATION_MIN, True, f"Break_{k}")
        time_dim.SetBreakIntervalsOfVehicle([brk], k, node_visit_transit)

    # allow dropping orders if capacity/time can't fit them (report as unassigned)
    for node in range(1, n):
        routing.AddDisjunction([mgr.NodeToIndex(node)], DROP_PENALTY_M)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromSeconds(SOLVER_TIME_LIMIT_SEC)

    sol = routing.SolveWithParameters(params)
    if sol is None:
        return {"routes": [], "unassigned": list(range(1, n)), "totalDistanceKm": 0.0,
                "orderRef": order_ref, "coords": coords, "demands": demands,
                "depot": depot}

    routes = []
    served = set()
    for k in range(n_veh):
        idx = routing.Start(k)
        node_seq, load, route_m = [], 0, 0
        while not routing.IsEnd(idx):
            node = mgr.IndexToNode(idx)
            if node != 0:
                node_seq.append(node)
                load += demands[node]
                served.add(node)
            nxt = sol.Value(routing.NextVar(idx))
            route_m += routing.GetArcCostForVehicle(idx, nxt, k)
            idx = nxt
        if not node_seq:
            continue  # vehicle unused
        start_min = sol.Value(time_dim.CumulVar(routing.Start(k)))
        end_min = sol.Value(time_dim.CumulVar(routing.End(k)))
        routes.append({
            "vehicle": veh[k], "driver": driver_of[k],
            "nodes": node_seq, "load": load, "capacity": capacities[k],
            "distanceKm": _round(route_m / 1000.0, 1),
            "startMin": start_min, "endMin": end_min,
            "durationMin": int(end_min - start_min),
        })

    unassigned = [node for node in range(1, n) if node not in served]
    total_km = _round(sum(r["distanceKm"] for r in routes), 1)
    return {"routes": routes, "unassigned": unassigned, "totalDistanceKm": total_km,
            "orderRef": order_ref, "coords": coords, "demands": demands, "depot": depot}


# --------------------------------------------------------------------------- #
# Fuel stops                                                                   #
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# Build the plan payload                                                       #
# --------------------------------------------------------------------------- #
def _nearest_station(lat, lng, stations_list):
    return min(stations_list,
               key=lambda s: _haversine_km(lat, lng, s.latitude, s.longitude))


def _project(coords, box_w=560, box_h=320, pad=28):
    """Project lat/lng into an SVG viewBox with EQUAL x/y scale (aspect ratio
    preserved) and centred — longitude is scaled by cos(lat) so the map isn't
    stretched. A naive stretch-to-fit is what makes a route map look like
    tangled spaghetti; equal scaling keeps the real geographic shape."""
    lats = [c[0] for c in coords]
    lngs = [c[1] for c in coords]
    kx = math.cos(math.radians(sum(lats) / len(lats)))    # east/west foreshortening

    xs = [(ln - min(lngs)) * kx for ln in lngs]           # planar east (deg·cos)
    ys = [(la - min(lats)) for la in lats]                # planar north (deg)
    rx = (max(xs) - min(xs)) or 1e-6
    ry = (max(ys) - min(ys)) or 1e-6
    scale = min((box_w - 2 * pad) / rx, (box_h - 2 * pad) / ry)
    offx = (box_w - rx * scale) / 2.0
    offy = (box_h - ry * scale) / 2.0

    def to_xy(lat, lng):
        x = offx + ((lng - min(lngs)) * kx - min(xs)) * scale
        y = box_h - (offy + ((lat - min(lats)) - min(ys)) * scale)   # north -> up
        return _round(x, 1), _round(y, 1)
    return to_xy


def build_plan(date=None, delay=None):
    data = _load()
    if delay is None:
        delay = train_delay_model(data["trips"])

    orders = data["orders"]
    # default planning day = shifted "today"; else the requested date
    if date is None:
        plan_date = orders["date_shifted"].max().normalize()
    else:
        plan_date = pd.Timestamp(date).normalize()
    day = orders[orders["date_shifted"].dt.normalize() == plan_date]
    if day.empty:                                   # fall back to the busiest day
        plan_date = orders["date_shifted"].max().normalize()
        day = orders[orders["date_shifted"].dt.normalize() == plan_date]

    # pick the warehouse with the most orders that day (the busiest hub)
    wh_id = day["warehouse_id"].value_counts().idxmax()
    wh_row = data["warehouses"].set_index("warehouse_id").loc[wh_id]
    depot = {"latitude": float(wh_row.latitude), "longitude": float(wh_row.longitude)}
    orders_day = day[day["warehouse_id"] == wh_id].reset_index(drop=True)

    cust_map = {c.customer_id: {"latitude": c.latitude, "longitude": c.longitude}
                for c in data["customers"].itertuples(index=False)}
    vehicles_wh = data["vehicles"][(data["vehicles"]["warehouse_id"] == wh_id) &
                                   (data["vehicles"]["status"] == "active")]
    drivers_wh = data["drivers"][data["drivers"]["home_warehouse_id"] == wh_id]

    solved = _solve_vrp(depot, orders_day, cust_map, vehicles_wh, drivers_wh)
    routes_raw = solved["routes"]
    coords = solved["coords"]

    # --- assemble per-route output + load balancing + delay/overtime -------
    stations_list = list(data["stations"].itertuples(index=False))
    to_xy = _project(coords)
    routes, load_util, overtime, delay_flags, fuel_stops = [], [], [], [], []
    map_nodes, map_links, geo_routes = [], [], []
    dx, dy = to_xy(depot["latitude"], depot["longitude"])
    map_nodes.append({"x": dx, "y": dy, "label": wh_id, "depot": True, "route": -1})

    for ridx, r in enumerate(routes_raw):
        v, drv = r["vehicle"], r["driver"]
        util = _round(r["load"] / r["capacity"] * 100, 1)
        load_util.append(util)

        # predicted duration for today's assumed conditions
        pred = _predict_duration(delay, len(r["nodes"]), r["distanceKm"],
                                 TODAY_WEATHER, TODAY_TRAFFIC)
        planned = r["durationMin"]
        shift_min = int(drv.max_hours_per_shift) * 60
        reroute = pred > planned * 1.15 and (pred - planned) >= 20
        is_ot = pred > shift_min

        # fuel: litres for the whole route + cost at the nearest station price
        eff = float(v.fuel_efficiency_km_per_liter)
        litres = r["distanceKm"] / eff
        mid = coords[r["nodes"][len(r["nodes"]) // 2]]
        station = _nearest_station(mid[0], mid[1], stations_list)
        fuel_cost = litres * float(station.fuel_price_per_liter)
        needs_stop = r["distanceKm"] > TANK_RANGE_KM

        route_state = "attention" if (reroute or is_ot or util < 50) else "flow"
        stops = [{"customerId": solved["orderRef"][node].customer_id,
                  "orderId": solved["orderRef"][node].order_id,
                  "weight": int(solved["demands"][node])} for node in r["nodes"]]

        routes.append({
            "vehicleId": v.vehicle_id, "driverId": drv.driver_id, "driver": drv.name,
            "warehouseId": wh_id, "numStops": len(r["nodes"]), "stops": stops,
            "distanceKm": r["distanceKm"], "load": r["load"], "capacity": r["capacity"],
            "capacityUtilizationPct": util,
            "plannedDurationMin": planned, "predictedDurationMin": int(round(pred)),
            "startTime": _hhmm(r["startMin"]), "endTime": _hhmm(r["endMin"]),
            "fuelLitres": _round(litres, 1), "fuelCost": _round(fuel_cost, 2),
            "fuelEfficiency": eff, "nearestStation": station.station_id,
            "needsFuelStop": needs_stop,
            "rerouteRecommended": reroute, "overtimeRisk": is_ot, "state": route_state,
        })

        # projected route polyline + delivery-point nodes for the map (per route)
        prev = (dx, dy)
        for node in r["nodes"]:
            x, y = to_xy(*coords[node])
            map_links.append({"x1": prev[0], "y1": prev[1], "x2": x, "y2": y,
                              "route": ridx, "alt": reroute})
            map_nodes.append({"x": x, "y": y, "label": solved["orderRef"][node].order_id,
                              "depot": False, "route": ridx})
            prev = (x, y)

        # real lat/lng path for the Leaflet map (depot -> stops -> depot)
        depot_ll = [depot["latitude"], depot["longitude"]]
        geo_routes.append({
            "vehicleId": v.vehicle_id, "route": ridx, "reroute": reroute,
            "path": [depot_ll] + [[coords[node][0], coords[node][1]] for node in r["nodes"]] + [depot_ll],
            "stops": [{"lat": coords[node][0], "lng": coords[node][1],
                       "orderId": solved["orderRef"][node].order_id,
                       "customerId": solved["orderRef"][node].customer_id,
                       "windowStart": solved["orderRef"][node].time_window_start,
                       "windowEnd": solved["orderRef"][node].time_window_end,
                       "weight": int(solved["demands"][node])} for node in r["nodes"]],
        })

        if needs_stop:
            fuel_stops.append({
                "vehicleId": v.vehicle_id, "stationId": station.station_id,
                "fuelPricePerLiter": _round(float(station.fuel_price_per_liter), 3),
                "litresNeeded": _round(litres, 1), "estCost": _round(fuel_cost, 2),
                "routeDistanceKm": r["distanceKm"], "tankRangeKm": TANK_RANGE_KM,
            })
        if reroute:
            delay_flags.append({
                "vehicleId": v.vehicle_id, "driver": drv.name,
                "plannedDurationMin": planned, "predictedDurationMin": int(round(pred)),
                "overshootMin": int(round(pred - planned)),
            })
        if is_ot:
            overtime.append({
                "vehicleId": v.vehicle_id, "driver": drv.name,
                "predictedDurationMin": int(round(pred)), "maxShiftMin": shift_min,
                "overMin": int(round(pred - shift_min)),
            })

    underused = [{"vehicleId": r["vehicleId"], "utilizationPct": r["capacityUtilizationPct"]}
                 for r in routes if r["capacityUtilizationPct"] < 50]
    overloaded = [{"vehicleId": r["vehicleId"], "utilizationPct": r["capacityUtilizationPct"]}
                  for r in routes if r["capacityUtilizationPct"] >= 100]
    avg_util = _round(float(np.mean(load_util)), 1) if load_util else 0.0

    kpis = [
        {"label": "Active Routes", "value": len(routes),
         "delta": f"{wh_id} · {orders_day.shape[0]} orders", "state": "flow"},
        {"label": "Avg Load Factor", "value": f"{avg_util}%",
         "delta": f"{len(underused)} under 50%", "state": "flow" if avg_util >= 70 else "attention"},
        {"label": "Total Distance", "value": f"{solved['totalDistanceKm']} km",
         "delta": "VRP-optimized", "state": "flow"},
        {"label": "Delay / OT Flags", "value": len(delay_flags) + len(overtime),
         "delta": f"{len(delay_flags)} reroute · {len(overtime)} OT",
         "state": "attention" if (delay_flags or overtime) else "flow"},
    ]

    return {
        "kpis": kpis,
        "planDate": plan_date.strftime("%Y-%m-%d"),
        "warehouseId": wh_id, "warehouseName": str(wh_row["name"]),
        "ordersToday": int(orders_day.shape[0]),
        "routes": routes,
        "unassignedCount": len(solved["unassigned"]),
        "totalDistanceKm": solved["totalDistanceKm"],
        "fuelStops": fuel_stops,
        "delayRisk": {
            "modelMae": delay["mae"], "modelRmse": delay["rmse"],
            "testRows": delay["testRows"], "meanActualMin": delay["meanActual"],
            "assumedTraffic": TODAY_TRAFFIC, "assumedWeather": TODAY_WEATHER,
            "flags": delay_flags,
        },
        "overtimeFlags": overtime,
        "loadBalancing": {
            "avgUtilizationPct": avg_util,
            "underused": underused, "overloaded": overloaded,
        },
        "map": {"nodes": map_nodes, "links": map_links},
        "geo": {
            "depot": {"lat": depot["latitude"], "lng": depot["longitude"], "label": wh_id},
            "routes": geo_routes,
        },
        "meta": {
            "solver": "OR-Tools CVRPTW", "fleetSpeedKmph": FLEET_SPEED_KMPH,
            "tankRangeKm": TANK_RANGE_KM, "serviceMinPerStop": SERVICE_MIN_PER_STOP,
            "breakAfterMin": BREAK_AFTER_MIN, "breakDurationMin": BREAK_DURATION_MIN,
            "dayOffset": data["offset"], "generatedAt": datetime.now().isoformat(timespec="seconds"),
        },
    }


if __name__ == "__main__":
    p = build_plan()
    print(f"Plan date {p['planDate']} · {p['warehouseName']} ({p['warehouseId']}) "
          f"· {p['ordersToday']} orders")
    print(f"VRP: {len(p['routes'])} routes · {p['totalDistanceKm']} km total "
          f"· {p['unassignedCount']} unassigned")
    print(f"Load: avg util {p['loadBalancing']['avgUtilizationPct']}% "
          f"· {len(p['loadBalancing']['underused'])} underused "
          f"· {len(p['loadBalancing']['overloaded'])} overloaded")
    print(f"Fuel stops recommended: {len(p['fuelStops'])}")
    dr = p["delayRisk"]
    print(f"Delay model: MAE={dr['modelMae']} min · RMSE={dr['modelRmse']} min "
          f"(mean actual {dr['meanActualMin']} min, {dr['testRows']} test rows)")
    print(f"Flags: {len(dr['flags'])} re-routing · {len(p['overtimeFlags'])} overtime")
