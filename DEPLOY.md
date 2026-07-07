# Deploying AI-LOS

**Architecture:** static React/Vite **frontend on Vercel** + long-running FastAPI
**backend on Render** (or Railway/Fly). The backend trains its ML models once at
startup and caches them in memory, so it needs a persistent process — it is *not*
suited to Vercel's serverless functions.

The code is already deploy-ready:
- Frontend reads the backend URL from `VITE_API_BASE` (falls back to
  `http://localhost:8000` in dev) — see `src/api.js`.
- Backend CORS allows `*.vercel.app` and any origins in the `ALLOWED_ORIGINS`
  env var — see `backend/main.py`.

---

## 0. Push to GitHub (one-time)

This folder is not a git repo yet. Vercel + Render deploy from GitHub.

```bash
git init
git add .
git commit -m "AI-LOS: deploy-ready"
git branch -M main
git remote add origin https://github.com/<you>/ai-los.git
git push -u origin main
```

`.venv/`, `venv/`, `node_modules/` and `dist/` are gitignored. The synthetic data
CSVs under `backend/data/` **are** committed, so the backend has its data on boot.

---

## 1. Backend → Render

**Blueprint (easiest):** Render dashboard → **New → Blueprint** → pick the repo →
Apply. It reads `render.yaml` (root dir `backend`, `uvicorn main:app`).

**Or manual:** New → **Web Service** → repo →
- Root Directory: `backend`
- Build: `pip install -r requirements.txt`
- Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Instance type: **Starter or higher** (see caveats)

When it's live, note the URL (e.g. `https://ai-los-api.onrender.com`) and check
`https://<url>/api/health` → should return `{"status":"ok", ...}`.

## 2. Frontend → Vercel

Vercel dashboard → **Add New → Project** → import the repo (framework auto-detects
as **Vite**). Add an Environment Variable:

| Name | Value |
|------|-------|
| `VITE_API_BASE` | `https://ai-los-api.onrender.com` (your Render URL) |

Deploy → you get `https://<project>.vercel.app`.

## 3. CORS

The backend already allows any `*.vercel.app` origin, so it works immediately. If
you add a **custom domain**, set `ALLOWED_ORIGINS=https://yourdomain.com` in the
Render service env vars and redeploy.

---

## Caveats

- **RAM:** training Prophet + XGBoost + OR-Tools + IsolationForest at boot needs
  memory. Render's **free 512MB tier can OOM** — use Starter (or bigger).
- **Cold start:** the free tier spins down when idle; the next request retrains
  everything (~30–60s). Starter avoids spin-down.
- **First build is slow:** installing Prophet (cmdstan) takes a few minutes.
- **Exports** (PDF/Excel) download straight from the backend URL — no extra config.
