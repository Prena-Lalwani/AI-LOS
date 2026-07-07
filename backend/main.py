"""
AI-LOS — Order & Demand Intelligence API (FastAPI).

Trains the Prophet demand model ONCE at startup (it is slow) and caches the
resulting payload in memory, then serves it from a single endpoint.

Run:
    cd backend
    python -m venv venv
    # Windows:  venv\\Scripts\\activate      |  macOS/Linux:  source venv/bin/activate
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000
"""

import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from models.demand_forecast import build_payload
from models.inventory_intelligence import build_payload as build_inventory_payload
from models.dispatch_intelligence import build_plan as build_dispatch_plan
from models.fleet_intelligence import (
    train_models as train_fleet_models,
    build_payload as build_fleet_payload,
)
from models import reports_analytics as reports

_cache = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Train the models once, at startup — not per request.
    print("[startup] Training Prophet demand model…")
    _cache["payload"] = build_payload()
    print("[startup] Demand model trained and payload cached.")
    print("[startup] Training inventory stock-out classifier + analytics…")
    inv = build_inventory_payload()
    _cache["inventory"] = inv
    m = inv["stockOutPredictions"]["modelMetrics"]
    print(f"[startup] Inventory ready — stock-out model "
          f"acc={m['accuracy']}% prec={m['precision']}% rec={m['recall']}% f1={m['f1']}%.")
    print("[startup] Training dispatch delay regressor + solving today's VRP…")
    disp = build_dispatch_plan()
    _cache["dispatch"] = disp
    dr = disp["delayRisk"]
    print(f"[startup] Dispatch ready — {len(disp['routes'])} routes, "
          f"{disp['totalDistanceKm']} km, {disp['unassignedCount']} unassigned; "
          f"delay model MAE={dr['modelMae']} RMSE={dr['modelRmse']} min.")
    print("[startup] Training fleet breakdown classifier + anomaly detector…")
    fleet_fit = train_fleet_models()          # train both ML models once
    fleet = build_fleet_payload(fleet_fit)
    _cache["fleet"] = fleet
    fm = fleet["maintenanceRisk"]["modelMetrics"]
    fa = fleet["anomalies"]["summary"]
    print(f"[startup] Fleet ready — breakdown model acc={fm['accuracy']}% "
          f"prec={fm['precision']}% rec={fm['recall']}% f1={fm['f1']}%; "
          f"{fleet['maintenanceRisk']['highRiskCount']} high-risk, "
          f"{fa['vehiclesFlagged']} vehicles with recent anomalies.")
    # Reports & Analytics: reuse the already-built payloads (no recompute).
    reports.load_modules(demand=_cache["payload"], inventory=inv,
                         dispatch=disp, fleet=fleet)
    print(f"[startup] Reports ready — {len(reports.list_reports())} reports "
          f"aggregating the 5 modules; PDF/Excel export enabled.")
    yield
    _cache.clear()


app = FastAPI(title="AI-LOS Demand Intelligence API", version="0.1.0", lifespan=lifespan)

# CORS: allow the local Vite dev frontend, any *.vercel.app deployment (preview
# + production), and any extra origins listed in the ALLOWED_ORIGINS env var
# (comma-separated) — set that to your custom domain in production.
_extra_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", *_extra_origins],
    allow_origin_regex=r"https://.*\.vercel\.app|http://localhost:\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/demand/forecast")
def demand_forecast():
    """Full Order & Demand Intelligence payload (cached from startup)."""
    return _cache.get("payload") or build_payload()


@app.get("/api/inventory/dashboard")
def inventory_dashboard():
    """Full Inventory & Warehouse Intelligence payload (cached from startup)."""
    return _cache.get("inventory") or build_inventory_payload()


@app.get("/api/dispatch/plan")
def dispatch_plan(date: Optional[str] = None):
    """Dispatch plan for a day (VRP routes, fuel stops, delay/overtime, load).

    Defaults to today's (post-shift) plan cached at startup. A specific ?date=
    (YYYY-MM-DD) re-solves the VRP for that day on demand."""
    if date is None:
        return _cache.get("dispatch") or build_dispatch_plan()
    return build_dispatch_plan(date)


@app.get("/api/fleet/dashboard")
def fleet_dashboard():
    """Full Fleet Intelligence payload (cached from startup): predictive
    maintenance risk with real model metrics, unsupervised anomalies, vehicle
    utilization, driver performance, fuel analytics and a prioritized
    maintenance schedule."""
    return _cache.get("fleet") or build_fleet_payload()


# --- Reports & Analytics (aggregates the 5 modules; no new data/models) ------
@app.get("/api/reports/list")
def reports_list():
    """List of available reports for the report grid/list view."""
    return {"reports": reports.list_reports()}


@app.get("/api/reports/{report_id}/export/pdf")
def report_export_pdf(report_id: str, date_from: Optional[str] = None,
                      date_to: Optional[str] = None):
    """Download the report as a simple PDF (reportlab)."""
    if report_id not in reports.REPORT_IDS:
        raise HTTPException(status_code=404, detail=f"Unknown report '{report_id}'")
    pdf = reports.export_pdf(report_id, date_from, date_to)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{report_id}.pdf"'})


@app.get("/api/reports/{report_id}/export/excel")
def report_export_excel(report_id: str, date_from: Optional[str] = None,
                        date_to: Optional[str] = None):
    """Download the report's tables as an .xlsx workbook (openpyxl)."""
    if report_id not in reports.REPORT_IDS:
        raise HTTPException(status_code=404, detail=f"Unknown report '{report_id}'")
    xlsx = reports.export_excel(report_id, date_from, date_to)
    return Response(
        content=xlsx,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{report_id}.xlsx"'})


@app.get("/api/reports/{report_id}")
def report_detail(report_id: str, date_from: Optional[str] = None,
                  date_to: Optional[str] = None):
    """Full data payload for one report (generic kpis/table/chart sections).
    Optional ?date_from=&date_to= filters time-series sections."""
    try:
        return reports.build_detail(report_id, date_from, date_to)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown report '{report_id}'")


@app.get("/api/health")
def health():
    return {"status": "ok", "cached": "payload" in _cache,
            "inventory": "inventory" in _cache,
            "dispatch": "dispatch" in _cache,
            "fleet": "fleet" in _cache,
            "reports": bool(reports.REPORT_IDS)}
