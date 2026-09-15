# VibeScreener Server

Standalone market-data API for the VibeScreener dashboard. Pure Node.js — **no npm
dependencies**, no build step, no database.

Live data comes from two free, keyless public APIs:

- GeckoTerminal — `https://api.geckoterminal.com/api/v2`
- DexScreener — `https://api.dexscreener.com`

Birdeye and GoPlus normalizers stay dormant unless `BIRDEYE_API_KEY` / `GOPLUS_API_KEY`
are set.

## Run locally

```bash
node server.js
```

Defaults to `http://localhost:8787`. Requires Node 18+ (it uses the built-in `fetch`).

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Health check — uptime, providers, upstream call counters |
| `GET /api/market?chain=solana&feed=trending&limit=30` | Scored market rows (`feed`: `trending` \| `new` \| `top`) |
| `GET /api/rotation?chain=solana` | Capital rotation view |
| `GET /api/wallets?chain=solana&address=…` | Wallet clusters |
| `GET /api/social?chain=solana` | Social scanner |
| `GET /api/evaluation?chain=solana&horizonMs=…` | Signal evaluation |
| `GET /api/system` | System health / upstream stats |
| `GET /api/score?chain=solana&pool=…` | On-demand scoring of a single pool |
| `GET /api/intel?chain=solana&token=…&pool=…` | Token intel (GoPlus, RugCheck, Jupiter impact) |
| `GET /api/ohlcv?chain=solana&pool=…&timeframe=minute&aggregate=1&limit=60` | OHLCV bars |

CORS is open (`Access-Control-Allow-Origin: *`), so a frontend on another domain can
call it directly. Only `GET` and `OPTIONS` are accepted.

## Configuration

Everything is optional — see [.env.example](.env.example). The ones that matter in the
cloud:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | Render/Railway/Heroku set this automatically |
| `HOST` | `0.0.0.0` | Required binding for cloud hosts |
| `PUBLIC_DIR` | `public` | Static frontend directory (see below) |

## Persistence (optional)

By default the rolling baselines, the stage machine and the holder series live
in RAM, so they are lost whenever the process restarts — which on Render's free
tier means every sleep and every deploy.

Set `FIREBASE_SERVICE_ACCOUNT` to a Firebase service-account key (raw JSON on one
line, or base64) and the server mirrors them to Firestore:

| Collection | One document per | Contents |
| --- | --- | --- |
| `poolHistory` | pool | rolling 15s samples as a JSON string |
| `stages` | token | current stage, `since`, transition history |
| `holders` | token | holder counts over time |

Samples are buffered in RAM and flushed as **one document per changed pool every
10 minutes** (`STORE_FLUSH_MS`), which keeps a 60–80 pool feed inside Firestore's
free 20k writes/day. A flush also runs on `SIGTERM`, so a Render sleep saves the
buffer rather than dropping it.

No npm dependency is used: the Firestore REST API is called with a
service-account JWT signed by `node:crypto`. If the credentials are missing or
invalid the server runs exactly as before and reports it under `store` in
`/health`.

**A sleeping server still collects nothing.** Persistence removes the amnesia,
not the gap — pair it with a keep-alive ping (see below) for a continuous series.

## Keeping a free instance awake

Render free services sleep after ~15 minutes without a request. Point any free
cron service (cron-job.org, UptimeRobot) at `/health` every 10 minutes. One
always-on service fits inside Render's 750 free instance-hours per month.

## Deploy on Render

1. Push this folder to a Git repository (its own repo, or a subfolder of the existing one).
2. Render → **New → Web Service** → connect the repo.
3. Settings:
   - **Root Directory**: `vibescreener-server` (leave blank if this folder is the repo root)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Health Check Path**: `/health`
4. Deploy. Do **not** set `PORT` — Render injects it.

`render.yaml` in this folder describes the same setup as Blueprint config.

## Serving the dashboard from this server (optional)

The server is API-only by default. To ship the React dashboard from the same service,
build the frontend and copy the build into `public/`:

```bash
npm --prefix ../vibescreener-react run build
```

Then copy `../vibescreener-react/dist/*` into `./public/`. The server serves
`public/index.html` at `/`, hashed files under `assets/` with long-lived cache headers,
and falls back to `index.html` for client-side routes. When building the frontend this
way, leave `VITE_API_BASE` unset so it calls same-origin `/api/...`.

## Connecting a separately deployed frontend

Build the React app with the server's public URL:

```bash
VITE_API_BASE=https://your-service.onrender.com npm run build
```

On Render's free tier the service sleeps after inactivity; the first request after a
sleep takes ~30–60s to wake.
