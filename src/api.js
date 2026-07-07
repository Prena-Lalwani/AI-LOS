// Base URL of the FastAPI backend.
//   Dev  : falls back to http://localhost:8000
//   Prod : set VITE_API_BASE at build time (Vercel env var) to your deployed
//          backend URL, e.g. https://ai-los-api.onrender.com
export const API_BASE = (import.meta.env.VITE_API_BASE || 'http://localhost:8000').replace(/\/+$/, '');
