# AI-LOS — AI Logistics Operating System

A full-stack logistics intelligence platform for dispatch, warehouse, fleet,
demand and executive teams. A **React + Vite** frontend renders seven modules;
a **FastAPI** backend serves them with **real machine-learning models** trained
on self-generated synthetic datasets (no faked numbers — every metric is
computed).

---

## Modules

| Module | What it does | Backend / ML |
|--------|--------------|--------------|
| **Executive Intelligence** | Headline KPIs, revenue vs profit trend, regions, health ring, alerts, recommendations | Precomputed from the DataCo dataset (`src/data/execIntelligenceData.json`) |
| **Order & Demand Intelligence** | Weekly demand trend, 4-week forecast with confidence band, seasonal / category / region mix | **Prophet** time-series forecast |
| **Inventory & Warehouse Intelligence** | EOQ reorder points, safety stock, overstock, occupancy heatmap, congestion, picking route | **RandomForest** stock-out classifier + **OR-Tools** TSP picking route |
| **Dispatch Intelligence** | Truck/driver assignment, routing, load balancing, fuel stops, delay & overtime prediction | **OR-Tools CVRPTW** solver + **RandomForest** delay regressor |
| **Fleet Intelligence** | Predictive maintenance risk, anomaly detection, utilization, driver performance, fuel analytics, maintenance schedule | **XGBoost** breakdown classifier + **IsolationForest** anomaly detection |
| **Reports & Analytics** | 6 reports aggregating all modules; PDF & Excel export; date-range filtering | Aggregation layer + **reportlab** (PDF) / **openpyxl** (Excel) |
| **AI Operations Copilot** | Natural-language Q&A across modules | Deterministic keyword-routed mock (`src/data/copilot.js`) |

> Historical data is anchored to a fixed past window and **date-shifted forward
> to "today"** at serve time, so every module reads as live.

---

## Architecture

```
┌─────────────────────────┐        HTTP/JSON        ┌──────────────────────────────┐
│  React + Vite frontend  │  ───────────────────▶   │  FastAPI backend (uvicorn)     │
│  (Vercel)               │  ◀───────────────────   │  trains ML models ONCE at      │
│  src/api.js → API_BASE  │                         │  startup, caches in memory     │
└─────────────────────────┘                         └──────────────────────────────┘
                                                          │ reads
                                                          ▼
                                              backend/data/*.csv (synthetic,
                                              seed=42, deterministic)
```

The backend trains all models at startup and caches the payloads, so requests are
fast. This requires a **long-running process** (Render/Railway/Fly), not
serverless — see [DEPLOY.md](DEPLOY.md).

---

## Tech stack

- **Frontend:** React 18, Vite, React Router, Recharts, React-Leaflet (dispatch
  map), plain CSS with custom-property tokens (light/dark).
- **Backend:** FastAPI, Uvicorn, pandas, NumPy, Prophet, scikit-learn, XGBoost,
  Google OR-Tools, reportlab, openpyxl, Faker.

---

## Getting started

### 1. Backend

```bash
cd backend
python -m venv venv
# Windows:  venv\Scripts\activate     macOS/Linux:  source venv/bin/activate
pip install -r requirements.txt

# (optional) regenerate the synthetic datasets — they are already committed.
# Order matters: warehouses first, then dispatch, then fleet.
python -m data_generation.generate_warehouse_data
python -m data_generation.generate_dispatch_data
python -m data_generation.generate_fleet_data

uvicorn main:app --reload --port 8000
```

On startup the backend trains Prophet, the inventory/dispatch/fleet models and
solves today's VRP (~20–30s). Wait for the `Reports ready …` log line, then hit
`http://localhost:8000/api/health`.

### 2. Frontend

```bash
npm install
npm run dev      # http://localhost:5173
```

The frontend calls the backend at `VITE_API_BASE` (defaults to
`http://localhost:8000`). Executive and Copilot work without the backend; the
other five modules need it running.

```bash
npm run build    # production build to dist/
npm run preview  # preview the build
```

---

## API endpoints

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/demand/forecast` | Demand payload (Prophet) |
| GET | `/api/inventory/dashboard` | Inventory payload |
| GET | `/api/dispatch/plan?date=` | Dispatch VRP plan for a day |
| GET | `/api/fleet/dashboard` | Fleet payload (risk, anomalies, …) |
| GET | `/api/reports/list` | The 6 available reports |
| GET | `/api/reports/{id}?date_from=&date_to=` | One report's data (generic sections) |
| GET | `/api/reports/{id}/export/pdf` | Report as a PDF download |
| GET | `/api/reports/{id}/export/excel` | Report as an .xlsx download |
| GET | `/api/health` | Cache/readiness status |

---

## Design system

- **Theme:** edit `src/styles/tokens.css` only — every color pulls from a CSS
  custom property, so the whole app reskins from one file.
- **Color rule:** `--accent-flow` (teal) = flowing / normal / on-time;
  `--accent-attention` (amber) = needs attention; `--critical` (red) = blocking,
  used sparingly.
- **Shared visual language:** severity accent bars, tinted mini-cards, accent-row
  lists, stat boxes, progress bars and `.pill` badges — consistent across pages.
- **Type:** Barlow Condensed (headers / KPI numbers), IBM Plex Sans (body/UI),
  IBM Plex Mono (IDs, values). Loaded via Google Fonts in `index.html`.
- **Charts:** all Recharts series pass explicit token colors through the
  `TrendChart` wrapper — never the default palette.

---

## Project structure

```
index.html
vercel.json                  # Vercel SPA config
render.yaml                  # Render backend blueprint
DEPLOY.md                    # deployment guide
src/
  main.jsx  App.jsx  modules.js
  api.js                     # backend base URL (VITE_API_BASE)
  user.js                    # signed-in user (sidebar/topbar)
  theme/ThemeContext.jsx
  styles/{tokens,global}.css
  components/                # Sidebar, TopBar, StatusRibbon, KpiCard,
                             # DataTable, TrendChart, HealthScoreRing, …
  data/                      # Executive JSON + Copilot mock
  pages/                     # Executive Demand Inventory Dispatch Fleet Reports Copilot
backend/
  main.py                    # FastAPI app; trains + caches models at startup
  requirements.txt
  models/                    # demand_forecast, inventory_intelligence,
                             # dispatch_intelligence, fleet_intelligence,
                             # reports_analytics
  data_generation/           # deterministic synthetic data generators (seed=42)
  data/                      # generated CSVs (warehouse / dispatch / fleet)
```

---

## Deployment

Frontend → **Vercel**, backend → **Render** (or Railway/Fly). Full step-by-step in
[DEPLOY.md](DEPLOY.md). The backend cannot run on Vercel's serverless functions
(startup model training + in-memory cache + heavy ML deps).
