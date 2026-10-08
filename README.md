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

## The raw store — what the app reads

This process is a **collector**. It fetches every provider on its own clock and
writes what it got to plain JSON files; the app reads those files and never calls
the server. There are no API routes: nothing a browser sends can make this process
fetch, sample or compute anything, and nothing the app computes is sent back.

Files live under `data/raw/` (override with `RAW_DIR`) and are served read-only
at `/raw/<file>` as bytes off disk, with an ETag so an unchanged file is a 304.
Each file is written whole and renamed into place, so a reader never sees half
of one.

| File | Rewritten | Contents |
| --- | --- | --- |
| `manifest.json` | on every write | what is here and when each file was written |
| `<chain>/market.json` | every 5s | feed rows, each provider's answer side by side |
| `<chain>/history.json` | every 15s | rolling 15s samples per pool (6h hot window) |
| `<chain>/observations.json` | every 60s | 60s price/liquidity series |
| `<chain>/trades.json` | per trade rotation | wallet-level trade samples per pool |
| `<chain>/intel.json` | one token / 2.5s | GoPlus, RugCheck, Jupiter, Kyber, honeypot, Llama payloads per token |
| `<chain>/ohlcv.json` | one pool / 8s | GeckoTerminal minute bars per pool |
| `<chain>/promotion.json` | every 2 min | DexScreener boosts and profiles |
| `<chain>/observations-48h.json` | every 10 min | 48h of observations from the archive (`DEEP_CHAINS`) |
| `social.json` | when the corpus moves | the social corpus and per-source status |
| `reference.json` | every 60s | CEX/aggregator quotes per quote symbol |
| `coverage.json` | every 5 min | what the archive recorded, per bucket (day and week strips) |
| `system.json` | every 15s | process counters, upstream telemetry, archive health, latest probe/scan |

Every chain in `COLLECT_CHAINS` (default: the eight the app shows) is collected,
and intel and bars are pre-fetched for every board token. The trade, intel and bar
files double as this process's memory: on boot they are read back, so a restart
resumes each rotation instead of re-fetching the board.

`GET /health` stays for the supervisor (`supervise.ps1`); the app does not use it.

| Variable | Default | Notes |
| --- | --- | --- |
| `COLLECT_CHAINS` | the app's eight | must match `Vibe-MM-React/src/data/chains.js` |
| `MARKET_INTERVAL_MS` | `5000` | feed pass, all chains in parallel |
| `WARM_INTERVAL_MS` | `20000` | trade rotation, one chain per cycle |
| `TRADES_PER_CYCLE` | `3` | GeckoTerminal-bound; raise carefully |
| `INTEL_INTERVAL_MS` / `INTEL_REFRESH_MS` | `2500` / 45 min | one token per tick; refresh age |
| `OHLCV_INTERVAL_MS` / `OHLCV_REFRESH_MS` | `8000` / 10 min | one pool per tick; refresh age |
| `GT_COOLDOWN_MS` | `20000` | after a GeckoTerminal 429, every caller backs off together |

## Configuration

Everything is optional — see [.env.example](.env.example). The ones that matter in the
cloud:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | Render/Railway/Heroku set this automatically |
| `HOST` | `0.0.0.0` | Required binding for cloud hosts |
| `PUBLIC_DIR` | `public` | Static frontend directory (see below) |

## Persistence — the on-disk archive

The rolling baselines, the holder series and the score/price observations are
held in RAM, and that RAM dies with the process. `store.js` mirrors them to a
local file so they outlive it. **No credentials, no cloud account, no npm
dependency** — `node:fs` only.

Everything lands under `data/` (override with `ARCHIVE_DIR`), which is
gitignored:

| File | Written | Purpose |
| --- | --- | --- |
| `log/YYYY-MM-DD.jsonl` | append-only, never rewritten | the complete dataset, full detail |
| `snapshot.json` | rewritten atomically (temp + rename) | what boot reloads, so startup is instant |

Two files because the two jobs conflict. An append can only damage the line it
was writing, and a reader skips unparseable lines — so a crash costs at most one
record. Rewriting is the dangerous operation, so the snapshot is written beside
the target and renamed over it; rename is atomic, so a reader sees the whole old
file or the whole new one, never a mixture.

Day files are keyed by **UTC** write date. Only samples newer than the archived
high-water mark are appended, and that mark survives a restart — without it every
flush would re-append whole series.

| Variable | Default | Notes |
| --- | --- | --- |
| `ARCHIVE_DIR` | `./data` | Where the log and snapshot live |
| `STORE_FLUSH_MS` | `30000` | Pool/holder flush interval |
| `STORE_OBSERVATION_FLUSH_MS` | `60000` | Observation flush interval |
| `ARCHIVE_DISABLED` | unset | Set to `1` to run RAM-only |

Flush is **30 seconds**, not the ten minutes an earlier cloud mirror needed. That
interval existed purely to ration billed writes; a local append has no such
price, so the archive is effectively realtime. Don't slow it down "for safety" —
that was billing, not durability. A flush also runs on `SIGTERM`, followed by an
`fsync`, so a graceful stop loses nothing.

Measured at an 80-pool feed: **~37 MB/day**.

### Why JSONL and not CSV

The rows are nested — `sources.{geckoterminal,dexscreener,jupiter}`, flag arrays,
wallet sets. CSV would need those flattened into positional columns, which breaks
the first time a field is added and corrupts silently the first time a string
contains a comma. JSONL costs roughly 2× the bytes and buys schema drift for
free, native nesting, and torn-line recovery.

### Reading it back

The log is read back by the collector itself, never by the app: the deep windows
(`observations-48h.json`) and the coverage strips (`coverage.json`) are built from
it and written to the raw store. Nothing is written to the log from outside this
process; older logs may still hold `app:*` rows from before the raw-store split.

`npm test` runs the archive's durability suite and the raw store's (path guard, atomic rewrite, 304s).

**The archive only fills while the server runs.** It is a local-machine feature:
on an ephemeral-disk host it degrades to a no-op and reports that under `store`
in `/health`. Pair it with a keep-alive ping (see below) for a continuous series.

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

## Connecting a separately deployed frontend

Build the React app with the server's public URL; it reads `<url>/raw/...` from there:

```bash
VITE_API_BASE=https://your-service.onrender.com npm run build
```

On Render's free tier the service sleeps after inactivity; the first request after a
sleep takes ~30–60s to wake.
