"use strict";

/**
 * VibeScreener data server.
 *
 * This process fetches from public APIs, remembers raw numbers in RAM, and
 * forwards them. It does not score, rank, stage, flag or judge anything -
 * every derived number the dashboard shows is computed in the app, in
 * Vibe-MM-React/src/calculations. If you are looking for where a score comes
 * from, it is not in this repo.
 *
 * What the server still owns, and why:
 *   - rate limiting and caching, because a browser tab cannot be trusted with
 *     GeckoTerminal's ~30 calls/min budget
 *   - rolling sample series, because the app is not open around the clock and
 *     a baseline needs hours of observation
 *   - CORS and one origin for a dozen providers, several of which would
 *     refuse a browser request outright
 *
 * Providers, all keyless: GeckoTerminal, DexScreener, Jupiter, KyberSwap,
 * GoPlus, RugCheck, honeypot.is, DefiLlama, Binance, Coinbase, CoinGecko,
 * and the 4chan /biz/ catalog.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { CHAINS, FEEDS, resolveChain } = require("./lib/chains");
const { fetchJson, cached, cacheStats, toNumber, upstreamTelemetry } = require("./lib/fetcher");
const P = require("./lib/providers");
const memory = require("./lib/memory");
const store = require("./store");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_ROWS = Number(process.env.MAX_ROWS || 30);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 500);
const OHLCV_CACHE_TTL_MS = Number(process.env.OHLCV_CACHE_TTL_MS || 150000);
const INTEL_CACHE_TTL_MS = Number(process.env.INTEL_CACHE_TTL_MS || 2700000);

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

/* ------------------------------------------------------------------ HTTP */

function sendJson(response, status, body) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

function requireChain(url, response) {
  const chain = resolveChain(url.searchParams.get("chain"));
  if (!chain) {
    sendJson(response, 400, {
      server: "error",
      error: 'Unsupported chain "' + url.searchParams.get("chain") + '"',
      supported: Object.keys(CHAINS),
    });
    return null;
  }
  return chain;
}

async function handleMarket(url, response) {
  const chain = requireChain(url, response);
  if (!chain) return;
  const tokenAddress = (url.searchParams.get("tokenAddress") || "").trim() || null;
  const requested = (url.searchParams.get("feed") || "trending").toLowerCase();
  const feed = FEEDS[requested] ? requested : "trending";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || MAX_ROWS, 1), 50);
  const key = "market:" + chain.key + ":" + (tokenAddress || feed) + ":" + limit;
  try {
    const data = await cached(key, CACHE_TTL_MS,
      () => buildFeed({ chain: chain, feed: feed, limit: limit, tokenAddress: tokenAddress }));
    sendJson(response, 200, data);
  } catch (error) {
    sendJson(response, 502, {
      server: "error", chain: chain.key, rows: [],
      errors: [{ source: "upstream", message: error.message }],
    });
  }
}

/** The rolling raw samples the app turns into baselines and z-scores. */
function handleHistory(url, response) {
  const chain = requireChain(url, response);
  if (!chain) return;
  const pool = (url.searchParams.get("pool") || "").trim();
  sendJson(response, 200, {
    server: "ok",
    chain: chain.key,
    minGapMs: memory.HISTORY_MIN_GAP_MS,
    maxAgeMs: memory.HISTORY_MAX_AGE_MS,
    maxSamples: memory.HISTORY_MAX_SAMPLES,
    pool: pool || null,
    samples: memory.samplesFor(chain.key, pool || null),
  });
}

/** Raw price/liquidity snapshots. The app joins its score journal to these. */
function handleObservations(url, response) {
  const chain = requireChain(url, response);
  if (!chain) return;
  sendJson(response, 200, {
    server: "ok", chain: chain.key, tokens: memory.observationsFor(chain.key),
  });
}

/**
 * Wallet-level trades. One pool on request, or every pool the rotation has
 * sampled so far - which is what rotation and the wallet registry are built
 * from, in the app.
 */
async function handleTrades(url, response) {
  const chain = requireChain(url, response);
  if (!chain) return;
  const pool = (url.searchParams.get("pool") || "").trim();

  // A refresh that fails is not the same as having nothing. GeckoTerminal
  // rate-limits this endpoint hard - Render's free tier shares outbound IPs,
  // so a 429 says more about the neighbours than about the pool - and the
  // warm loop has usually sampled it already. Throwing that away turned a
  // slow upstream into an empty screen, so a failed refresh now degrades to
  // the last good sample and says so in `stale`.
  let refreshError = null;
  if (pool) {
    try {
      const trades = await P.fetchPoolTrades(chain, pool);
      memory.recordTrades(chain.key, pool, url.searchParams.get("symbol"), trades);
    } catch (error) {
      refreshError = error.message;
    }
  }

  const pools = memory.tradesFor(chain.key, pool || null);
  if (refreshError && !pools.length) {
    sendJson(response, 502, { server: "error", error: refreshError, pools: [] });
    return;
  }
  sendJson(response, 200, {
    server: "ok", chain: chain.key, pools: pools,
    stale: Boolean(refreshError), refreshError: refreshError,
  });
}

async function handleIntel(url, response) {
  const chain = requireChain(url, response);
  if (!chain) return;
  let token = (url.searchParams.get("token") || "").trim();
  if (!token) {
    sendJson(response, 400, { server: "error", error: "token is required" });
    return;
  }
  try {
    if (chain.key === "solana" && token === token.toLowerCase()) {
      const resolved = await P.resolveTokenAddress(chain, token);
      if (resolved) token = resolved;
    }
    const data = await cached("intel:" + chain.key + ":" + token, INTEL_CACHE_TTL_MS,
      () => buildIntel(chain, token));
    sendJson(response, 200, data);
  } catch (error) {
    sendJson(response, 502, { server: "error", error: error.message });
  }
}

/**
 * Chart bars. When GeckoTerminal rate-limits - Render's free tier shares
 * outbound IPs, so its per-IP budget is often spent by other tenants - the
 * server falls back to the 15s price samples it took itself.
 */
async function handleOhlcv(url, response) {
  const chain = requireChain(url, response);
  if (!chain) return;
  const pool = (url.searchParams.get("pool") || "").trim();
  if (!pool) {
    sendJson(response, 400, { server: "error", error: "pool is required", bars: [] });
    return;
  }
  const requested = url.searchParams.get("timeframe");
  const timeframe = P.OHLCV_TIMEFRAMES[requested] ? requested : "minute";
  const aggregate = Math.min(Math.max(Number(url.searchParams.get("aggregate")) || 1, 1), 60);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 60, 1), 300);
  const key = "ohlcv:" + chain.gt + ":" + pool + ":" + timeframe + ":" + aggregate + ":" + limit;

  try {
    const bars = await cached(key, OHLCV_CACHE_TTL_MS,
      () => P.fetchOhlcv(chain, pool, timeframe, aggregate, limit));
    sendJson(response, 200, {
      server: "ok", chain: chain.key, pool: pool, timeframe: timeframe, aggregate: aggregate,
      source: P.SOURCES.GECKOTERMINAL, bars: bars, reason: bars.length ? null : "empty",
    });
  } catch (error) {
    const limited = error.status === 429 || /429/.test(error.message || "");
    const local = memory.samplesFor(chain.key, pool)
      .filter((s) => Number.isFinite(s.priceUsd))
      .slice(-limit)
      .map((s) => ({ t: s.t, o: s.priceUsd, h: s.priceUsd, l: s.priceUsd, c: s.priceUsd, v: s.volume5mUsd }));
    if (local.length > 1) {
      sendJson(response, 200, {
        server: "ok", chain: chain.key, pool: pool, timeframe: "sampled-15s", aggregate: 1,
        source: "vibescreener-history", bars: local, reason: "local_history",
        note: "GeckoTerminal unavailable (" + (limited ? "rate limited" : error.message) +
          "); drawn from this server's own 15s price samples",
      });
      return;
    }
    sendJson(response, limited ? 200 : 502, {
      server: limited ? "ok" : "error", bars: [],
      reason: limited ? "rate_limited" : "upstream_error",
      retryAfterMs: limited ? 20000 : null, error: error.message,
    });
  }
}

/** Board threads and paid promotion, unmatched. The app does the matching. */
/**
 * Every public social feed we can read without an API key, plus the paid
 * promotion feed, forwarded raw.
 *
 * Matching posts to tickers, counting mentions and unique authors, and
 * comparing against a baseline all happen in the app. This endpoint only says
 * what was posted, where, by whom and when - and which sources answered.
 */
/**
 * Every public social feed we can read without an API key, plus the paid
 * promotion feed, forwarded raw.
 *
 * The corpus is about a megabyte and changes every few minutes, while the app
 * re-reads it every few seconds. `?since=<ms>` closes that gap: when nothing
 * has been fetched since the caller's copy, the posts are left out and only
 * the counters come back. The caller keeps what it already holds.
 *
 * Matching posts to tickers, counting mentions and unique authors, and
 * comparing against a baseline all happen in the app. This endpoint only says
 * what was posted, where, by whom and when - and which sources answered.
 */
async function handleSocial(url, response) {
  const chain = requireChain(url, response);
  if (!chain) return;

  const [social, promotion] = await Promise.all([
    P.fetchSocialPosts().catch((error) => ({
      posts: [], sources: [], error: String(error.message || error).slice(0, 160),
    })),
    P.fetchPromotion(chain).catch(() => []),
  ]);

  const corpusAt = P.socialCorpusAt();
  const since = Number(url.searchParams.get("since") || 0);
  // Strictly greater: a caller holding the current corpus gets nothing back.
  const unchanged = Number.isFinite(since) && since > 0 && corpusAt <= since;

  const body = {
    server: "ok", chain: chain.key,
    corpusAt: corpusAt,
    unchanged: unchanged,
    postCount: social.posts.length,
    sources: social.sources,
    promotion: { source: P.SOURCES.DEXSCREENER, rows: promotion },
    absent: "X/Twitter has no keyless read tier (api.twitter.com/2 answers 401 " +
      "to every unauthenticated request; the cheapest read plan is paid), and " +
      "Telegram exposes no public search. The x.com and t.me LINKS a token " +
      "advertises still arrive through the DexScreener promotion feed.",
  };
  if (!unchanged) body.posts = social.posts;

  sendJson(response, 200, body);
}

async function handleReference(url, response) {
  const symbol = (url.searchParams.get("symbol") || "").trim();
  if (!symbol) {
    sendJson(response, 400, { server: "error", error: "symbol is required" });
    return;
  }
  try {
    const data = await P.fetchUsdReference(symbol);
    sendJson(response, 200, Object.assign({ server: "ok", symbol: symbol }, data || { quotes: [] }));
  } catch (error) {
    sendJson(response, 502, { server: "error", error: error.message, quotes: [] });
  }
}

/** Raw counters and latency samples. Percentiles are computed in the app. */
function handleSystem(url, response) {
  sendJson(response, 200, {
    server: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    now: Date.now(),
    upstream: upstreamTelemetry(),
    cache: Object.assign(cacheStats(), memory.memoryStats(), {
      persistent: store.enabled,
      lastFlushAt: store.stats.lastFlushAt,
      storeWrites: store.stats.writes,
    }),
    sampling: {
      warmIntervalMs: WARM_INTERVAL_MS,
      minGapMs: memory.HISTORY_MIN_GAP_MS,
      maxAgeMs: memory.HISTORY_MAX_AGE_MS,
    },
    limits: {
      geckoterminalPerMinute: 30,
      dexscreenerPerMinute: 300,
      note: "Free-tier ceilings; measured call rates are in upstream.byHost.",
    },
  });
}

function healthData() {
  return {
    status: "ok",
    service: "vibescreener-server",
    role: "raw data only - all calculation happens in the app",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    chains: Object.keys(CHAINS),
    feeds: Object.keys(FEEDS),
    memory: memory.memoryStats(),
    store: {
      persistent: store.enabled,
      backend: store.enabled ? "firestore" : "memory-only",
      writes: store.stats.writes,
      errors: store.stats.errors,
      lastFlushAt: store.stats.lastFlushAt,
    },
  };
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

async function handleAdminStore(url, response) {
  if (ADMIN_TOKEN && url.searchParams.get("token") !== ADMIN_TOKEN) {
    sendJson(response, 401, { server: "error", error: "admin token required" });
    return;
  }
  const collection = (url.searchParams.get("collection") || "poolHistory").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 25, 1), 100);
  let probe = null;
  if (url.searchParams.get("probe") === "1") {
    probe = await store.probe().catch((error) => ({ ok: false, error: error.message }));
  }
  const docs = await store.inspect(collection, limit).catch((error) => ({ error: error.message }));
  sendJson(response, 200, {
    server: "ok",
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    },
    store: { enabled: store.enabled, stats: store.stats, pending: store.pending() },
    memory: memory.memoryStats(),
    probe: probe,
    collection: collection,
    docs: docs,
  });
}

/* ------------------------------------------------------- static dashboard */

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".webp": "image/webp",
};

function serveStatic(url, response) {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!rel || rel.indexOf("..") !== -1) return false;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) ||
      !fs.statSync(filePath).isFile()) return false;
  response.setHeader("Content-Type", MIME[path.extname(filePath)] || "application/octet-stream");
  response.setHeader("Cache-Control", rel.startsWith("assets/")
    ? "public, max-age=31536000, immutable" : "no-cache");
  response.writeHead(200);
  fs.createReadStream(filePath).pipe(response);
  return true;
}

function sendDashboard(response) {
  const index = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(index)) {
    response.setHeader("Content-Type", MIME[".html"]);
    response.writeHead(200);
    fs.createReadStream(index).pipe(response);
    return;
  }
  sendJson(response, 200, {
    server: "ok",
    service: "vibescreener data server",
    note: "Raw data only. Every calculation lives in the app.",
    routes: [
      "/health",
      "/api/market?chain=solana&feed=trending&limit=30",
      "/api/history?chain=solana[&pool=<poolAddress>]",
      "/api/observations?chain=solana",
      "/api/trades?chain=solana[&pool=<poolAddress>]",
      "/api/intel?chain=solana&token=<tokenAddress>",
      "/api/ohlcv?chain=solana&pool=<poolAddress>&timeframe=minute",
      "/api/social?chain=solana",
      "/api/reference?symbol=SOL",
      "/api/system",
    ],
  });
}

/* ---------------------------------------------------------------- routing */

const ROUTES = {
  "/api/market": handleMarket,
  "/api/history": handleHistory,
  "/api/observations": handleObservations,
  "/api/trades": handleTrades,
  "/api/intel": handleIntel,
  "/api/ohlcv": handleOhlcv,
  "/api/social": handleSocial,
  "/api/reference": handleReference,
  "/api/system": handleSystem,
  "/api/admin/store": handleAdminStore,
};

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://" + (request.headers.host || HOST));
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/health") { sendJson(response, 200, healthData()); return; }

    const route = ROUTES[url.pathname];
    if (route) {
      console.log(new Date().toISOString() + " " + request.method + " " + url.pathname + url.search);
      Promise.resolve(route(url, response)).catch((error) => {
        sendJson(response, 500, { server: "error", error: error.message });
      });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/dashboard") { sendDashboard(response); return; }
    if (serveStatic(url, response)) return;
    if (!url.pathname.startsWith("/api/")) { sendDashboard(response); return; }

    sendJson(response, 404, { error: "Not found", routes: Object.keys(ROUTES) });
  });
}

/* ------------------------------------------------------------- warm loop */

/**
 * Sampling has to keep running whether or not anyone has the dashboard open,
 * or there is no baseline to read when they do open it.
 */
const WARM_INTERVAL_MS = Number(process.env.WARM_INTERVAL_MS || 20000);
const WARM_CHAINS = (process.env.WARM_CHAINS || "solana,ethereum,base,bsc")
  .split(",").map((s) => s.trim()).filter(Boolean);
/**
 * How far down the feed the sampler is willing to go.
 *
 * This was 12 while the board shows up to MAX_ROWS rows, so rows past the
 * twelfth were never sampled at all and the app had no wallet read on them -
 * a permanent hole at the bottom of every board rather than a lag. Matching
 * MAX_ROWS makes every row the user can see eligible.
 */
const ROTATION_POOLS = Number(process.env.ROTATION_POOLS || MAX_ROWS);
/**
 * Pools sampled per cycle. The app's wallet memory only ever learns about
 * pools this loop has reached, so coverage here is the ceiling on coverage
 * there. GeckoTerminal is the binding constraint: the feed call plus this many
 * trade calls has to stay inside its per-minute budget, and a 429 costs the
 * rest of the cycle, so raise it carefully.
 */
const TRADES_PER_CYCLE = Number(process.env.TRADES_PER_CYCLE || 2);

let warmCursor = 0;
/**
 * One cursor PER CHAIN.
 *
 * A single shared cursor was advanced by whichever chain happened to run, so
 * each chain resumed wherever another had left off - pools were skipped for
 * long stretches and others were resampled early. Per-chain cursors make the
 * rotation an actual round robin, which is what bounded coverage depends on.
 */
const rotationCursors = new Map();

async function warmOneChain() {
  const chainKey = WARM_CHAINS[warmCursor % WARM_CHAINS.length];
  warmCursor += 1;
  const chain = resolveChain(chainKey);
  if (!chain) return;
  try {
    const data = await buildFeed({ chain: chain, feed: "trending", limit: MAX_ROWS, tokenAddress: null });
    const pools = (data.rows || []).slice(0, ROTATION_POOLS).filter((r) => r.poolAddress);
    if (pools.length) {
      // A pool we have NEVER sampled is worth more than refreshing one we
      // already hold: until it is sampled once, the app has no wallet read on
      // that token at all and its score is missing an input entirely. A
      // refresh only makes an existing read newer. So new pools jump the
      // queue, and the round robin handles everything else.
      const held = new Set(memory.tradesFor(chain.key, null).map((p) => p.poolAddress));
      const unseen = pools.filter((r) => !held.has(r.poolAddress));

      let cursor = rotationCursors.get(chain.key) || 0;
      const budget = Math.min(TRADES_PER_CYCLE, pools.length);
      const targets = [];
      unseen.slice(0, budget).forEach((r) => targets.push(r));
      // The cursor is cumulative across cycles, so the lap guard has to count
      // steps taken HERE - comparing the cursor itself to the pool count would
      // stop the round robin dead after the first few cycles.
      let steps = 0;
      while (targets.length < budget && steps < pools.length) {
        const target = pools[cursor % pools.length];
        cursor += 1;
        steps += 1;
        if (!targets.some((t) => t.poolAddress === target.poolAddress)) targets.push(target);
      }

      for (const target of targets) {
        try {
          const trades = await P.fetchPoolTrades(chain, target.poolAddress);
          memory.recordTrades(chain.key, target.poolAddress, target.symbol, trades);
        } catch (error) {
          // A rate limit means the rest of this cycle would be refused too, so
          // stop asking and let the next cycle resume from here.
          if (String(error.message || "").includes("429")) break;
        }
      }
      rotationCursors.set(chain.key, cursor);
    }
  } catch (error) {
    console.log("warm " + chainKey + " failed: " + error.message);
  }
  memory.pruneHistory();
}

function start() {
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

  store.startAutoFlush({
    historyStore: memory.historyStore,
    holderHistory: memory.holderHistory,
    observationStore: memory.observationStore,
  });

  setInterval(warmOneChain, WARM_INTERVAL_MS).unref?.();
  warmOneChain();

  createServer().listen(PORT, HOST, () => {
    const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log("VibeScreener data server (raw only) on http://" + shown + ":" + PORT);
    console.log("Market:  http://" + shown + ":" + PORT + "/api/market?chain=solana&feed=trending");
    console.log("Health:  http://" + shown + ":" + PORT + "/health");
  });
}

const shutdown = (signal) => {
  console.log("\n" + signal + " received, flushing...");
  store.flushAll({
    historyStore: memory.historyStore,
    holderHistory: memory.holderHistory,
    observationStore: memory.observationStore,
  }, signal).finally(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = { PORT, HOST, CHAINS, FEEDS, createServer, buildFeed, buildIntel };

if (require.main === module) start();
