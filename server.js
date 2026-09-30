"use strict";

/**
 * VibeScreener data server.
 *
 * This process fetches from public APIs, remembers raw numbers, and writes
 * them to the raw store (lib/raw-store.js). The app reads those files and
 * never calls this process: there are no API routes, and nothing the app does
 * can make it fetch, sample or compute. It does not score, rank, stage, flag
 * or judge anything - every derived number the dashboard shows is computed in
 * the app, in Vibe-MM-React/src/calculations, from the raw files.
 *
 * What the server owns, and why:
 *   - every provider call, on its own clock, because a browser tab cannot be
 *     trusted with GeckoTerminal's ~30 calls/min budget and is not open
 *     around the clock
 *   - rolling sample series and the on-disk archive, because a baseline needs
 *     hours of observation
 *   - one origin for a dozen providers, several of which would refuse a
 *     browser request outright
 *
 * Providers, all keyless: GeckoTerminal, DexScreener, Jupiter, KyberSwap,
 * GoPlus, RugCheck, honeypot.is, DefiLlama, Binance, Coinbase, CoinGecko,
 * and the 4chan /biz/ catalog.
 */

const http = require("http");

const { CHAINS, FEEDS, resolveChain } = require("./lib/chains");
const { fetchJson, cached, cacheStats, toNumber, upstreamTelemetry } = require("./lib/fetcher");
const P = require("./lib/providers");
const memory = require("./lib/memory");
const store = require("./store");
const raw = require("./lib/raw-store");
// Optional. Serves the built dashboard, gzips raw files and redacts /health
// for remote callers, so this collector can be put behind a tunnel. Removing
// the require and the share.handle() call below restores the old behaviour.
const share = require("./lib/share");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_ROWS = Number(process.env.MAX_ROWS || 30);

/* ------------------------------------------------------------ market feed */

/**
 * One row per pool: identity, plus each provider's answer kept separate.
 *
 * Nothing is blended here. If GeckoTerminal and DexScreener disagree about the
 * price, both prices are in the row and the app decides - that is what makes
 * "sources agreeing" computable on the client instead of being asserted here.
 */
function buildRow(pool, included, chain, dexPairsByToken, jupiterByMint) {
  const attributes = (pool && pool.attributes) || {};
  const relationships = (pool && pool.relationships) || {};
  const baseTokenId = relationships.base_token && relationships.base_token.data
    ? relationships.base_token.data.id : null;
  const quoteTokenId = relationships.quote_token && relationships.quote_token.data
    ? relationships.quote_token.data.id : null;
  const dexId = relationships.dex && relationships.dex.data ? relationships.dex.data.id : null;

  const baseTokenEntry = included.get("token:" + baseTokenId);
  const quoteTokenEntry = included.get("token:" + quoteTokenId);
  const baseToken = (baseTokenEntry && baseTokenEntry.attributes) || {};
  const quoteToken = (quoteTokenEntry && quoteTokenEntry.attributes) || {};

  const tokenAddress = baseToken.address || P.splitGtId(baseTokenId).address;
  const dexPairs = (tokenAddress && dexPairsByToken.get(String(tokenAddress).toLowerCase())) || [];
  const pair = P.pickPair(dexPairs, attributes.address);

  return {
    chain: chain.key,
    tokenAddress: tokenAddress || null,
    poolAddress: attributes.address || (pair && pair.pairAddress) || null,
    symbol: baseToken.symbol || (pair && pair.baseToken && pair.baseToken.symbol) ||
      String(attributes.name || "").split("/")[0].trim() || null,
    name: baseToken.name || (pair && pair.baseToken && pair.baseToken.name) || null,
    pairName: attributes.name || null,
    quoteSymbol: quoteToken.symbol || (pair && pair.quoteToken && pair.quoteToken.symbol) || null,
    imageUrl: baseToken.image_url || (pair && pair.info && pair.info.imageUrl) || null,
    dexId: dexId || (pair && pair.dexId) || null,

    links: {
      dexscreener: (pair && pair.url) ||
        (attributes.address ? "https://dexscreener.com/" + chain.ds + "/" + attributes.address : null),
      geckoterminal: attributes.address
        ? "https://www.geckoterminal.com/" + chain.gt + "/pools/" + attributes.address : null,
      websites: ((pair && pair.info && pair.info.websites) || []).map((s) => s.url),
      socials: ((pair && pair.info && pair.info.socials) || [])
        .map((s) => ({ type: s.type, url: s.url })),
    },

    // Each provider's own answer, untouched and unranked.
    sources: {
      geckoterminal: P.gtPoolFields(attributes),
      dexscreener: pair
        ? Object.assign(P.dsPairFields(pair), { pairsListed: dexPairs.length })
        : null,
      jupiter: (tokenAddress && jupiterByMint.get(tokenAddress)) || null,
    },
  };
}

async function buildFeed({ chain, feed, limit, tokenAddress }) {
  const fetchedAt = Date.now();
  const errors = [];

  let list;
  if (tokenAddress) {
    list = await cached("gt:token:" + chain.gt + ":" + tokenAddress, P.GT_CACHE_TTL_MS, async () => {
      const payload = await fetchJson(
        "https://api.geckoterminal.com/api/v2/networks/" + chain.gt + "/tokens/" +
        encodeURIComponent(tokenAddress) + "/pools?include=base_token,quote_token,dex");
      return {
        pools: Array.isArray(payload && payload.data) ? payload.data : [],
        included: P.indexIncluded(payload),
        listFetchedAt: Date.now(), stale: false, staleReason: null,
      };
    });
  } else {
    list = await P.fetchPoolList(chain, feed);
  }

  const pools = list.pools.slice(0, limit);

  // Base-token addresses drive both the DexScreener and Jupiter lookups.
  const addresses = pools.map((pool) => {
    const rel = pool.relationships && pool.relationships.base_token &&
      pool.relationships.base_token.data ? pool.relationships.base_token.data.id : null;
    const entry = list.included.get("token:" + rel);
    return (entry && entry.attributes && entry.attributes.address) || P.splitGtId(rel).address;
  }).filter(Boolean);

  const [dexPairs, jupiterByMint] = await Promise.all([
    P.fetchDexScreenerTokens(addresses).catch((error) => {
      errors.push({ source: P.SOURCES.DEXSCREENER, message: error.message });
      return [];
    }),
    P.fetchJupiterTokens(chain, addresses).catch(() => new Map()),
  ]);

  const dexPairsByToken = new Map();
  dexPairs.forEach((pair) => {
    if (pair && pair.chainId && pair.chainId !== chain.ds) return;
    const address = pair && pair.baseToken && pair.baseToken.address;
    if (!address) return;
    const key = String(address).toLowerCase();
    if (!dexPairsByToken.has(key)) dexPairsByToken.set(key, []);
    dexPairsByToken.get(key).push(pair);
  });

  const rows = pools.map((pool) => buildRow(pool, list.included, chain, dexPairsByToken, jupiterByMint));

  // Remembering is the server's job; interpreting is not.
  memory.recordSamples(chain.key, rows);
  memory.recordObservations(chain.key, rows);

  return {
    server: "ok",
    chain: chain.key,
    chainLabel: chain.label,
    feed: tokenAddress ? "token" : feed,
    fetchedAt: fetchedAt,
    fetchedAtIso: new Date(fetchedAt).toISOString(),
    poolList: {
      source: P.SOURCES.GECKOTERMINAL,
      fetchedAt: list.listFetchedAt || fetchedAt,
      stale: Boolean(list.stale),
      staleReason: list.staleReason || null,
      ttlMs: P.GT_LIST_TTL_MS,
    },
    providers: [
      { source: P.SOURCES.GECKOTERMINAL, keyless: true, ok: pools.length > 0, pools: pools.length,
        role: "pool discovery", stale: Boolean(list.stale) },
      { source: P.SOURCES.DEXSCREENER, keyless: true, ok: dexPairs.length > 0, pairs: dexPairs.length,
        role: "pricing" },
      { source: P.SOURCES.JUPITER, keyless: true, ok: jupiterByMint.size > 0,
        tokens: jupiterByMint.size, note: chain.key === "solana" ? null : "Solana only" },
    ],
    rowCount: rows.length,
    rows: rows,
    errors: errors,
  };
}

/* ----------------------------------------------------------------- intel */

/**
 * Per-token deep data. Every provider payload is forwarded in the shape its
 * provider gave it - the pass/fail safety checklist, the holder-share sum and
 * the routed price impact are all computed in the app now.
 */
async function buildIntel(chain, tokenAddress) {
  const sources = {};
  const isSolana = chain.key === "solana";
  const note = (name, value) => { sources[name] = value; return null; };

  const goPlusTarget = P.goPlusUrl(chain.key, tokenAddress);
  const [goPlusRaw, rugRaw, jupQuote] = await Promise.all([
    goPlusTarget
      ? fetchJson(goPlusTarget).then((d) => { sources.goplus = "ok"; return d; })
        .catch((e) => { sources.goplus = e.message; return null; })
      : Promise.resolve(note("goplus", "chain not supported by GoPlus")),
    isSolana
      ? fetchJson(P.RUGCHECK_BASE + "/tokens/" + encodeURIComponent(tokenAddress) + "/report")
        .then((d) => { sources.rugcheck = "ok"; return d; })
        .catch((e) => { sources.rugcheck = e.message; return null; })
      : Promise.resolve(note("rugcheck", "Solana only")),
    isSolana
      ? P.fetchJupiterQuote(tokenAddress)
        .then((d) => { sources.jupiterQuote = d ? "ok" : "no route"; return d; })
        .catch((e) => { sources.jupiterQuote = e.message; return null; })
      : Promise.resolve(note("jupiterQuote", "Solana only")),
  ]);

  const [kyber, honeypot, llama, jupToken] = await Promise.all([
    isSolana
      ? Promise.resolve(note("kyberswap", "EVM only"))
      : P.fetchKyberQuote(chain, tokenAddress)
        .then((d) => { sources.kyberswap = d ? "ok" : "no route"; return d; })
        .catch((e) => { sources.kyberswap = e.message; return null; }),
    isSolana
      ? Promise.resolve(note("honeypot", "EVM only"))
      : P.fetchHoneypot(chain, tokenAddress)
        .then((d) => { sources.honeypot = d ? "ok" : "no data"; return d; })
        .catch((e) => { sources.honeypot = e.message; return null; }),
    P.fetchLlamaPrice(chain, tokenAddress)
      .then((d) => { sources.defillama = d ? "ok" : "not indexed"; return d; })
      .catch((e) => { sources.defillama = e.message; return null; }),
    isSolana
      ? P.fetchJupiterTokens(chain, [tokenAddress])
        .then((map) => {
          const d = map.get(tokenAddress) || null;
          sources.jupiterTokens = d ? "ok" : "not indexed";
          return d;
        })
        .catch((e) => { sources.jupiterTokens = e.message; return null; })
      : Promise.resolve(note("jupiterTokens", "Solana only")),
  ]);

  const goPlusRecord = P.pickGoPlusRecord(goPlusRaw, tokenAddress);

  // Holder count is remembered so the app can measure growth across a window
  // longer than one page view. Picking the first provider that answered is
  // presence, not preference.
  const holderCount = [
    toNumber(goPlusRecord && goPlusRecord.holder_count),
    toNumber(rugRaw && rugRaw.totalHolders),
    jupToken ? jupToken.holderCount : null,
  ].find((v) => Number.isFinite(v));
  if (Number.isFinite(holderCount)) memory.recordHolderCount(chain.key, tokenAddress, holderCount);

  return {
    server: "ok",
    chain: chain.key,
    tokenAddress: tokenAddress,
    fetchedAt: Date.now(),
    sources: sources,
    // Raw provider payloads, named by who said it.
    goplus: goPlusRecord,
    rugcheck: rugRaw
      ? {
          scoreNormalised: toNumber(rugRaw.score_normalised),
          risks: (rugRaw.risks || []).map((r) => ({
            name: r.name, level: r.level, description: r.description, score: r.score,
          })),
          totalHolders: toNumber(rugRaw.totalHolders),
          totalLPProviders: toNumber(rugRaw.totalLPProviders),
          markets: (rugRaw.markets || []).map((m) => ({
            liquidityA: toNumber(m.liquidityA),
            lpLockedPct: toNumber(m.lp && m.lp.lpLockedPct),
          })),
          lpLockedPctRaw: toNumber(rugRaw.lpLockedPct),
          launchpad: typeof rugRaw.launchpad === "string"
            ? rugRaw.launchpad
            : (rugRaw.launchpad && (rugRaw.launchpad.name || rugRaw.launchpad.id)) || null,
          creatorTokenCount: Array.isArray(rugRaw.creatorTokens) ? rugRaw.creatorTokens.length : null,
          graphInsidersDetected: rugRaw.graphInsidersDetected === undefined
            ? null : Boolean(rugRaw.graphInsidersDetected),
        }
      : null,
    jupiterQuote: jupQuote,
    kyberQuote: kyber,
    honeypot: honeypot,
    defillama: llama,
    jupiterToken: jupToken,
    holderSeries: memory.holderSeries(chain.key, tokenAddress),
  };
}

/* ------------------------------------------------------------- collectors */

/**
 * The collectors are the whole job now.
 *
 * Nothing here answers the app. Each collector fetches from providers on its
 * own clock and writes what it got into the raw store (lib/raw-store.js); the
 * app reads those files and never asks this process for anything. That is
 * what makes the data reliable: what the app scores is exactly what was
 * written, the same bytes every reader sees, and none of it depends on a
 * browser tab being open to trigger a fetch.
 *
 * Budgets, per minute, at the defaults:
 *   GeckoTerminal (~30 free)  pool lists 8 per 3 min, trades 9, bars 7.5
 *   DexScreener (~300)        one batched call per chain per market pass = 96
 *   intel providers           one token per 2.5s, each token ~7 calls spread
 *                             across GoPlus/RugCheck/Jupiter/Kyber/honeypot/Llama
 */

/**
 * Every chain the app shows. Must match Vibe-MM-React/src/data/chains.js -
 * a chain the app lists but nobody collects is a permanently empty board row.
 */
const COLLECT_CHAINS = (process.env.COLLECT_CHAINS ||
  "solana,ethereum,base,bsc,arbitrum,polygon,avalanche,robinhood")
  .split(",").map((s) => s.trim()).filter((key) => resolveChain(key));

/** Chains whose 48h observation window is written, for Precision@20. */
const DEEP_CHAINS = (process.env.DEEP_CHAINS || "solana")
  .split(",").map((s) => s.trim()).filter((key) => resolveChain(key));

const MARKET_INTERVAL_MS = Number(process.env.MARKET_INTERVAL_MS || 5000);
/**
 * One pool's trades per tick. It used to be three pools every 20s; GeckoTerminal
 * refuses bursts, so the three arrived together and the second and third were
 * 429s - after five minutes only 12 pools across all chains had been sampled
 * and the WALLETS tab was empty for nearly every token. Evenly spaced single
 * pulls get through.
 */
const TRADES_INTERVAL_MS = Number(process.env.TRADES_INTERVAL_MS || 3000);
const INTEL_INTERVAL_MS = Number(process.env.INTEL_INTERVAL_MS || 2500);
const INTEL_REFRESH_MS = Number(process.env.INTEL_REFRESH_MS || 2700000);
// Bars share GeckoTerminal with trades and yield to them - see collectOhlcv.
const OHLCV_INTERVAL_MS = Number(process.env.OHLCV_INTERVAL_MS || 15000);
/**
 * 30 min, not 10: 160 board pools every 10 minutes was 16 calls a minute on
 * its own - more than GeckoTerminal's whole ~10/min budget. Bars only draw a
 * chart, and the chart falls back to our own 15s samples in between.
 */
const OHLCV_REFRESH_MS = Number(process.env.OHLCV_REFRESH_MS || 1800000);
/**
 * The long view: 15-minute bars, a week per call (GeckoTerminal serves up to
 * 1000 bars, 700 x 15min = 7.3 days). One call per board pool every 2h keeps
 * the week current for ~1.3 calls a minute, taken only when the gate is free.
 * Merged into <chain>/bars15/<pool>.json and kept BARS15_KEEP_MS, so a pool
 * that leaves the board keeps its history for later evaluation.
 */
const BARS15_INTERVAL_MS = Number(process.env.BARS15_INTERVAL_MS || 20000);
const BARS15_REFRESH_MS = Number(process.env.BARS15_REFRESH_MS || 7200000);
const BARS15_LIMIT = Number(process.env.BARS15_LIMIT || 700);
const BARS15_KEEP_MS = Number(process.env.BARS15_KEEP_MS || 30 * 86400000);
const REFERENCE_INTERVAL_MS = Number(process.env.REFERENCE_INTERVAL_MS || 60000);
const SOCIAL_INTERVAL_MS = Number(process.env.SOCIAL_INTERVAL_MS || 30000);
const PROMOTION_INTERVAL_MS = Number(process.env.PROMOTION_INTERVAL_MS || 120000);
const SYSTEM_INTERVAL_MS = Number(process.env.SYSTEM_INTERVAL_MS || 15000);
const COVERAGE_INTERVAL_MS = Number(process.env.COVERAGE_INTERVAL_MS || 300000);
const DEEP_INTERVAL_MS = Number(process.env.DEEP_INTERVAL_MS || 600000);
const PROBE_INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS || 300000);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 3600000);

/** Rows per chain written to market.json. The board shows the first 20. */
const FEED_ROWS = MAX_ROWS;
/** How far down each feed intel and bars are pre-fetched - the rows the board shows. */
const ENRICH_ROWS = Number(process.env.ENRICH_ROWS || 20);

/**
 * How far down each feed the trade sampler goes: exactly the rows the board
 * shows (20 per chain, 160 pools). Every one of them is sampled before any is
 * refreshed, so no board token is left without wallet data.
 */
const ROTATION_POOLS = Number(process.env.ROTATION_POOLS || ENRICH_ROWS);
/** A board pool whose trade sample is older than this is due a refresh. */
const TRADES_REFRESH_MS = Number(process.env.TRADES_REFRESH_MS || 600000);

/** The latest feed rows per chain - what intel, bars and trades are aimed at. */
const latestFeed = new Map();
/** chain -> Map(token -> intel payload) */
const intelByChain = new Map();
/** chain -> Map(pool -> { at, timeframe, aggregate, source, bars, reason }) */
const ohlcvByChain = new Map();

/**
 * What each collector last did. The collectors are the only thing keeping data
 * accruing, so when one quietly stops - a rate limit it never recovers from, a
 * chain that resolves to nothing - every reader of that file goes stale with no
 * visible cause. Counters only; nothing derived.
 */
const collectorState = new Map();
/** Per-chain market pass outcome - the old warm-loop state, same shape. */
const warmState = new Map();

function noteRun(name, startedAt, error, extra) {
  const prev = collectorState.get(name) || { runs: 0, failures: 0 };
  // Only the counters carry over; the detail is this run's alone, or an idle
  // pass would still name the token the previous pass fetched.
  collectorState.set(name, Object.assign({}, extra || {}, {
    at: Date.now(), ms: Date.now() - startedAt,
    runs: prev.runs + 1,
    failures: prev.failures + (error ? 1 : 0),
    error: error ? String(error.message || error).slice(0, 200) : null,
  }));
}

/** Runs `fn` on an interval, never overlapping itself, never throwing out. */
function every(name, intervalMs, fn) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    const startedAt = Date.now();
    try {
      const extra = await fn();
      noteRun(name, startedAt, null, extra);
    } catch (error) {
      noteRun(name, startedAt, error);
      console.log("collect " + name + " failed: " + error.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  run();
}

// Files whose source changes slower than the market pass are rewritten on
// their own cadence, so an unchanged megabyte is not rewritten every 5s.
const lastWritten = new Map();
function writeAtMost(rel, minGapMs, bodyFn) {
  const last = lastWritten.get(rel) || 0;
  if (Date.now() - last < minGapMs) return 0;
  lastWritten.set(rel, Date.now());
  return raw.write(rel, bodyFn());
}

/* ---- market: feed rows, samples, observations -------------------------- */

async function collectMarketChain(chain) {
  const startedAt = Date.now();
  try {
    const data = await buildFeed({ chain: chain, feed: "trending", limit: FEED_ROWS, tokenAddress: null });
    latestFeed.set(chain.key, data.rows || []);
    raw.write(chain.key + "/market.json", data);
    // Samples are taken at most every 15s and observations every 60s, so
    // writing them faster than that would only rewrite the same bytes.
    writeAtMost(chain.key + "/history.json", memory.HISTORY_MIN_GAP_MS, () => ({
      chain: chain.key,
      minGapMs: memory.HISTORY_MIN_GAP_MS,
      maxAgeMs: memory.HISTORY_MAX_AGE_MS,
      maxSamples: memory.HISTORY_MAX_SAMPLES,
      samples: memory.samplesFor(chain.key, null),
    }));
    writeAtMost(chain.key + "/observations.json", memory.OBSERVATION_GAP_MS, () => ({
      chain: chain.key,
      tokens: memory.observationsFor(chain.key),
    }));
    warmState.set(chain.key, {
      at: Date.now(), ms: Date.now() - startedAt, rows: (data.rows || []).length, error: null,
    });
  } catch (error) {
    warmState.set(chain.key, {
      at: Date.now(), ms: Date.now() - startedAt, rows: 0, error: error.message,
    });
  }
}

async function collectMarket() {
  const chains = COLLECT_CHAINS.map(resolveChain);
  await Promise.all(chains.map(collectMarketChain));
  memory.pruneHistory();
  return { chains: chains.length };
}

/* ---- trades: wallet-level trades for every board pool ----------------- */

/**
 * The next pool to sample, across ALL chains: a pool never sampled beats a
 * refresh - until it is sampled once its score has no wallet input and the
 * WALLETS and ROTATION tabs have nothing on it - and chains take turns so no
 * chain waits behind another's whole board. After that, the stalest sample.
 */
let tradeChainCursor = 0;
function nextTradeTarget() {
  const now = Date.now();
  let stalest = null;
  for (let i = 0; i < COLLECT_CHAINS.length; i += 1) {
    const chainKey = COLLECT_CHAINS[(tradeChainCursor + i) % COLLECT_CHAINS.length];
    const rows = (latestFeed.get(chainKey) || []).slice(0, ROTATION_POOLS).filter((r) => r.poolAddress);
    for (const row of rows) {
      const hit = memory.tradeSamples.get(chainKey + ":" + row.poolAddress);
      if (!hit) {
        tradeChainCursor = (tradeChainCursor + i + 1) % COLLECT_CHAINS.length;
        return { chainKey, row };
      }
      const age = now - (hit.at || 0);
      if (age >= TRADES_REFRESH_MS && (!stalest || age > stalest.age)) stalest = { chainKey, row, age };
    }
  }
  tradeChainCursor = (tradeChainCursor + 1) % COLLECT_CHAINS.length;
  return stalest;
}

/** Board pools on every chain with no trade sample yet. Bars wait while any remain. */
function unsampledTradePools() {
  let n = 0;
  COLLECT_CHAINS.forEach((chainKey) => {
    (latestFeed.get(chainKey) || []).slice(0, ROTATION_POOLS).forEach((r) => {
      if (r.poolAddress && !memory.tradeSamples.has(chainKey + ":" + r.poolAddress)) n += 1;
    });
  });
  return n;
}

async function collectTrades() {
  const target = nextTradeTarget();
  if (!target) return { idle: true };
  const { chainKey, row } = target;
  let limited = false;
  let archived = 0;
  try {
    const trades = await P.fetchPoolTrades(resolveChain(chainKey), row.poolAddress);
    memory.recordTrades(chainKey, row.poolAddress, row.symbol, trades);
    // The permanent record: every trade not archived before, appended to the
    // log. trades.json only holds the latest sample per pool.
    archived = store.archiveTrades(chainKey, row.poolAddress, row.symbol, trades);
  } catch (error) {
    limited = String(error.message || "").includes("429");
    if (!limited) throw error;
  }
  raw.write(chainKey + "/trades.json", {
    chain: chainKey,
    // Pools keep their last sample; `at` on each says when it was taken.
    rateLimited: limited,
    pools: memory.tradesFor(chainKey, null),
  });
  return { chain: chainKey, pool: row.poolAddress, rateLimited: limited, archived, unsampled: unsampledTradePools() };
}

/* ---- intel: every board token, refreshed on a slow rotation ------------ */

function intelMap(chainKey) {
  if (!intelByChain.has(chainKey)) intelByChain.set(chainKey, new Map());
  return intelByChain.get(chainKey);
}

/**
 * The next token to fetch: one we have never fetched beats one gone stale, and
 * chains take turns so no chain waits behind another's whole board.
 */
let intelChainCursor = 0;
function nextIntelTarget() {
  const now = Date.now();
  let stalest = null;
  for (let i = 0; i < COLLECT_CHAINS.length; i += 1) {
    const chainKey = COLLECT_CHAINS[(intelChainCursor + i) % COLLECT_CHAINS.length];
    const held = intelMap(chainKey);
    const rows = (latestFeed.get(chainKey) || []).slice(0, ENRICH_ROWS).filter((r) => r.tokenAddress);
    for (const row of rows) {
      const hit = held.get(row.tokenAddress);
      if (!hit) {
        intelChainCursor = (intelChainCursor + i + 1) % COLLECT_CHAINS.length;
        return { chainKey, token: row.tokenAddress };
      }
      const age = now - (hit.fetchedAt || 0);
      if (age >= INTEL_REFRESH_MS && (!stalest || age > stalest.age)) {
        stalest = { chainKey, token: row.tokenAddress, age };
      }
    }
  }
  intelChainCursor = (intelChainCursor + 1) % COLLECT_CHAINS.length;
  return stalest;
}

function writeIntel(chainKey) {
  const held = intelMap(chainKey);
  // Tokens that left the feed are kept for a while - a token drops out and
  // comes back - but not forever, or the file only ever grows.
  const onFeed = new Set((latestFeed.get(chainKey) || []).map((r) => r.tokenAddress));
  const cutoff = Date.now() - 6 * 3600000;
  held.forEach((payload, token) => {
    if (!onFeed.has(token) && (payload.fetchedAt || 0) < cutoff) held.delete(token);
  });
  raw.write(chainKey + "/intel.json", { chain: chainKey, tokens: Object.fromEntries(held) });
}

async function collectIntel() {
  const target = nextIntelTarget();
  if (!target) return { idle: true };
  const payload = await buildIntel(resolveChain(target.chainKey), target.token);
  intelMap(target.chainKey).set(target.token, payload);
  writeIntel(target.chainKey);
  return { chain: target.chainKey, token: target.token };
}

/* ---- bars: minute OHLCV per board pool --------------------------------- */

function ohlcvMap(chainKey) {
  if (!ohlcvByChain.has(chainKey)) ohlcvByChain.set(chainKey, new Map());
  return ohlcvByChain.get(chainKey);
}

let ohlcvChainCursor = 0;
function nextOhlcvTarget() {
  const now = Date.now();
  let stalest = null;
  for (let i = 0; i < COLLECT_CHAINS.length; i += 1) {
    const chainKey = COLLECT_CHAINS[(ohlcvChainCursor + i) % COLLECT_CHAINS.length];
    const held = ohlcvMap(chainKey);
    const rows = (latestFeed.get(chainKey) || []).slice(0, ENRICH_ROWS).filter((r) => r.poolAddress);
    for (const row of rows) {
      const hit = held.get(row.poolAddress);
      if (!hit) {
        ohlcvChainCursor = (ohlcvChainCursor + i + 1) % COLLECT_CHAINS.length;
        return { chainKey, pool: row.poolAddress };
      }
      const age = now - (hit.at || 0);
      if (age >= OHLCV_REFRESH_MS && (!stalest || age > stalest.age)) {
        stalest = { chainKey, pool: row.poolAddress, age };
      }
    }
  }
  ohlcvChainCursor = (ohlcvChainCursor + 1) % COLLECT_CHAINS.length;
  return stalest;
}

async function collectOhlcv() {
  // Trades feed the score, WALLETS and ROTATION; bars only draw a chart, and
  // the chart can be drawn from our own 15s samples meanwhile. So bars take no
  // GeckoTerminal budget until every board pool has been trade-sampled once.
  const waiting = unsampledTradePools();
  if (waiting) return { yielding: true, unsampledTradePools: waiting };
  const target = nextOhlcvTarget();
  if (!target) return { idle: true };
  const chain = resolveChain(target.chainKey);
  const held = ohlcvMap(target.chainKey);
  try {
    const bars = await P.fetchOhlcv(chain, target.pool, "minute", 1, 60, { priority: "low" });
    held.set(target.pool, {
      at: Date.now(), timeframe: "minute", aggregate: 1,
      source: P.SOURCES.GECKOTERMINAL, bars: bars, reason: bars.length ? null : "empty",
    });
  } catch (error) {
    // Held back by our own gate - nothing was asked, so nothing failed. Leave
    // the pool as it was and try again next tick; marking it would park it for
    // a whole refresh period over a call that never left.
    if (error.gated) return { yielding: true, gated: error.gated };
    const limited = error.status === 429 || /429/.test(error.message || "");
    // Keep the last good bars; only record that the refresh failed. Without a
    // prior reading, store the failure so the pool is not retried every tick.
    const prior = held.get(target.pool);
    held.set(target.pool, Object.assign({}, prior || { timeframe: "minute", aggregate: 1, bars: [] }, {
      at: Date.now(),
      reason: limited ? "rate_limited" : "upstream_error",
      error: error.message,
    }));
  }
  const onFeed = new Set((latestFeed.get(target.chainKey) || []).map((r) => r.poolAddress));
  const cutoff = Date.now() - 6 * 3600000;
  held.forEach((entry, pool) => { if (!onFeed.has(pool) && (entry.at || 0) < cutoff) held.delete(pool); });
  raw.write(target.chainKey + "/ohlcv.json", { chain: target.chainKey, pools: Object.fromEntries(held) });
  return { chain: target.chainKey, pool: target.pool };
}

/* ---- bars15: a week of 15-minute bars per board pool ------------------- */

/** chain:pool -> when its 15m bars were last fetched (0 = file read, never fetched). */
const bars15At = new Map();

function bars15Rel(chainKey, pool) { return chainKey + "/bars15/" + pool + ".json"; }

/** Knows a pool's last fetch from its file on first sight, so a restart does not refetch the board. */
function bars15FetchedAt(chainKey, pool) {
  const key = chainKey + ":" + pool;
  if (!bars15At.has(key)) {
    const file = raw.read(bars15Rel(chainKey, pool));
    bars15At.set(key, (file && file.fetchedAt) || 0);
  }
  return bars15At.get(key);
}

let bars15ChainCursor = 0;
function nextBars15Target() {
  const now = Date.now();
  let stalest = null;
  for (let i = 0; i < COLLECT_CHAINS.length; i += 1) {
    const chainKey = COLLECT_CHAINS[(bars15ChainCursor + i) % COLLECT_CHAINS.length];
    const rows = (latestFeed.get(chainKey) || []).slice(0, ENRICH_ROWS).filter((r) => r.poolAddress);
    for (const row of rows) {
      const at = bars15FetchedAt(chainKey, row.poolAddress);
      if (!at) {
        bars15ChainCursor = (bars15ChainCursor + i + 1) % COLLECT_CHAINS.length;
        return { chainKey, pool: row.poolAddress, symbol: row.symbol };
      }
      const age = now - at;
      if (age >= BARS15_REFRESH_MS && (!stalest || age > stalest.age)) stalest = { chainKey, pool: row.poolAddress, symbol: row.symbol, age };
    }
  }
  bars15ChainCursor = (bars15ChainCursor + 1) % COLLECT_CHAINS.length;
  return stalest;
}

async function collectBars15() {
  const target = nextBars15Target();
  if (!target) return { idle: true };
  const { chainKey, pool } = target;
  let fresh;
  try {
    fresh = await P.fetchOhlcv(resolveChain(chainKey), pool, "minute", 15, BARS15_LIMIT, { priority: "low" });
  } catch (error) {
    // Held back by our own gate: nothing was asked, try again next tick.
    if (error.gated) return { yielding: true, gated: error.gated };
    // A real failure still counts as a visit, or one dead pool is retried forever.
    bars15At.set(chainKey + ":" + pool, Date.now());
    throw error;
  }
  // Merge, newest bar wins: GeckoTerminal rewrites the still-open bar, and
  // bars older than its 700-bar window exist only in our file.
  const rel = bars15Rel(chainKey, pool);
  const prior = raw.read(rel);
  const byT = new Map(((prior && prior.bars) || []).map((b) => [b.t, b]));
  fresh.forEach((b) => { if (Number.isFinite(b.t)) byT.set(b.t, b); });
  const cutoff = Date.now() - BARS15_KEEP_MS;
  const bars = [...byT.values()].filter((b) => b.t >= cutoff).sort((a, b) => a.t - b.t);
  const now = Date.now();
  raw.write(rel, {
    chain: chainKey, pool, symbol: target.symbol || (prior && prior.symbol) || null,
    timeframe: "minute", aggregate: 15, source: P.SOURCES.GECKOTERMINAL,
    fetchedAt: now, firstBarAt: bars.length ? bars[0].t : null, bars,
  });
  bars15At.set(chainKey + ":" + pool, now);
  return { chain: chainKey, pool, bars: bars.length, fetched: fresh.length };
}

/* ---- reference quotes, social, promotion ------------------------------- */

async function collectReference() {
  const symbols = new Set();
  COLLECT_CHAINS.forEach((chainKey) => {
    const chain = resolveChain(chainKey);
    if (chain.nativeSymbol) symbols.add(chain.nativeSymbol.toUpperCase());
    (latestFeed.get(chainKey) || []).forEach((r) => { if (r.quoteSymbol) symbols.add(String(r.quoteSymbol).toUpperCase()); });
  });
  const out = {};
  for (const symbol of symbols) {
    try {
      out[symbol] = (await P.fetchUsdReference(symbol)) || { quotes: [] };
    } catch (error) {
      out[symbol] = { quotes: [], error: error.message };
    }
  }
  raw.write("reference.json", { symbols: out });
  return { symbols: symbols.size };
}

let socialCorpusWrittenAt = 0;
async function collectSocial() {
  const social = await P.fetchSocialPosts().catch((error) => ({
    posts: [], sources: [], error: String(error.message || error).slice(0, 160),
  }));
  const corpusAt = P.socialCorpusAt();
  // The corpus is about a megabyte; rewrite it when it changed, and otherwise
  // only often enough that the per-source status stays current.
  if (corpusAt === socialCorpusWrittenAt && Date.now() - (lastWritten.get("social.json") || 0) < 300000) {
    return { unchanged: true };
  }
  socialCorpusWrittenAt = corpusAt;
  lastWritten.set("social.json", Date.now());
  raw.write("social.json", {
    corpusAt: corpusAt,
    postCount: social.posts.length,
    sources: social.sources,
    error: social.error || null,
    absent: "X/Twitter has no keyless read tier (api.twitter.com/2 answers 401 " +
      "to every unauthenticated request; the cheapest read plan is paid), and " +
      "Telegram exposes no public search. The x.com and t.me LINKS a token " +
      "advertises still arrive through the DexScreener promotion feed.",
    posts: social.posts,
  });
  return { posts: social.posts.length };
}

async function collectPromotion() {
  for (const chainKey of COLLECT_CHAINS) {
    const rows = await P.fetchPromotion(resolveChain(chainKey)).catch(() => []);
    raw.write(chainKey + "/promotion.json", {
      chain: chainKey, source: P.SOURCES.DEXSCREENER, rows: rows,
    });
  }
  return { chains: COLLECT_CHAINS.length };
}

/* ---- deep windows and coverage, read back out of the archive ----------- */

/**
 * 48h of observations for Precision@20. RAM holds only the hot window, so the
 * archive supplies the rest and RAM is folded on top (the archive lags by up
 * to one flush, so the newest points exist only in RAM).
 */
function observationsSince(chainKey, since) {
  const hot = memory.observationsFor(chainKey);
  const deep = store.seriesSince({ kind: "observation", chain: chainKey, since: since });
  const tokens = {};
  deep.series.forEach((rows, key) => {
    if (!key.startsWith(chainKey + ":")) return;
    tokens[key.slice(chainKey.length + 1)] = rows;
  });
  Object.keys(hot).forEach((token) => {
    const rows = hot[token];
    if (!Array.isArray(rows) || !rows.length) return;
    const into = tokens[token] || [];
    const stamps = new Set(into.map((r) => r.t));
    rows.forEach((r) => { if (r && r.t >= since && !stamps.has(r.t)) into.push(r); });
    into.sort((a, b) => a.t - b.t);
    tokens[token] = into;
  });
  return { tokens: tokens, tookMs: deep.tookMs };
}

async function collectDeep() {
  if (!store.enabled) return { skipped: "archive disabled" };
  const since = Date.now() - 48 * 3600000;
  for (const chainKey of DEEP_CHAINS) {
    const out = observationsSince(chainKey, since);
    raw.write(chainKey + "/observations-48h.json", {
      chain: chainKey, since: since, source: "memory+archive",
      series: Object.keys(out.tokens).length, tookMs: out.tookMs, tokens: out.tokens,
    });
  }
  return { chains: DEEP_CHAINS.length };
}

/**
 * How much of each window the archive actually observed. A fact about the
 * files, which only this process can see - what it MEANS for a score is
 * decided in the app.
 */
async function collectCoverage() {
  if (!store.enabled) return { skipped: "archive disabled" };
  const now = Date.now();
  const kind = "observation";
  const byChain = {};
  DEEP_CHAINS.forEach((chainKey) => {
    byChain[chainKey] = store.coverage({ kind, chain: chainKey, since: now - 86400000, until: now, bucketMs: 300000 });
  });
  raw.write("coverage.json", {
    now: now,
    kind: kind,
    day: store.timeline({ kind, chain: null, since: now - 86400000, until: now, buckets: 96, lostGapMs: 1800000 }),
    week: store.timeline({ kind, chain: null, since: now - 7 * 86400000, until: now, buckets: 56, lostGapMs: 1800000 }),
    byChain: byChain,
  });
  return { chains: DEEP_CHAINS.length };
}

/* ---- the process itself: counters, archive health, probe, scan --------- */

let lastProbe = null;
let lastScan = null;
let lastInspect = {};

async function collectProbe() {
  lastProbe = await store.probe().catch((error) => ({ ok: false, error: error.message }));
  // The collection listings the STORAGE tab shows, on the same slow clock.
  const next = {};
  for (const collection of ["poolHistory", "observations", "holders", "trades", "stages"]) {
    next[collection] = await store.inspect(collection, 25).catch((error) => ({ error: error.message }));
  }
  lastInspect = next;
  return { verified: Boolean(lastProbe && lastProbe.verified) };
}

async function collectScan() {
  if (!store.enabled) return { skipped: "archive disabled" };
  try { lastScan = store.scan(); } catch (error) { lastScan = { ok: false, error: error.message }; }
  return { records: lastScan && lastScan.records };
}

function systemBody() {
  const usage = process.memoryUsage();
  const cache = cacheStats();
  return {
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    now: Date.now(),
    upstream: upstreamTelemetry(),
    cache: Object.assign(cache, memory.memoryStats(), {
      persistent: store.enabled,
      lastFlushAt: store.stats.lastFlushAt,
      storeWrites: store.stats.writes,
    }),
    limits: {
      geckoterminalPerMinute: 10,
      dexscreenerPerMinute: 300,
      note: "Free-tier ceilings; measured call rates are in upstream.byHost.",
    },
    memory: {
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      heapUsedMb: Math.round(usage.heapUsed / 1048576),
      rssMb: Math.round(usage.rss / 1048576),
      cacheEntries: cache.entries,
      inflight: cache.inflight,
      historyPools: memory.historyStore.size,
      observationTokens: memory.observationStore.size,
      holderSeries: memory.holderHistory.size,
      walletSetsSampled: memory.tradeSamples.size,
      // Stages are derived, and deriving happens in the app.
      stagesTracked: 0,
    },
    // Constants, not measurements - quoted so the page describes this
    // process's configuration rather than a hard-coded guess about it.
    sampling: {
      marketIntervalMs: MARKET_INTERVAL_MS,
      warmIntervalMs: TRADES_INTERVAL_MS,
      minGapMs: memory.HISTORY_MIN_GAP_MS,
      maxAgeMs: memory.HISTORY_MAX_AGE_MS,
      historyGapMs: memory.HISTORY_MIN_GAP_MS,
      historyMaxSamples: memory.HISTORY_MAX_SAMPLES,
      historyMaxPools: memory.HISTORY_MAX_POOLS,
      historyMaxAgeMs: memory.HISTORY_MAX_AGE_MS,
      observationGapMs: memory.OBSERVATION_GAP_MS,
      observationMax: memory.OBSERVATION_MAX,
      tradeSampleMax: memory.TRADE_SAMPLE_MAX,
      rotationPools: ROTATION_POOLS,
      rotationRefreshMs: TRADES_INTERVAL_MS,
      tradesPerCycle: 1,
      tradesRefreshMs: TRADES_REFRESH_MS,
      intelIntervalMs: INTEL_INTERVAL_MS,
      intelRefreshMs: INTEL_REFRESH_MS,
      ohlcvIntervalMs: OHLCV_INTERVAL_MS,
      bars15IntervalMs: BARS15_INTERVAL_MS,
      bars15RefreshMs: BARS15_REFRESH_MS,
      ohlcvRefreshMs: OHLCV_REFRESH_MS,
    },
    // The market pass, per chain. Same shape the warm loop reported, so the
    // admin page's "missed its turn" check still applies.
    warm: {
      chains: COLLECT_CHAINS,
      intervalMs: MARKET_INTERVAL_MS,
      fullCycleMs: MARKET_INTERVAL_MS,
      state: Object.fromEntries(warmState),
    },
    collectors: Object.fromEntries(collectorState),
    // Each collector's interval, so a reader can tell "overdue" from "slow"
    // without hard-coding this process's configuration.
    schedule: {
      market: MARKET_INTERVAL_MS, trades: TRADES_INTERVAL_MS, intel: INTEL_INTERVAL_MS,
      ohlcv: OHLCV_INTERVAL_MS, bars15: BARS15_INTERVAL_MS, reference: REFERENCE_INTERVAL_MS, social: SOCIAL_INTERVAL_MS,
      promotion: PROMOTION_INTERVAL_MS, system: SYSTEM_INTERVAL_MS, coverage: COVERAGE_INTERVAL_MS,
      deep: DEEP_INTERVAL_MS, probe: PROBE_INTERVAL_MS, scan: SCAN_INTERVAL_MS,
    },
    store: Object.assign({ enabled: store.enabled }, store.stats, {
      persistent: store.enabled,
      backend: store.enabled ? store.backend : "memory-only",
      flushIntervalMs: store.flushIntervalMs,
      observationFlushIntervalMs: store.observationFlushIntervalMs,
      pending: store.pending(),
      usage: store.enabled ? store.usage() : null,
      health: store.health(),
    }),
    raw: Object.assign({ dir: raw.dir, error: raw.error }, raw.stats, { failing: raw.failing }),
    // Taken on their own slow clocks; `at` inside each says when.
    probe: lastProbe,
    scan: lastScan,
    inspect: lastInspect,
  };
}

async function collectSystem() {
  raw.write("system.json", systemBody());
  return null;
}

/* ---- boot restore ------------------------------------------------------ */

/**
 * The raw store doubles as this process's memory for what the archive snapshot
 * does not hold: trade samples, intel and bars. Reading them back means a
 * restart resumes the rotations instead of re-fetching every board token.
 */
function restoreFromRawStore() {
  raw.loadManifest();
  let trades = 0; let intel = 0; let bars = 0;
  COLLECT_CHAINS.forEach((chainKey) => {
    const market = raw.read(chainKey + "/market.json");
    if (market && Array.isArray(market.rows)) latestFeed.set(chainKey, market.rows);

    const t = raw.read(chainKey + "/trades.json");
    ((t && t.pools) || []).forEach((p) => {
      if (!p || !p.poolAddress || !Array.isArray(p.trades)) return;
      memory.tradeSamples.set(chainKey + ":" + p.poolAddress, {
        at: p.at || 0, symbol: p.symbol || null, trades: p.trades,
      });
      store.seedTradeMark(chainKey, p.poolAddress, p.trades);
      trades += 1;
    });

    const i = raw.read(chainKey + "/intel.json");
    Object.entries((i && i.tokens) || {}).forEach(([token, payload]) => {
      if (payload) { intelMap(chainKey).set(token, payload); intel += 1; }
    });

    const o = raw.read(chainKey + "/ohlcv.json");
    Object.entries((o && o.pools) || {}).forEach(([pool, entry]) => {
      if (entry) { ohlcvMap(chainKey).set(pool, entry); bars += 1; }
    });
  });
  return { trades, intel, bars };
}

/* ------------------------------------------------------------------ HTTP */

/**
 * The only things served:
 *   /raw/<file>.json  bytes off disk, see lib/raw-store.js
 *   /health           for the supervisor (supervise.ps1), not for the app
 *   /                 what this is
 *
 * There are no /api routes. Nothing the app sends can make this process fetch,
 * sample or compute anything.
 */
function sendJson(response, status, body) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

function healthData() {
  return {
    status: "ok",
    service: "vibescreener-server",
    role: "collector - writes raw provider data to the raw store; serves nothing but those files",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    chains: COLLECT_CHAINS,
    memory: memory.memoryStats(),
    raw: { dir: raw.dir, writes: raw.stats.writes, errors: raw.stats.errors, lastWriteAt: raw.stats.lastWriteAt },
    store: {
      persistent: store.enabled,
      backend: store.enabled ? store.backend : "memory-only",
      dir: store.enabled ? store.dir : null,
      writes: store.stats.writes,
      errors: store.stats.errors,
      lastFlushAt: store.stats.lastFlushAt,
    },
  };
}

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://" + (request.headers.host || HOST));
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    // So the app can tell an unchanged file from a new one without parsing it.
    response.setHeader("Access-Control-Expose-Headers", "ETag");

    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Read-only. The raw store is written by the collectors, never by a request." });
      return;
    }

    // Sharing layer first: it only re-serves what follows (compressed,
    // redacted) or serves the app, and declines everything else.
    if (share.handle(request, response, url, { rawStore: raw, healthData: healthData })) return;

    if (url.pathname.startsWith("/raw/")) {
      raw.serve(decodeURIComponent(url.pathname.slice("/raw/".length)), request, response);
      return;
    }
    if (url.pathname === "/health") { sendJson(response, 200, healthData()); return; }
    if (url.pathname === "/") {
      sendJson(response, 200, {
        service: "vibescreener data server",
        note: "Collector only. Raw provider data is written to the raw store; the app reads those files.",
        manifest: "/raw/manifest.json",
      });
      return;
    }
    sendJson(response, 404, {
      error: "Not found",
      note: "There are no API routes. Read /raw/manifest.json for what the raw store holds.",
    });
  });
}

/* ------------------------------------------------------------------ boot */

function start() {
  raw.ensure();
  const restored = restoreFromRawStore();
  console.log("raw: restored " + restored.trades + " trade samples, " + restored.intel +
    " intel payloads, " + restored.bars + " bar sets from " + raw.dir);

  store.load({
    historyStore: memory.historyStore,
    holderHistory: memory.holderHistory,
    observationStore: memory.observationStore,
  }).then((result) => {
    if (result.enabled) {
      console.log("store: restored " + result.pools + " pool series, " +
        result.holders + " holder series, " + result.observations + " observation series");
    }
  }).catch((error) => console.error("store: load failed -", error.message));

  // Roll days older than the raw-retention window up to 1-minute resolution.
  try { store.compact(); } catch (error) { console.error("archive: compaction failed -", error.message); }
  const compactTimer = setInterval(() => {
    try { store.compact(); } catch (error) { console.error("archive: compaction failed -", error.message); }
  }, 86400000);
  compactTimer.unref();

  store.startAutoFlush({
    historyStore: memory.historyStore,
    holderHistory: memory.holderHistory,
    observationStore: memory.observationStore,
  });

  every("market", MARKET_INTERVAL_MS, collectMarket);
  every("trades", TRADES_INTERVAL_MS, collectTrades);
  every("intel", INTEL_INTERVAL_MS, collectIntel);
  every("ohlcv", OHLCV_INTERVAL_MS, collectOhlcv);
  every("bars15", BARS15_INTERVAL_MS, collectBars15);
  every("reference", REFERENCE_INTERVAL_MS, collectReference);
  every("social", SOCIAL_INTERVAL_MS, collectSocial);
  every("promotion", PROMOTION_INTERVAL_MS, collectPromotion);
  every("system", SYSTEM_INTERVAL_MS, collectSystem);
  every("coverage", COVERAGE_INTERVAL_MS, collectCoverage);
  every("deep", DEEP_INTERVAL_MS, collectDeep);
  every("probe", PROBE_INTERVAL_MS, collectProbe);
  every("scan", SCAN_INTERVAL_MS, collectScan);

  createServer().listen(PORT, HOST, () => {
    const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log("VibeScreener collector on http://" + shown + ":" + PORT +
      " - collecting " + COLLECT_CHAINS.join(","));
    console.log("Raw store: http://" + shown + ":" + PORT + "/raw/manifest.json");
    console.log("Health:    http://" + shown + ":" + PORT + "/health");
  });
}

const shutdown = (signal) => {
  console.log("\n" + signal + " received, flushing...");
  store.flushAll({
    historyStore: memory.historyStore,
    holderHistory: memory.holderHistory,
    observationStore: memory.observationStore,
  }, signal).finally(() => {
    // flushAll fsyncs before resolving, so everything is already on disk;
    // this just closes the append stream cleanly.
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = { PORT, HOST, CHAINS, FEEDS, createServer, buildFeed, buildIntel };

if (require.main === module) start();
