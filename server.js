"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const store = require("./store");

/**
 * VibeScreener market data server.
 *
 * The live feed is built from two free, keyless, public APIs:
 *   - GeckoTerminal  https://api.geckoterminal.com/api/v2   (public beta, no key, ~30 req/min)
 *   - DexScreener    https://api.dexscreener.com            (public, no key, ~300 req/min)
 *
 * The Birdeye and GoPlus normalizers stay in place but remain dormant unless
 * BIRDEYE_API_KEY / GOPLUS_API_KEY are present, because both require a key.
 */

const SOURCES = Object.freeze({
  BIRDEYE: "birdeye",
  DEXSCREENER: "dexscreener",
  GECKOTERMINAL: "geckoterminal",
  GOPLUS: "goplus",
  JUPITER: "jupiter",
  RUGCHECK: "rugcheck",
  KYBERSWAP: "kyberswap",
  HONEYPOT: "honeypot.is",
  DEFILLAMA: "defillama",
});

// Cloud hosts (Render, Railway, Fly, Heroku) inject PORT and expect the process
// to bind 0.0.0.0. Both stay overridable for local runs.
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const DS_BASE = "https://api.dexscreener.com";
const USER_AGENT = "vibescreener-server/1.0 (+local)";

const CHAINS = Object.freeze({
  solana: { gt: "solana", ds: "solana", label: "Solana", nativeSymbol: "SOL" },
  ethereum: { gt: "eth", ds: "ethereum", label: "Ethereum", nativeSymbol: "ETH" },
  base: { gt: "base", ds: "base", label: "Base", nativeSymbol: "ETH" },
  bsc: { gt: "bsc", ds: "bsc", label: "BNB Chain", nativeSymbol: "BNB" },
  arbitrum: { gt: "arbitrum", ds: "arbitrum", label: "Arbitrum", nativeSymbol: "ETH" },
  polygon: { gt: "polygon_pos", ds: "polygon", label: "Polygon", nativeSymbol: "POL" },
  avalanche: { gt: "avax", ds: "avalanche", label: "Avalanche", nativeSymbol: "AVAX" },
  sui: { gt: "sui-network", ds: "sui", label: "Sui", nativeSymbol: "SUI" },
  hyperevm: { gt: "hyperevm", ds: "hyperevm", label: "HyperEVM", nativeSymbol: "HYPE" },
  robinhood: { gt: "robinhood", ds: "robinhood", label: "Robinhood Chain", nativeSymbol: "ETH" },
  ton: { gt: "ton", ds: "ton", label: "TON", nativeSymbol: "TON" },
  monad: { gt: "monad", ds: "monad", label: "Monad", nativeSymbol: "MON" },
  abstract: { gt: "abstract", ds: "abstract", label: "Abstract", nativeSymbol: "ETH" },
  berachain: { gt: "berachain", ds: "berachain", label: "Berachain", nativeSymbol: "BERA" },
  unichain: { gt: "unichain", ds: "unichain", label: "Unichain", nativeSymbol: "ETH" },
  sonic: { gt: "sonic", ds: "sonic", label: "Sonic", nativeSymbol: "S" },
  plasma: { gt: "plasma", ds: "plasma", label: "Plasma", nativeSymbol: "XPL" },
});

const CHAIN_ALIASES = Object.freeze({
  sol: "solana",
  eth: "ethereum",
  mainnet: "ethereum",
  bnb: "bsc",
  "binance-smart-chain": "bsc",
  matic: "polygon",
  polygon_pos: "polygon",
  arb: "arbitrum",
  avax: "avalanche",
  hyperliquid: "hyperevm",
  hype: "hyperevm",
  rhc: "robinhood",
  bera: "berachain",
  uni: "unichain",
  xpl: "plasma",
});

const FEEDS = Object.freeze({
  trending: (network) =>
    GT_BASE + "/networks/" + network + "/trending_pools?include=base_token,quote_token,dex&page=1",
  new: (network) =>
    GT_BASE + "/networks/" + network + "/new_pools?include=base_token,quote_token,dex&page=1",
  top: (network) =>
    GT_BASE + "/networks/" + network + "/pools?include=base_token,quote_token,dex&sort=h24_volume_usd_desc&page=1",
});

const GT_CACHE_TTL_MS = Number(process.env.GT_CACHE_TTL_MS || 60000);
const DS_CACHE_TTL_MS = Number(process.env.DS_CACHE_TTL_MS || 1000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 500);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 9000);
const MAX_ROWS = Number(process.env.MAX_ROWS || 30);

function resolveChain(input) {
  const key = String(input || "solana").trim().toLowerCase();
  const canonical = CHAIN_ALIASES[key] || key;
  const chain = CHAINS[canonical];
  return chain ? Object.assign({ key: canonical }, chain) : null;
}

function emptyMarketData(tokenAddress, chain) {
  return {
    tokenAddress: tokenAddress || null,
    chain: chain || null,
    priceUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    sourceBreakdown: [],
    server: "ok",
  };
}

function healthData() {
  return {
    status: "ok",
    service: "vibescreener-server",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    node: process.version,
    providers: {
      geckoterminalConfigured: true,
      dexscreenerConfigured: true,
      jupiterConfigured: true,
      rugcheckConfigured: true,
      kyberswapConfigured: true,
      honeypotConfigured: true,
      defillamaConfigured: true,
      birdeyeConfigured: Boolean(process.env.BIRDEYE_API_KEY),
      goplusConfigured: Boolean(process.env.GOPLUS_API_KEY),
    },
    chains: Object.keys(CHAINS),
    feeds: Object.keys(FEEDS),
    cacheTtlMs: CACHE_TTL_MS,
    store: {
      persistent: store.enabled,
      backend: store.enabled ? "firestore" : "memory-only",
      flushIntervalMs: store.flushIntervalMs,
      writes: store.stats.writes,
      reads: store.stats.reads,
      errors: store.stats.errors,
      lastFlushAt: store.stats.lastFlushAt,
      lastError: store.stats.lastError,
    },
    upstream: {
      total: upstreamCalls.total,
      byHost: upstreamCalls.byHost,
      windowSeconds: Math.round((Date.now() - upstreamCalls.since) / 1000),
      perMinute: Object.keys(upstreamCalls.byHost).reduce((acc, host) => {
        const minutes = Math.max((Date.now() - upstreamCalls.since) / 60000, 1 / 60);
        acc[host] = Math.round((upstreamCalls.byHost[host] / minutes) * 10) / 10;
        return acc;
      }, {}),
    },
  };
}

const upstreamCalls = { total: 0, byHost: {}, since: Date.now() };
const upstreamLatency = {};
function recordUpstream(url, ms, error) {
  let host = "unknown";
  try { host = new URL(url).host; } catch (e) {}
  const l = upstreamLatency[host] || (upstreamLatency[host] = { calls: 0, errors: 0, samples: [], lastError: null });
  l.calls += 1;
  if (error) { l.errors += 1; l.lastError = String(error.message || error).slice(0, 120); }
  else { l.samples.push(ms); if (l.samples.length > 60) l.samples.shift(); }
}

function countUpstream(url) {
  let host = "unknown";
  try { host = new URL(url).host; } catch (e) {}
  upstreamCalls.total += 1;
  upstreamCalls.byHost[host] = (upstreamCalls.byHost[host] || 0) + 1;
}

async function fetchJson(url, options) {
  const timeoutMs = (options && options.timeoutMs) || FETCH_TIMEOUT_MS;
  countUpstream(url);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: Object.assign(
        { accept: "application/json", "user-agent": USER_AGENT },
        (options && options.headers) || {},
      ),
    });
    if (!response.ok) {
      const error = new Error("HTTP " + response.status + " from " + new URL(url).host);
      error.status = response.status;
      throw error;
    }
    const parsed = await response.json();
    recordUpstream(url, Date.now() - startedAt, null);
    return parsed;
  } catch (error) {
    recordUpstream(url, Date.now() - startedAt, error);
    if (error.name === "AbortError") {
      throw new Error("timeout after " + timeoutMs + "ms from " + new URL(url).host);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const cacheStore = new Map();
const inflight = new Map();

async function cached(key, ttlMs, producer) {
  const hit = cacheStore.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const value = await producer();
      cacheStore.set(key, { value: value, expiresAt: Date.now() + ttlMs });
      return value;
    } catch (error) {
      if (hit) return hit.value;
      throw error;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toTimestampMs(value) {
  if (typeof value === "string" && Number.isNaN(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const number = toNumber(value);
  if (number === null) return null;
  return number < 1e12 ? number * 1000 : number;
}

function normalizeTimestampSource(raw) {
  return toTimestampMs(firstDefined(
    raw && raw.timestamp,
    raw && raw.timestampFetched,
    raw && raw.data && raw.data.timestamp,
    raw && raw.data && raw.data.updateUnixTime,
    raw && raw.data && raw.data.updateTime,
    raw && raw.updatedAt,
    raw && raw.lastUpdated,
  ));
}

function createNormalizedResult({
  tokenAddress,
  chain,
  source,
  timestampFetched,
  timestampSource,
  priceUsd = null,
  liquidityUsd = null,
  volume24hUsd = null,
  poolAddress = null,
  raw,
}) {
  return {
    tokenAddress: String(tokenAddress == null ? "" : tokenAddress),
    chain: String(chain == null ? "" : chain),
    source: source,
    timestampFetched: timestampFetched,
    timestampSource: timestampSource,
    priceUsd: toNumber(priceUsd),
    liquidityUsd: toNumber(liquidityUsd),
    volume24hUsd: toNumber(volume24hUsd),
    poolAddress: poolAddress == null ? null : String(poolAddress),
    raw: raw,
  };
}

function splitGtId(id) {
  if (typeof id !== "string") return { network: null, address: null };
  const index = id.indexOf("_");
  if (index === -1) return { network: null, address: id };
  return { network: id.slice(0, index), address: id.slice(index + 1) };
}

function normalizeBirdeye(raw, { tokenAddress, chain, timestampFetched = Date.now() } = {}) {
  const data = (raw && raw.data) || raw;
  return createNormalizedResult({
    tokenAddress: firstDefined(tokenAddress, data && data.address, data && data.tokenAddress),
    chain: firstDefined(chain, data && data.chain, data && data.chainId),
    source: SOURCES.BIRDEYE,
    timestampFetched: timestampFetched,
    timestampSource: normalizeTimestampSource(raw),
    priceUsd: firstDefined(data && data.priceUsd, data && data.price, data && data.value),
    liquidityUsd: firstDefined(data && data.liquidityUsd, data && data.liquidity),
    volume24hUsd: firstDefined(
      data && data.volume24hUsd,
      data && data.volume24h,
      data && data.volume && data.volume.h24,
    ),
    poolAddress: firstDefined(data && data.poolAddress, data && data.pairAddress),
    raw: raw,
  });
}

function normalizeDexScreener(raw, { tokenAddress, chain, timestampFetched = Date.now() } = {}) {
  const payload = raw && raw.pairs ? raw : (raw && raw.data) || raw;
  const pair = payload && Array.isArray(payload.pairs) ? payload.pairs[0] : payload;
  return createNormalizedResult({
    tokenAddress: firstDefined(
      tokenAddress,
      pair && pair.baseToken && pair.baseToken.address,
      pair && pair.tokenAddress,
    ),
    chain: firstDefined(chain, pair && pair.chainId, pair && pair.chain),
    source: SOURCES.DEXSCREENER,
    timestampFetched: timestampFetched,
    timestampSource: normalizeTimestampSource(pair || raw),
    priceUsd: pair && pair.priceUsd,
    liquidityUsd: pair && pair.liquidity && pair.liquidity.usd,
    volume24hUsd: pair && pair.volume && pair.volume.h24,
    poolAddress: firstDefined(pair && pair.pairAddress, pair && pair.poolAddress),
    raw: raw,
  });
}

function normalizeGeckoTerminal(raw, { tokenAddress, chain, timestampFetched = Date.now() } = {}) {
  const pool = raw && raw.data && !Array.isArray(raw.data) ? raw.data : raw;
  const attributes = (pool && pool.attributes) || pool || {};
  const relationships = (pool && pool.relationships) || {};
  const baseTokenId = relationships.base_token && relationships.base_token.data
    ? relationships.base_token.data.id
    : null;
  return createNormalizedResult({
    tokenAddress: firstDefined(tokenAddress, splitGtId(baseTokenId).address, attributes.address),
    chain: firstDefined(chain, splitGtId(pool && pool.id).network),
    source: SOURCES.GECKOTERMINAL,
    timestampFetched: timestampFetched,
    timestampSource: toTimestampMs(attributes.pool_created_at),
    priceUsd: firstDefined(attributes.base_token_price_usd, attributes.price_usd),
    liquidityUsd: attributes.reserve_in_usd,
    volume24hUsd: attributes.volume_usd && attributes.volume_usd.h24,
    poolAddress: attributes.address,
    raw: raw,
  });
}

function normalizeGoPlus(raw, { tokenAddress, chain, timestampFetched = Date.now() } = {}) {
  const data = (raw && raw.result) || (raw && raw.data) || raw;
  const token = (data && data.token) || data;
  return createNormalizedResult({
    tokenAddress: firstDefined(tokenAddress, token && token.address, token && token.token_address),
    chain: firstDefined(chain, token && token.chain, token && token.chain_id),
    source: SOURCES.GOPLUS,
    timestampFetched: timestampFetched,
    timestampSource: normalizeTimestampSource(raw),
    priceUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    poolAddress: firstDefined(token && token.poolAddress, token && token.lp_address),
    raw: raw,
  });
}

function indexIncluded(payload) {
  const included = (payload && payload.included) || [];
  return new Map(included.map((item) => [item.type + ":" + item.id, item]));
}

function fetchGeckoTerminalFeed(chain, feed) {
  const build = FEEDS[feed] || FEEDS.trending;
  return cached("gt:feed:" + chain.gt + ":" + feed, GT_CACHE_TTL_MS, async () => {
    const payload = await fetchJson(build(chain.gt));
    return {
      pools: Array.isArray(payload && payload.data) ? payload.data : [],
      included: indexIncluded(payload),
    };
  });
}

function fetchGeckoTerminalTokenPools(chain, tokenAddress) {
  return cached("gt:token:" + chain.gt + ":" + tokenAddress, GT_CACHE_TTL_MS, async () => {
    const build = (address) => GT_BASE + "/networks/" + chain.gt + "/tokens/" +
      encodeURIComponent(address) + "/pools?include=base_token,quote_token,dex";
    let payload;
    try {
      payload = await fetchJson(build(tokenAddress));
    } catch (error) {
      if (error.status !== 404) throw error;
      const resolved = await resolveTokenAddress(chain, tokenAddress);
      if (!resolved || resolved === tokenAddress) throw error;
      payload = await fetchJson(build(resolved));
    }
    return {
      pools: Array.isArray(payload && payload.data) ? payload.data : [],
      included: indexIncluded(payload),
    };
  });
}

function fetchDexScreenerTokens(addresses) {
  if (!addresses.length) return Promise.resolve([]);
  const batches = [];
  for (let i = 0; i < addresses.length; i += 30) batches.push(addresses.slice(i, i + 30));
  return cached("ds:tokens:" + batches.join("|"), DS_CACHE_TTL_MS, async () => {
    const responses = await Promise.all(batches.map((batch) =>
      fetchJson(DS_BASE + "/latest/dex/tokens/" + batch.join(",")).catch(() => null)));
    return responses.flatMap((response) =>
      response && Array.isArray(response.pairs) ? response.pairs : []);
  });
}

/**
 * Jupiter token API (keyless, Solana only). One batched call covers a whole
 * feed and carries data no other free source gives us: an organic-flow score,
 * holder counts with a change rate, a USD buy/sell split per window, circulating
 * supply and a dev-history audit.
 */
const JUP_TOKEN_BASE = "https://lite-api.jup.ag/tokens/v2";
const JUP_CACHE_TTL_MS = Number(process.env.JUP_CACHE_TTL_MS || 30000);
const JUP_BATCH = Number(process.env.JUP_BATCH || 40);
const jupiterCache = new Map();

function normalizeJupiter(token) {
  if (!token || !token.id) return null;
  const win = (w) => {
    const s = token[w];
    if (!s) return null;
    const buy = toNumber(s.buyVolume);
    const sell = toNumber(s.sellVolume);
    const organic = (toNumber(s.buyOrganicVolume) || 0) + (toNumber(s.sellOrganicVolume) || 0);
    const total = (buy || 0) + (sell || 0);
    return {
      buyUsd: buy, sellUsd: sell,
      netUsd: buy !== null && sell !== null ? Math.round((buy - sell) * 100) / 100 : null,
      netRatio: total ? Math.round(((buy - sell) / total) * 1000) / 1000 : null,
      organicUsd: organic || null,
      organicSharePct: total ? Math.round((organic / total) * 1000) / 10 : null,
      numBuys: toNumber(s.numBuys), numSells: toNumber(s.numSells),
      numTraders: toNumber(s.numTraders), numNetBuyers: toNumber(s.numNetBuyers),
      numOrganicBuyers: toNumber(s.numOrganicBuyers),
      holderChangePct: toNumber(s.holderChange),
      priceChangePct: toNumber(s.priceChange),
      liquidityChangePct: toNumber(s.liquidityChange),
    };
  };
  const audit = token.audit || {};
  return {
    source: SOURCES.JUPITER,
    holderCount: toNumber(token.holderCount),
    organicScore: toNumber(token.organicScore),
    organicScoreLabel: token.organicScoreLabel || null,
    circSupply: toNumber(token.circSupply),
    totalSupply: toNumber(token.totalSupply),
    mcap: toNumber(token.mcap),
    fdv: toNumber(token.fdv),
    usdPrice: toNumber(token.usdPrice),
    launchpad: token.launchpad || null,
    graduatedAt: token.graduatedAt || null,
    createdAt: token.createdAt || null,
    devAddress: token.dev || null,
    twitter: token.twitter || null,
    website: token.website || null,
    tags: Array.isArray(token.tags) ? token.tags : [],
    audit: {
      mintAuthorityDisabled: audit.mintAuthorityDisabled ?? null,
      freezeAuthorityDisabled: audit.freezeAuthorityDisabled ?? null,
      topHoldersPercentage: toNumber(audit.topHoldersPercentage),
      devMigrations: toNumber(audit.devMigrations),
      devMints: toNumber(audit.devMints),
    },
    stats5m: win("stats5m"), stats1h: win("stats1h"),
    stats6h: win("stats6h"), stats24h: win("stats24h"),
  };
}

async function fetchJupiterTokens(chain, mints) {
  if (chain.key !== "solana" || !mints.length) return new Map();
  const now = Date.now();
  const out = new Map();
  const stale = [];
  mints.forEach((mint) => {
    const hit = jupiterCache.get(mint);
    if (hit && now - hit.at < JUP_CACHE_TTL_MS) { if (hit.data) out.set(mint, hit.data); }
    else stale.push(mint);
  });
  const batches = [];
  for (let i = 0; i < stale.length; i += JUP_BATCH) batches.push(stale.slice(i, i + JUP_BATCH));
  await Promise.all(batches.map((batch) =>
    cached("jup:" + batch.join(","), JUP_CACHE_TTL_MS, () =>
      fetchJson(JUP_TOKEN_BASE + "/search?query=" + batch.join(",")))
      .then((list) => {
        const seen = new Set();
        (Array.isArray(list) ? list : []).forEach((token) => {
          const norm = normalizeJupiter(token);
          if (!norm) return;
          jupiterCache.set(token.id, { at: Date.now(), data: norm });
          out.set(token.id, norm);
          seen.add(token.id);
        });
        // Cache the misses too, so unknown mints are not re-queried every refresh.
        batch.forEach((mint) => { if (!seen.has(mint)) jupiterCache.set(mint, { at: Date.now(), data: null }); });
      })
      .catch(() => {})));
  return out;
}

function pickBestPair(pairs, poolAddress) {
  if (poolAddress) {
    const wanted = String(poolAddress).toLowerCase();
    const exact = pairs.find((pair) =>
      pair && pair.pairAddress && String(pair.pairAddress).toLowerCase() === wanted);
    if (exact) return exact;
  }
  return pairs.reduce((best, pair) => {
    const liquidity = toNumber(pair && pair.liquidity && pair.liquidity.usd) || 0;
    const bestLiquidity = best === null ? -1 : (toNumber(best.liquidity && best.liquidity.usd) || 0);
    return liquidity > bestLiquidity ? pair : best;
  }, null);
}

function percentDelta(from, to) {
  if (from === null || to === null || !from) return null;
  return ((to - from) / from) * 100;
}

function buildRow(pool, included, chain, dexPairsByToken, fetchedAt) {
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

  const tokenAddress = baseToken.address || splitGtId(baseTokenId).address;
  const dexPairs = (tokenAddress && dexPairsByToken.get(tokenAddress.toLowerCase())) || [];
  const pair = pickBestPair(dexPairs, attributes.address) || {};

  const gtPrice = toNumber(attributes.base_token_price_usd);
  const dsPrice = toNumber(pair.priceUsd);
  const gtLiquidity = toNumber(attributes.reserve_in_usd);
  const dsLiquidity = toNumber(pair.liquidity && pair.liquidity.usd);
  const gtVolume24h = toNumber(attributes.volume_usd && attributes.volume_usd.h24);
  const dsVolume24h = toNumber(pair.volume && pair.volume.h24);

  const change = attributes.price_change_percentage || {};
  const dsChange = pair.priceChange || {};
  const gtTxns24h = (attributes.transactions && attributes.transactions.h24) || {};
  const gtTxns5m = (attributes.transactions && attributes.transactions.m5) || {};
  const dsTxns5m = (pair.txns && pair.txns.m5) || {};
  const dsTxns24h = (pair.txns && pair.txns.h24) || {};

  const createdAt = toTimestampMs(attributes.pool_created_at) || toTimestampMs(pair.pairCreatedAt);
  const buys24h = toNumber(gtTxns24h.buys) === null ? toNumber(dsTxns24h.buys) : toNumber(gtTxns24h.buys);
  const sells24h = toNumber(gtTxns24h.sells) === null ? toNumber(dsTxns24h.sells) : toNumber(gtTxns24h.sells);

  const confirmingSources = [];
  if (gtPrice !== null) confirmingSources.push(SOURCES.GECKOTERMINAL);
  if (dsPrice !== null) confirmingSources.push(SOURCES.DEXSCREENER);

  const pickNumber = (primary, fallback) => (primary === null ? fallback : primary);

  return {
    chain: chain.key,
    tokenAddress: tokenAddress || null,
    poolAddress: attributes.address || pair.pairAddress || null,
    symbol: baseToken.symbol ||
      (pair.baseToken && pair.baseToken.symbol) ||
      String(attributes.name || "").split("/")[0].trim() || null,
    name: baseToken.name || (pair.baseToken && pair.baseToken.name) || null,
    pairName: attributes.name || null,
    quoteSymbol: quoteToken.symbol || (pair.quoteToken && pair.quoteToken.symbol) || null,
    quoteTokenPriceUsd: toNumber(attributes.quote_token_price_usd),
    imageUrl: baseToken.image_url || (pair.info && pair.info.imageUrl) || null,
    dexId: dexId || pair.dexId || null,

    priceUsd: pickNumber(dsPrice, gtPrice),
    priceSource: dsPrice !== null
      ? SOURCES.DEXSCREENER
      : (gtPrice !== null ? SOURCES.GECKOTERMINAL : null),
    liquidityUsd: pickNumber(dsLiquidity, gtLiquidity),
    volume24hUsd: pickNumber(dsVolume24h, gtVolume24h),
    volume1hUsd: pickNumber(
      toNumber(pair.volume && pair.volume.h1),
      toNumber(attributes.volume_usd && attributes.volume_usd.h1),
    ),
    volume5mUsd: pickNumber(
      toNumber(pair.volume && pair.volume.m5),
      toNumber(attributes.volume_usd && attributes.volume_usd.m5),
    ),
    marketCapUsd: pickNumber(toNumber(pair.marketCap), toNumber(attributes.market_cap_usd)),
    fdvUsd: pickNumber(toNumber(pair.fdv), toNumber(attributes.fdv_usd)),

    priceChangePct: {
      m5: pickNumber(toNumber(dsChange.m5), toNumber(change.m5)),
      m15: toNumber(change.m15),
      h1: pickNumber(toNumber(dsChange.h1), toNumber(change.h1)),
      h6: pickNumber(toNumber(dsChange.h6), toNumber(change.h6)),
      h24: pickNumber(toNumber(dsChange.h24), toNumber(change.h24)),
    },

    txns24h: { buys: buys24h, sells: sells24h },
    txns5m: {
      buys: pickNumber(toNumber(gtTxns5m.buys), toNumber(dsTxns5m.buys)),
      sells: pickNumber(toNumber(gtTxns5m.sells), toNumber(dsTxns5m.sells)),
    },
    traders5m: { buyers: toNumber(gtTxns5m.buyers), sellers: toNumber(gtTxns5m.sellers) },
    traders24h: { buyers: toNumber(gtTxns24h.buyers), sellers: toNumber(gtTxns24h.sellers) },
    buySellRatio24h: buys24h !== null && sells24h ? buys24h / sells24h : null,
    volumeToLiquidity24h: (() => {
      const volume = pickNumber(dsVolume24h, gtVolume24h);
      const liquidity = pickNumber(dsLiquidity, gtLiquidity);
      return volume !== null && liquidity ? volume / liquidity : null;
    })(),

    poolCreatedAt: createdAt || null,
    poolAgeHours: createdAt ? (fetchedAt - createdAt) / 3600000 : null,

    links: {
      dexscreener: pair.url ||
        (attributes.address ? "https://dexscreener.com/" + chain.ds + "/" + attributes.address : null),
      geckoterminal: attributes.address
        ? "https://www.geckoterminal.com/" + chain.gt + "/pools/" + attributes.address
        : null,
      websites: ((pair.info && pair.info.websites) || []).map((site) => site.url),
      socials: ((pair.info && pair.info.socials) || [])
        .map((social) => ({ type: social.type, url: social.url })),
    },

    sources: {
      geckoterminal: { priceUsd: gtPrice, liquidityUsd: gtLiquidity, volume24hUsd: gtVolume24h },
      dexscreener: {
        priceUsd: dsPrice,
        liquidityUsd: dsLiquidity,
        volume24hUsd: dsVolume24h,
        pairs: dexPairs.length,
      },
    },
    crossSource: {
      sourcesAgreeing: confirmingSources.length,
      sources: confirmingSources,
      priceDeltaPct: percentDelta(gtPrice, dsPrice),
    },
  };
}

const TRADES_CACHE_TTL_MS = Number(process.env.TRADES_CACHE_TTL_MS || 180000);
const ROTATION_POOLS = Number(process.env.ROTATION_POOLS || 12);

function fetchPoolTrades(chain, poolAddress) {
  return cached("trades:" + chain.gt + ":" + poolAddress, TRADES_CACHE_TTL_MS, async () => {
    const build = (address) => GT_BASE + "/networks/" + chain.gt + "/pools/" +
      encodeURIComponent(address) + "/trades";
    let payload;
    try {
      payload = await fetchJson(build(poolAddress));
    } catch (error) {
      if (error.status !== 404) throw error;
      const resolved = await resolvePoolAddress(chain, poolAddress);
      if (!resolved || resolved === poolAddress) throw error;
      payload = await fetchJson(build(resolved));
    }
    const list = (payload && payload.data) || [];
    return list.map((t) => t.attributes).filter(Boolean).map((a) => ({
      wallet: a.tx_from_address,
      kind: a.kind,
      usd: toNumber(a.volume_in_usd) || 0,
      at: Date.parse(a.block_timestamp) || null,
    })).filter((t) => t.wallet);
  });
}

function tradeStatsFrom(trades) {
  if (!trades || !trades.length) return null;
  const wallets = new Map();
  let buyUsd = 0;
  let sellUsd = 0;
  const buyers = new Set();
  const sellers = new Set();

  trades.forEach((t) => {
    if (t.kind === "buy") { buyUsd += t.usd; buyers.add(t.wallet); }
    else { sellUsd += t.usd; sellers.add(t.wallet); }
    const w = wallets.get(t.wallet) || { trades: 0, usd: 0 };
    w.trades += 1;
    w.usd += t.usd;
    wallets.set(t.wallet, w);
  });

  const ranked = Array.from(wallets.values()).sort((a, b) => b.usd - a.usd);
  const totalUsd = buyUsd + sellUsd;
  const times = trades.map((t) => t.at).filter(Boolean);
  const oneAndDone = ranked.filter((w) => w.trades === 1).length;

  return {
    trades: trades.length,
    distinctWallets: wallets.size,
    tradesPerWallet: wallets.size ? Math.round((trades.length / wallets.size) * 100) / 100 : null,
    oneAndDonePct: wallets.size ? Math.round((oneAndDone / wallets.size) * 1000) / 10 : null,
    topWalletSharePct: totalUsd ? Math.round((ranked[0].usd / totalUsd) * 1000) / 10 : null,
    top5SharePct: totalUsd
      ? Math.round((ranked.slice(0, 5).reduce((s, w) => s + w.usd, 0) / totalUsd) * 1000) / 10 : null,
    buyUsd: Math.round(buyUsd),
    sellUsd: Math.round(sellUsd),
    netUsd: Math.round(buyUsd - sellUsd),
    netRatio: totalUsd ? Math.round(((buyUsd - sellUsd) / totalUsd) * 1000) / 1000 : null,
    buyerWallets: buyers.size,
    sellerWallets: sellers.size,
    windowMinutes: times.length > 1
      ? Math.round(((Math.max.apply(null, times) - Math.min.apply(null, times)) / 60000) * 10) / 10 : null,
  };
}

const walletSets = new Map();
let rotationCursor = 0;

const ROTATION_REFRESH_MS = Number(process.env.ROTATION_REFRESH_MS || 20000);
let lastRotationAt = 0;

async function refreshRotationSlice(chain, rows) {
  const now = Date.now();
  if (now - lastRotationAt < ROTATION_REFRESH_MS) return;
  lastRotationAt = now;
  const pools = rows.slice(0, ROTATION_POOLS).filter((r) => r.poolAddress);
  if (!pools.length) return;
  const target = pools[rotationCursor % pools.length];
  rotationCursor += 1;
  try {
    const trades = await fetchPoolTrades(chain, target.poolAddress);
    const stats = tradeStatsFrom(trades);
    const perWallet = new Map();
    trades.forEach((t) => perWallet.set(t.wallet, (perWallet.get(t.wallet) || 0) + t.usd));
    walletSets.set(chain.key + ":" + target.poolAddress, {
      at: Date.now(), symbol: target.symbol, wallets: perWallet, stats: stats,
    });
  } catch (error) {
  }
}

function rotationFor(chainKey, poolAddress) {
  const own = walletSets.get(chainKey + ":" + poolAddress);
  if (!own || !own.wallets.size) return null;
  const peers = [];
  let sharedWallets = new Set();
  let sharedUsd = 0;

  walletSets.forEach((entry, key) => {
    if (key === chainKey + ":" + poolAddress) return;
    if (!key.startsWith(chainKey + ":")) return;
    let count = 0;
    let usd = 0;
    own.wallets.forEach((ownUsd, wallet) => {
      if (entry.wallets.has(wallet)) {
        count += 1;
        usd += ownUsd + entry.wallets.get(wallet);
        sharedWallets.add(wallet);
      }
    });
    if (count) peers.push({ symbol: entry.symbol, sharedWallets: count, combinedUsd: Math.round(usd) });
  });

  peers.sort((a, b) => b.combinedUsd - a.combinedUsd);
  own.wallets.forEach((usd, wallet) => { if (sharedWallets.has(wallet)) sharedUsd += usd; });
  const totalUsd = Array.from(own.wallets.values()).reduce((a, b) => a + b, 0);

  return {
    poolsCompared: walletSets.size - 1,
    sharedWalletCount: sharedWallets.size,
    sharedWalletPct: own.wallets.size
      ? Math.round((sharedWallets.size / own.wallets.size) * 1000) / 10 : null,
    sharedUsdPct: totalUsd ? Math.round((sharedUsd / totalUsd) * 1000) / 10 : null,
    peers: peers.slice(0, 5),
  };
}

const USD_REFERENCE_TTL_MS = Number(process.env.USD_REFERENCE_TTL_MS || 60000);
const REFERENCE_SYMBOLS = Object.freeze({
  SOL: { binance: "SOLUSDT", coingecko: "solana" },
  ETH: { binance: "ETHUSDT", coingecko: "ethereum" },
  WETH: { binance: "ETHUSDT", coingecko: "ethereum" },
  BNB: { binance: "BNBUSDT", coingecko: "binancecoin" },
  WBNB: { binance: "BNBUSDT", coingecko: "binancecoin" },
  AVAX: { binance: "AVAXUSDT", coingecko: "avalanche-2" },
  POL: { binance: "POLUSDT", coingecko: "polygon-ecosystem-token" },
  TON: { binance: "TONUSDT", coingecko: "the-open-network" },
  HYPE: { binance: "HYPEUSDT", coingecko: "hyperliquid" },
  S: { binance: "SUSDT", coingecko: "sonic-3" },
  BERA: { binance: "BERAUSDT", coingecko: "berachain-bera" },
  SUI: { binance: "SUIUSDT", coingecko: "sui" },
});

function usdReferenceFor(symbol) {
  const key = String(symbol || "").toUpperCase().replace(/^W(?=[A-Z]{2,})/, "");
  const map = REFERENCE_SYMBOLS[key] || REFERENCE_SYMBOLS[String(symbol || "").toUpperCase()];
  if (!map) return Promise.resolve(null);
  return cached("usdref:" + key, USD_REFERENCE_TTL_MS, async () => {
    const quotes = [];
    await Promise.all([
      fetchJson("https://api.binance.com/api/v3/ticker/price?symbol=" + map.binance)
        .then((d) => { const p = toNumber(d && d.price); if (p) quotes.push({ venue: "binance", price: p }); })
        .catch(() => {}),
      fetchJson("https://api.coinbase.com/v2/prices/" + key + "-USD/spot")
        .then((d) => { const p = toNumber(d && d.data && d.data.amount); if (p) quotes.push({ venue: "coinbase", price: p }); })
        .catch(() => {}),
      fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=" + map.coingecko + "&vs_currencies=usd")
        .then((d) => { const p = toNumber(d && d[map.coingecko] && d[map.coingecko].usd); if (p) quotes.push({ venue: "coingecko", price: p }); })
        .catch(() => {}),
    ]);
    if (!quotes.length) return null;
    const prices = quotes.map((q) => q.price).sort((a, b) => a - b);
    const median = prices.length % 2
      ? prices[(prices.length - 1) / 2]
      : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
    return { symbol: key, median: median, quotes: quotes };
  });
}

const SCORE_MODEL = Object.freeze([
  { key: "volumeAnomaly", label: "Volume anomaly", weight: 13 },
  { key: "tradeActivity", label: "Trade activity", weight: 8 },
  { key: "buyerBreadth", label: "Buyer breadth", weight: 12 },
  { key: "netDemand", label: "Net demand", weight: 10 },
  { key: "liquidity", label: "Liquidity / executability", weight: 14 },
  { key: "priceConfirmation", label: "Price confirmation", weight: 8 },
  { key: "holderGrowth", label: "Holder growth", weight: 7 },
  { key: "walletQuality", label: "Wallet quality", weight: 8 },
  { key: "capitalRotation", label: "Capital rotation", weight: 8 },
  { key: "crossVenue", label: "Cross-venue confirm", weight: 4 },
  { key: "usdReference", label: "USD reference", weight: 3 },
  { key: "dataQuality", label: "Data quality", weight: 5 },
]);

const SCORE_MODIFIERS = Object.freeze([
  { key: "organicFlow", label: "Organic flow" },
  { key: "contractSafety", label: "Contract safety" },
]);

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
const to100 = (v) => Math.round(clamp01(v) * 100);

const multipleScore = (multiple) =>
  Number.isFinite(multiple) && multiple > 0 ? to100(0.5 + 0.3 * Math.log10(multiple)) : null;
const logScore = (value, lo, hi) =>
  Number.isFinite(value) && value > 0
    ? to100((Math.log10(Math.max(value, 1)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)))
    : null;

function computeComponents(row, extras) {
  const z = (extras.zScores && extras.zScores.metrics) || {};
  const stats = extras.tradeStats || null;
  const intel = extras.intel || null;
  const rotation = extras.rotation || null;
  const usdRef = extras.usdReference || null;
  const parts = {};
  const evidence = {};

  const set = (key, value, note) => { parts[key] = value; evidence[key] = note; };

  if (z.volume5mUsd) {
    set("volumeAnomaly", multipleScore(z.volume5mUsd.multiple),
      z.volume5mUsd.multiple + "x baseline, z " + z.volume5mUsd.z);
  }
  if (z.buys5m) {
    set("tradeActivity", multipleScore(z.buys5m.multiple),
      z.buys5m.multiple + "x baseline, z " + z.buys5m.z);
  }
  {
    const anomaly = z.buyers5m ? multipleScore(z.buyers5m.multiple) : null;
    const absolute = logScore(row.traders24h && row.traders24h.buyers, 10, 3000);
    if (anomaly !== null || absolute !== null) {
      const blended = anomaly !== null && absolute !== null
        ? Math.round(anomaly * 0.5 + absolute * 0.5) : (anomaly !== null ? anomaly : absolute);
      set("buyerBreadth", blended,
        (row.traders24h && row.traders24h.buyers != null ? row.traders24h.buyers + " buyers 24h" : "") +
        (z.buyers5m ? ", " + z.buyers5m.multiple + "x 5m baseline" : ""));
    }
  }
  const jup = extras.jupiter || null;
  const jupWindow = jup && (jup.stats1h || jup.stats5m || jup.stats24h) ? (jup.stats1h || jup.stats5m || jup.stats24h) : null;
  if (stats && stats.netRatio !== null) {
    set("netDemand", to100(0.5 + stats.netRatio / 2),
      "net $" + stats.netUsd.toLocaleString() + " over " + stats.windowMinutes + "m");
  } else if (jupWindow && jupWindow.netRatio !== null) {
    set("netDemand", to100(0.5 + jupWindow.netRatio / 2),
      "net $" + Math.round(jupWindow.netUsd).toLocaleString() + " of $" +
      Math.round((jupWindow.buyUsd || 0) + (jupWindow.sellUsd || 0)).toLocaleString() + " (Jupiter USD split)");
  } else if (Number.isFinite(row.buySellRatio24h)) {
    set("netDemand", to100((row.buySellRatio24h - 0.5) / 1.5),
      "buy/sell count ratio " + row.buySellRatio24h.toFixed(2) + " (no USD split yet)");
  }
  {
    const depth = logScore(row.liquidityUsd, 10000, 1000000);
    const impact = intel && intel.impact && Number.isFinite(intel.impact.priceImpactPct)
      ? to100(1 - intel.impact.priceImpactPct / 2.5) : null;
    if (depth !== null || impact !== null) {
      const blended = depth !== null && impact !== null
        ? Math.round(depth * 0.5 + impact * 0.5) : (depth !== null ? depth : impact);
      set("liquidity", blended,
        (depth !== null ? "$" + Math.round(row.liquidityUsd).toLocaleString() + " depth" : "") +
        (impact !== null ? ", " + intel.impact.priceImpactPct + "% impact on $" + intel.impact.tradeUsd : ""));
    }
  }
  if (row.crossSource && Number.isFinite(row.crossSource.priceDeltaPct)) {
    set("priceConfirmation", to100(1 - Math.abs(row.crossSource.priceDeltaPct) / 5),
      Math.abs(row.crossSource.priceDeltaPct).toFixed(2) + "% apart");
  } else if (row.crossSource && row.crossSource.sourcesAgreeing < 2) {
    set("priceConfirmation", 40, "only one source priced it");
  }
  if (intel && intel.holders && intel.holders.growth && intel.holders.growth.perHour !== null) {
    const g = intel.holders.growth;
    const rate = intel.holders.count ? (g.perHour / intel.holders.count) * 100 : 0;
    set("holderGrowth", to100(0.5 + rate * 5),
      (g.perHour > 0 ? "+" : "") + g.perHour + " holders/h on " + intel.holders.count.toLocaleString());
  } else if (jup && jup.stats1h && Number.isFinite(jup.stats1h.holderChangePct)) {
    // Jupiter reports the holder delta per window, so this needs no local series.
    const pct = jup.stats1h.holderChangePct;
    set("holderGrowth", to100(0.5 + pct / 4),
      (pct > 0 ? "+" : "") + pct.toFixed(2) + "% holders in 1h" +
      (jup.holderCount ? " on " + jup.holderCount.toLocaleString() : "") + " (Jupiter)");
  }
  if (jup && jup.audit && Number.isFinite(jup.audit.topHoldersPercentage) &&
      !(intel && intel.holders && intel.holders.topHolderSharePct !== null)) {
    set("walletQuality", to100(clamp01(1 - jup.audit.topHoldersPercentage / 60)),
      "top holders " + jup.audit.topHoldersPercentage.toFixed(1) + "% (Jupiter audit)" +
      (jup.audit.devMigrations ? ", dev has " + jup.audit.devMigrations + " prior migrations" : ""));
  }
  if (intel && intel.holders && intel.holders.topHolderSharePct !== null) {
    const cs = intel.contractSafety || {};
    let value = clamp01(1 - intel.holders.topHolderSharePct / 60);
    if (cs.insidersDetected) value *= 0.75;
    if (Number.isFinite(cs.creatorOtherTokens) && cs.creatorOtherTokens > 20) value *= 0.8;
    if (Number.isFinite(cs.lpLockedPct) && cs.lpLockedPct > 90) value = Math.min(1, value * 1.15);
    set("walletQuality", to100(value),
      "top-10 hold " + intel.holders.topHolderSharePct + "%" +
      (cs.insidersDetected ? ", insider graph detected" : "") +
      (Number.isFinite(cs.creatorOtherTokens) ? ", creator has " + cs.creatorOtherTokens + " tokens" : ""));
  }
  if (rotation && rotation.sharedWalletPct !== null) {
    set("capitalRotation", to100(rotation.sharedWalletPct / 25),
      rotation.sharedWalletCount + " wallets shared with " +
      (rotation.peers[0] ? rotation.peers[0].symbol : "other pools") +
      " (" + rotation.sharedWalletPct + "% of traders)");
  }
  {
    const venues = row.sources && row.sources.dexscreener ? row.sources.dexscreener.pairs : null;
    if (Number.isFinite(venues)) {
      const agreeing = row.crossSource ? row.crossSource.sourcesAgreeing : 1;
      set("crossVenue", to100((logScore(venues, 1, 20) / 100) * (agreeing > 1 ? 1 : 0.6)),
        venues + " venues, " + agreeing + "/2 sources");
    }
  }
  if (usdRef && Number.isFinite(row.quoteTokenPriceUsd) && usdRef.median) {
    const deviation = Math.abs(row.quoteTokenPriceUsd - usdRef.median) / usdRef.median * 100;
    set("usdReference", to100(1 - deviation / 2),
      usdRef.symbol + " $" + row.quoteTokenPriceUsd.toFixed(4) + " vs $" + usdRef.median.toFixed(4) +
      " median of " + usdRef.quotes.length + " venues (" + deviation.toFixed(2) + "% off)");
  }

  const measured = SCORE_MODEL.filter((c) => c.key !== "dataQuality" && parts[c.key] != null);
  const coverable = SCORE_MODEL.length - 1;
  set("dataQuality", Math.round((measured.length / coverable) * 100),
    measured.length + " of " + coverable + " inputs present");

  return { parts: parts, evidence: evidence };
}

function computeModifiers(row, extras) {
  const stats = extras.tradeStats;
  const intel = extras.intel;
  const jup = extras.jupiter;
  const out = {};

  // Jupiter publishes its own organic-flow score (0-100) plus the organic share
  // of traded volume, so this no longer depends on winning the trade-sampling
  // rotation. A local trade sample, when we have one, still wins.
  if (!stats && jup && Number.isFinite(jup.organicScore)) {
    const share = jup.stats24h ? jup.stats24h.organicSharePct : null;
    out.organicFlow = {
      value: Math.round(jup.organicScore),
      evidence: "Jupiter organic score " + jup.organicScore.toFixed(1) +
        (jup.organicScoreLabel ? " (" + jup.organicScoreLabel + ")" : "") +
        (share !== null ? ", " + share + "% of 24h volume organic" : "") +
        (jup.stats24h && jup.stats24h.numOrganicBuyers !== null
          ? ", " + jup.stats24h.numOrganicBuyers + " organic buyers" : ""),
    };
  }
  if (stats) {
    const spread = clamp01((stats.oneAndDonePct || 0) / 80);
    const concentration = clamp01(1 - (stats.top5SharePct || 0) / 70);
    const churn = clamp01(1 - ((stats.tradesPerWallet || 1) - 1) / 5);
    out.organicFlow = {
      value: to100(spread * 0.4 + concentration * 0.35 + churn * 0.25),
      evidence: stats.oneAndDonePct + "% one-and-done, top-5 hold " + stats.top5SharePct +
        "% of volume, " + stats.tradesPerWallet + " trades/wallet",
    };
  }
  if (intel && intel.contractSafety && intel.contractSafety.available) {
    const cs = intel.contractSafety;
    const passed = (cs.checks || []).filter((c) => c.ok).length;
    const total = (cs.checks || []).length || 1;
    out.contractSafety = {
      value: Math.round((passed / total) * 100),
      evidence: passed + "/" + total + " checks pass" +
        (cs.rugcheckRisks && cs.rugcheckRisks.length ? ", " + cs.rugcheckRisks.length + " RugCheck risks" : ""),
    };
  }
  return out;
}

const STAGES = Object.freeze([
  { name: "EXCEPTIONAL", min: 85 },
  { name: "CONFIRMED", min: 70 },
  { name: "EMERGING", min: 55 },
  { name: "WATCH", min: 0 },
]);
const HYSTERESIS = Number(process.env.STAGE_HYSTERESIS || 3);
const stageStore = new Map();

function stageFor(chainKey, tokenAddress, score) {
  const key = chainKey + ":" + tokenAddress;
  const prior = stageStore.get(key);
  const bare = STAGES.find((s) => score >= s.min) || STAGES[STAGES.length - 1];
  if (!prior) {
    const entry = { stage: bare.name, since: Date.now(), history: [{ stage: bare.name, at: Date.now() }] };
    stageStore.set(key, entry);
    return entry;
  }
  const currentIndex = STAGES.findIndex((s) => s.name === prior.stage);
  const bareIndex = STAGES.findIndex((s) => s.name === bare.name);
  let next = prior.stage;
  if (bareIndex < currentIndex) {
    next = bare.name;
  } else if (bareIndex > currentIndex) {
    const holding = STAGES[currentIndex];
    if (score < holding.min - HYSTERESIS) next = bare.name;
  }
  if (next !== prior.stage) {
    prior.stage = next;
    prior.since = Date.now();
    prior.history.push({ stage: next, at: Date.now() });
    if (prior.history.length > 12) prior.history.shift();
    store.touchStage(chainKey, tokenAddress);
  }
  return prior;
}

function topReasonFor(row, extras) {
  const zm = (extras.zScores && extras.zScores.metrics) || {};
  const parts = [];
  if (zm.volume5mUsd && Number.isFinite(zm.volume5mUsd.multiple)) {
    parts.push({ weight: Math.abs(zm.volume5mUsd.z || 0), text: "Vol " + zm.volume5mUsd.multiple.toFixed(1) + "x base" });
  }
  if (zm.buyers5m && Number.isFinite(zm.buyers5m.multiple)) {
    parts.push({ weight: Math.abs(zm.buyers5m.z || 0), text: "buyers " + zm.buyers5m.multiple.toFixed(1) + "x" });
  }
  if (extras.rotation && extras.rotation.sharedWalletPct) {
    parts.push({ weight: extras.rotation.sharedWalletPct / 10,
      text: "rotation-in " + extras.rotation.sharedWalletPct + "%" });
  }
  if (extras.tradeStats && Number.isFinite(extras.tradeStats.netRatio)) {
    parts.push({ weight: Math.abs(extras.tradeStats.netRatio) * 3,
      text: (extras.tradeStats.netUsd >= 0 ? "net buy " : "net sell ") +
        "$" + Math.abs(extras.tradeStats.netUsd).toLocaleString() });
  }
  if (Number.isFinite(row.buySellRatio24h)) {
    parts.push({ weight: Math.abs(row.buySellRatio24h - 1) * 2,
      text: "B/S " + row.buySellRatio24h.toFixed(2) });
  }
  parts.sort((x, y) => y.weight - x.weight);
  return parts.slice(0, 2).map((p) => p.text).join(" + ") || "awaiting baselines";
}

function scoreRow(row, extras) {
  const context = extras || {};
  const { parts, evidence } = computeComponents(row, context);
  const modifiers = computeModifiers(row, context);

  let weighted = 0;
  let weightUsed = 0;
  const breakdown = SCORE_MODEL.map((c) => {
    const value = parts[c.key];
    const present = Number.isFinite(value);
    if (present) { weighted += value * c.weight; weightUsed += c.weight; }
    return {
      key: c.key, label: c.label, weight: c.weight,
      value: present ? value : null,
      pending: !present,
      evidence: evidence[c.key] || null,
    };
  });

  const rawScore = weightUsed ? Math.round(weighted / weightUsed) : 0;
  const risk = assessRisk(row, modifiers, context);
  const score = Math.max(0, Math.min(100, rawScore - risk.penalty));
  const stage = stageFor(row.chain, row.tokenAddress, score);

  return {
    rawScore: rawScore,
    riskPenalty: risk.penalty,
    riskFlags: risk.flags,
    score: score,
    stage: stage.stage,
    stageSince: stage.since,
    stageHistory: stage.history,
    stageHysteresis: HYSTERESIS,
    scoreModel: breakdown,
    scoreModifiers: SCORE_MODIFIERS.map((m) => ({
      key: m.key, label: m.label,
      value: modifiers[m.key] ? modifiers[m.key].value : null,
      pending: !modifiers[m.key],
      evidence: modifiers[m.key] ? modifiers[m.key].evidence : null,
    })),
    weightCovered: weightUsed,
    componentsPresent: breakdown.filter((b) => !b.pending).length,
    dataQuality: Math.round((weightUsed / 100) * 100) / 100,
  };
}

function assessRisk(row, modifiers, context) {
  const flags = [];
  const add = (severity, code, detail, penalty) =>
    flags.push({ severity: severity, code: code, detail: detail, penalty: penalty });

  const ageHours = row.poolAgeHours;
  if (Number.isFinite(ageHours)) {
    if (ageHours < 2) add("HIGH", "NEW_POOL", "Pool is under 2 hours old", 4);
    else if (ageHours < 24) add("MED", "NEW_POOL", "Pool is under 24 hours old", 2);
  }
  if (!row.crossSource || row.crossSource.sourcesAgreeing < 2) {
    add("MED", "SINGLE_SOURCE", "Only one provider priced this pool", 3);
  }
  if (Number.isFinite(row.liquidityUsd) && row.liquidityUsd < 50000) {
    add("HIGH", "THIN_LIQUIDITY", "Liquidity under $50K", 4);
  }
  const turnover = row.volumeToLiquidity24h;
  if (Number.isFinite(turnover) && turnover > 20) {
    add("MED", "EXTREME_TURNOVER", "24h volume is " + turnover.toFixed(0) + "x liquidity", 3);
  }
  const stats = context && context.tradeStats;
  if (stats && stats.top5SharePct !== null && stats.top5SharePct > 70) {
    add("HIGH", "VOLUME_CONCENTRATED",
      "Top 5 wallets are " + stats.top5SharePct + "% of traded volume", 4);
  }
  const safety = modifiers && modifiers.contractSafety;
  if (safety && safety.value < 100) {
    add(safety.value < 70 ? "HIGH" : "MED", "CONTRACT_CHECKS",
      safety.evidence, safety.value < 70 ? 6 : 3);
  }
  const organic = modifiers && modifiers.organicFlow;
  if (organic && organic.value < 40) {
    add("MED", "LOW_ORGANIC_FLOW", organic.evidence, 3);
  }

  const penalty = Math.min(15, flags.reduce((total, f) => total + f.penalty, 0));
  return { flags: flags, penalty: penalty };
}

function summarize(rows) {
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const column = (key) => rows.map((row) => row[key]).filter((value) => typeof value === "number");
  const changes = rows
    .map((row) => row.priceChangePct && row.priceChangePct.h24)
    .filter((value) => typeof value === "number");
  const sorted = changes.slice().sort((a, b) => a - b);
  const median = sorted.length
    ? (sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : null;

  return {
    poolsTracked: rows.length,
    totalLiquidityUsd: sum(column("liquidityUsd")) || null,
    totalVolume24hUsd: sum(column("volume24hUsd")) || null,
    avgPriceChange24hPct: changes.length ? sum(changes) / changes.length : null,
    medianPriceChange24hPct: median,
    advancing24h: changes.filter((value) => value > 0).length,
    declining24h: changes.filter((value) => value < 0).length,
    multiSourceConfirmed: rows.filter((row) => row.crossSource.sourcesAgreeing > 1).length,
    activeAlerts: rows.filter((row) => row.score >= 55).length,
    confirmedPlus: rows.filter((row) => row.stage === "CONFIRMED" || row.stage === "EXCEPTIONAL").length,
    exceptional: rows.filter((row) => row.stage === "EXCEPTIONAL").length,
    avgOrganicFlow: (() => {
      const vals = rows.map((r) => r.flow && r.flow.organicFlow).filter((v) => Number.isFinite(v));
      return vals.length ? Math.round(vals.reduce((a2, b2) => a2 + b2, 0) / vals.length) : null;
    })(),
    avgDataQuality: (() => {
      const vals = rows.map((r) => r.dataQuality).filter((v) => Number.isFinite(v));
      return vals.length ? Math.round((vals.reduce((a2, b2) => a2 + b2, 0) / vals.length) * 100) / 100 : null;
    })(),
    topScore: rows.length ? Math.max(...rows.map((row) => row.score || 0)) : null,
    avgScore: rows.length
      ? Math.round(sum(rows.map((row) => row.score || 0)) / rows.length)
      : null,
  };
}

async function buildMarketData({ chain, tokenAddress, feed, limit }) {
  const fetchedAt = Date.now();
  const errors = [];

  let pools = [];
  let included = new Map();
  try {
    const result = tokenAddress
      ? await fetchGeckoTerminalTokenPools(chain, tokenAddress)
      : await fetchGeckoTerminalFeed(chain, feed);
    pools = result.pools;
    included = result.included;
  } catch (error) {
    errors.push({ source: SOURCES.GECKOTERMINAL, message: error.message });
  }

  const tokenAddresses = tokenAddress
    ? [tokenAddress]
    : Array.from(new Set(pools
        .map((pool) => splitGtId(
          pool && pool.relationships && pool.relationships.base_token &&
          pool.relationships.base_token.data
            ? pool.relationships.base_token.data.id
            : null,
        ).address)
        .filter(Boolean)));

  let dexPairs = [];
  try {
    dexPairs = await fetchDexScreenerTokens(tokenAddresses.slice(0, 60));
  } catch (error) {
    errors.push({ source: SOURCES.DEXSCREENER, message: error.message });
  }

  const dexPairsByToken = new Map();
  for (const pair of dexPairs) {
    if (pair && pair.chainId && pair.chainId !== chain.ds) continue;
    const address = pair && pair.baseToken && pair.baseToken.address;
    if (!address) continue;
    const key = address.toLowerCase();
    if (!dexPairsByToken.has(key)) dexPairsByToken.set(key, []);
    dexPairsByToken.get(key).push(pair);
  }

  const bare = pools
    .slice(0, limit)
    .map((pool, index) => Object.assign(
      { rank: index + 1 },
      buildRow(pool, included, chain, dexPairsByToken, fetchedAt),
    ));
  recordHistory(chain.key, bare);

  const quoteSymbols = Array.from(new Set(bare.map((r) => r.quoteSymbol).filter(Boolean)));
  const references = {};
  const jupiterByMint = new Map();
  await Promise.all([
    ...quoteSymbols.map((symbol) =>
      usdReferenceFor(symbol).then((ref) => { if (ref) references[symbol] = ref; }).catch(() => {})),
    fetchJupiterTokens(chain, bare.map((r) => r.tokenAddress).filter(Boolean))
      .then((map) => map.forEach((value, key) => jupiterByMint.set(key, value)))
      .catch(() => {}),
  ]);

  refreshRotationSlice(chain, bare).catch(() => {});

  const rows = bare.map((row) => {
    row.jupiter = jupiterByMint.get(row.tokenAddress) || null;
    if (row.jupiter) {
      if (row.marketCapUsd == null) row.marketCapUsd = row.jupiter.mcap;
      if (row.fdvUsd == null) row.fdvUsd = row.jupiter.fdv;
      row.circulatingSupply = row.jupiter.circSupply;
      row.totalSupply = row.jupiter.totalSupply;
      row.holderCount = row.jupiter.holderCount;
      row.launchpad = row.jupiter.launchpad;
      row.socials = { twitter: row.jupiter.twitter, website: row.jupiter.website };
    }
    const extras = {
      zScores: zScoresFor(chain.key, row),
      tradeStats: (walletSets.get(chain.key + ":" + row.poolAddress) || {}).stats || null,
      rotation: rotationFor(chain.key, row.poolAddress),
      usdReference: references[row.quoteSymbol] || null,
      jupiter: row.jupiter,
      intel: null,
    };
    const scored = scoreRow(row, extras);
    const organic = (scored.scoreModifiers || []).find((m) => m.key === "organicFlow");
    return Object.assign(row, scored, {
      spark: sparkFor(chain.key, row.poolAddress),
      topReason: topReasonFor(row, extras),
      volumeBaselineMultiple: extras.zScores.metrics.volume5mUsd
        ? extras.zScores.metrics.volume5mUsd.multiple : null,
      // GeckoTerminal trade sampling when this pool had its rotation turn,
      // otherwise Jupiter's own USD buy/sell split (no sampling gate).
      flow: extras.tradeStats ? {
        source: SOURCES.GECKOTERMINAL,
        netUsd: extras.tradeStats.netUsd,
        buyUsd: extras.tradeStats.buyUsd,
        sellUsd: extras.tradeStats.sellUsd,
        distinctWallets: extras.tradeStats.distinctWallets,
        windowMinutes: extras.tradeStats.windowMinutes,
        organicFlow: organic && !organic.pending ? organic.value : null,
        washRisk: organic && !organic.pending ? 100 - organic.value : null,
      } : (row.jupiter && row.jupiter.stats5m ? {
        source: SOURCES.JUPITER,
        netUsd: row.jupiter.stats5m.netUsd,
        buyUsd: row.jupiter.stats5m.buyUsd,
        sellUsd: row.jupiter.stats5m.sellUsd,
        distinctWallets: row.jupiter.stats5m.numTraders,
        windowMinutes: 5,
        organicSharePct: row.jupiter.stats24h ? row.jupiter.stats24h.organicSharePct : null,
        organicFlow: organic && !organic.pending ? organic.value : null,
        washRisk: organic && !organic.pending ? 100 - organic.value : null,
      } : null),
      rotation: extras.rotation,
    });
  });

  recordObservations(chain.key, rows);

  const sourceBreakdown = [];
  if (pools[0]) {
    sourceBreakdown.push(normalizeGeckoTerminal(pools[0], {
      tokenAddress: rows[0] && rows[0].tokenAddress,
      chain: chain.key,
      timestampFetched: fetchedAt,
    }));
  }
  const leadPair = rows[0] && rows[0].tokenAddress
    ? pickBestPair(dexPairsByToken.get(rows[0].tokenAddress.toLowerCase()) || [], rows[0].poolAddress)
    : null;
  if (leadPair) {
    sourceBreakdown.push(normalizeDexScreener({ pairs: [leadPair] }, {
      tokenAddress: rows[0].tokenAddress,
      chain: chain.key,
      timestampFetched: fetchedAt,
    }));
  }

  return {
    server: "ok",
    chain: chain.key,
    chainLabel: chain.label,
    feed: tokenAddress ? "token" : feed,
    tokenAddress: tokenAddress || (rows[0] && rows[0].tokenAddress) || null,
    fetchedAt: fetchedAt,
    fetchedAtIso: new Date(fetchedAt).toISOString(),
    providers: [
      { source: SOURCES.GECKOTERMINAL, keyless: true, ok: pools.length > 0, pools: pools.length },
      { source: SOURCES.DEXSCREENER, keyless: true, ok: dexPairs.length > 0, pairs: dexPairs.length },
      { source: SOURCES.JUPITER, keyless: true, ok: jupiterByMint.size > 0,
        tokens: jupiterByMint.size,
        note: chain.key === "solana" ? null : "Solana only" },
    ],
    priceUsd: (rows[0] && rows[0].priceUsd) || null,
    liquidityUsd: (rows[0] && rows[0].liquidityUsd) || null,
    volume24hUsd: (rows[0] && rows[0].volume24hUsd) || null,
    summary: summarize(rows),
    rows: rows,
    sourceBreakdown: sourceBreakdown,
    errors: errors,
  };
}

function sendJson(response, status, body) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

// Optional static frontend. Drop a Vite build (the contents of the React app's
// dist/) into ./public and this server also serves the dashboard; leave it empty
// and the server is API-only, with the frontend deployed elsewhere.
const WEB_DIST = path.resolve(__dirname, process.env.PUBLIC_DIR || "public");

const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

function sendFile(response, filePath, cacheControl) {
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      sendJson(response, 404, { error: "Not found", expected: filePath });
      return;
    }
    response.setHeader("Content-Type", MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream");
    response.setHeader("Cache-Control", cacheControl || "no-store");
    response.writeHead(200);
    response.end(contents);
  });
}

function serveStatic(url, response) {
  const requested = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const resolved = path.resolve(WEB_DIST, requested);
  if (resolved !== WEB_DIST && !resolved.startsWith(WEB_DIST + path.sep)) {
    sendJson(response, 403, { error: "Forbidden" });
    return true;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  const immutable = requested.startsWith("assets/");
  sendFile(response, resolved, immutable ? "public, max-age=31536000, immutable" : "no-store");
  return true;
}

function hasFrontend() {
  return fs.existsSync(path.join(WEB_DIST, "index.html"));
}

function sendDashboard(response) {
  if (hasFrontend()) {
    sendFile(response, path.join(WEB_DIST, "index.html"));
    return;
  }
  sendServiceIndex(response);
}

function sendServiceIndex(response) {
  sendJson(response, 200, {
    service: "vibescreener-server",
    status: "ok",
    frontend: "not bundled - deploy the React app separately and point it here",
    routes: [
      "/health",
      "/api/market?chain=solana&feed=trending&limit=30",
      "/api/rotation?chain=solana",
      "/api/wallets?chain=solana",
      "/api/social?chain=solana",
      "/api/evaluation?chain=solana",
      "/api/system",
      "/api/score?chain=solana&pool=<poolAddress>",
      "/api/intel?chain=solana&token=<tokenAddress>&pool=<poolAddress>",
      "/api/ohlcv?chain=solana&pool=<poolAddress>&timeframe=minute",
    ],
  });
}

async function handleMarket(url, response) {
  const requestedChain = url.searchParams.get("chain");
  const chain = resolveChain(requestedChain);
  if (!chain) {
    sendJson(response, 400, {
      server: "error",
      error: 'Unsupported chain "' + requestedChain + '"',
      supported: Object.keys(CHAINS),
      sourceBreakdown: [],
    });
    return;
  }

  const tokenAddress = (url.searchParams.get("tokenAddress") || "").trim() || null;
  const requestedFeed = (url.searchParams.get("feed") || "trending").toLowerCase();
  const feed = FEEDS[requestedFeed] ? requestedFeed : "trending";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || MAX_ROWS, 1), 50);
  const cacheKey = "market:" + chain.key + ":" + (tokenAddress || feed) + ":" + limit;

  try {
    const data = await cached(cacheKey, CACHE_TTL_MS, () =>
      buildMarketData({ chain: chain, tokenAddress: tokenAddress, feed: feed, limit: limit }));
    sendJson(response, 200, data);
  } catch (error) {
    console.error("market error:", error.message);
    sendJson(response, 502, Object.assign(emptyMarketData(tokenAddress, chain.key), {
      server: "error",
      errors: [{ source: "upstream", message: error.message }],
    }));
  }
}

const HISTORY_MAX_SAMPLES = Number(process.env.HISTORY_MAX_SAMPLES || 120);
const HISTORY_MAX_POOLS = Number(process.env.HISTORY_MAX_POOLS || 600);
const HISTORY_MIN_GAP_MS = Number(process.env.HISTORY_MIN_GAP_MS || 15000);
const Z_MIN_SAMPLES = 8;

const historyStore = new Map();
const holderHistory = new Map();

const HISTORY_METRICS = Object.freeze({
  volume5mUsd: "VOL_ANOM_5M",
  buys5m: "TRADE_ACTIVITY_5M",
  buyers5m: "BUYER_BREADTH_5M",
  liquidityUsd: "LIQ_GROWTH",
});

function recordHistory(chainKey, rows) {
  const now = Date.now();
  rows.forEach((row) => {
    if (!row.poolAddress) return;
    const key = chainKey + ":" + row.poolAddress;
    let series = historyStore.get(key);
    if (!series) {
      if (historyStore.size >= HISTORY_MAX_POOLS) {
        let oldestKey = null;
        let oldestAt = Infinity;
        historyStore.forEach((value, k) => {
          if (value.touchedAt < oldestAt) { oldestAt = value.touchedAt; oldestKey = k; }
        });
        if (oldestKey) historyStore.delete(oldestKey);
      }
      series = { samples: [], touchedAt: now };
      historyStore.set(key, series);
    }
    series.touchedAt = now;
    const last = series.samples[series.samples.length - 1];
    if (last && now - last.t < HISTORY_MIN_GAP_MS) return;
    series.samples.push({
      t: now,
      volume5mUsd: toNumber(row.volume5mUsd),
      buys5m: toNumber(row.txns5m && row.txns5m.buys),
      buyers5m: toNumber(row.traders5m && row.traders5m.buyers),
      liquidityUsd: toNumber(row.liquidityUsd),
    });
    if (series.samples.length > HISTORY_MAX_SAMPLES) series.samples.shift();
    store.touchPool(chainKey, row.poolAddress);
  });
}

/**
 * Baselines are only meaningful over a continuous window. When the service has
 * been asleep, restored samples can straddle a multi-hour gap, so anything
 * older than HISTORY_MAX_AGE_MS is dropped before it can skew a z-score.
 */
const HISTORY_MAX_AGE_MS = Number(process.env.HISTORY_MAX_AGE_MS || 6 * 3600000);

function pruneHistory() {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  historyStore.forEach((series, key) => {
    const kept = series.samples.filter((s) => s.t >= cutoff);
    if (!kept.length) historyStore.delete(key);
    else series.samples = kept;
  });
}

function statsFor(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) * (b - mean), 0) / clean.length;
  return { mean: mean, stdev: Math.sqrt(variance), n: clean.length };
}

function sparkFor(chainKey, poolAddress, metric, count) {
  const series = historyStore.get(chainKey + ":" + poolAddress);
  if (!series) return [];
  return series.samples.slice(-(count || 16))
    .map((s) => s[metric || "volume5mUsd"])
    .filter((v) => Number.isFinite(v));
}

function zScoresFor(chainKey, row) {
  const series = historyStore.get(chainKey + ":" + row.poolAddress);
  const samples = series ? series.samples : [];
  const out = { samples: samples.length, windowMs: samples.length > 1
    ? samples[samples.length - 1].t - samples[0].t : 0, metrics: {} };
  if (samples.length < Z_MIN_SAMPLES) return out;

  Object.keys(HISTORY_METRICS).forEach((metric) => {
    const history = samples.slice(0, -1).map((s) => s[metric]);
    const current = samples[samples.length - 1][metric];
    const stats = statsFor(history);
    if (!stats || !Number.isFinite(current)) return;
    out.metrics[metric] = {
      code: HISTORY_METRICS[metric],
      value: current,
      mean: Math.round(stats.mean * 1000) / 1000,
      stdev: Math.round(stats.stdev * 1000) / 1000,
      z: stats.stdev > 0 ? Math.round(((current - stats.mean) / stats.stdev) * 100) / 100 : null,
      multiple: stats.mean > 0 ? Math.round((current / stats.mean) * 100) / 100 : null,
      samples: stats.n,
    };
  });
  return out;
}

function recordHolderCount(chainKey, tokenAddress, count) {
  if (!Number.isFinite(count)) return;
  const key = chainKey + ":" + tokenAddress;
  const series = holderHistory.get(key) || [];
  const last = series[series.length - 1];
  const now = Date.now();
  if (!last || now - last.t > 60000) {
    store.touchHolders(chainKey, tokenAddress);
    series.push({ t: now, count: count });
    if (series.length > 200) series.shift();
    holderHistory.set(key, series);
  }
}

function holderGrowth(chainKey, tokenAddress) {
  const series = holderHistory.get(chainKey + ":" + tokenAddress) || [];
  if (series.length < 2) return { samples: series.length, changed: null, perHour: null, windowMs: 0 };
  const first = series[0];
  const last = series[series.length - 1];
  const windowMs = last.t - first.t;
  const changed = last.count - first.count;
  return {
    samples: series.length,
    windowMs: windowMs,
    changed: changed,
    perHour: windowMs > 0 ? Math.round((changed / (windowMs / 3600000)) * 10) / 10 : null,
  };
}

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
const JUPITER_BASE = "https://lite-api.jup.ag/swap/v1";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const IMPACT_TRADE_USD = Number(process.env.IMPACT_TRADE_USD || 10000);
const INTEL_CACHE_TTL_MS = Number(process.env.INTEL_CACHE_TTL_MS || 300000);

const GOPLUS_CHAIN_IDS = Object.freeze({
  ethereum: "1", bsc: "56", base: "8453", arbitrum: "42161", polygon: "137",
  avalanche: "43114", solana: "solana", robinhood: "4663", monad: "143",
  plasma: "9745", sonic: "146", abstract: "2741", berachain: "80094", unichain: "130",
});

function goPlusUrl(chainKey, tokenAddress) {
  const id = GOPLUS_CHAIN_IDS[chainKey];
  if (!id) return null;
  return id === "solana"
    ? GOPLUS_BASE + "/solana/token_security?contract_addresses=" + encodeURIComponent(tokenAddress)
    : GOPLUS_BASE + "/token_security/" + id + "?contract_addresses=" + encodeURIComponent(tokenAddress);
}

function pickGoPlusRecord(payload, tokenAddress) {
  const result = payload && payload.result;
  if (!result) return null;
  return result[tokenAddress] || result[tokenAddress.toLowerCase()] ||
    result[Object.keys(result)[0]] || null;
}

const truthy = (value) => value === "1" || value === 1 || value === true;

function goPlusChecks(chainKey, record) {
  if (!record) return [];
  const checks = [];
  const add = (label, bad, detail, penalty) =>
    checks.push({ label: label, ok: !bad, detail: detail, penalty: bad ? penalty : 0 });

  if (chainKey === "solana") {
    const authOn = (field) => Boolean(record[field] && truthy(record[field].status));
    add("Mint authority revoked", authOn("mintable"),
      authOn("mintable") ? "Supply can still be minted" : "Cannot mint more supply", 6);
    add("Freeze authority revoked", authOn("freezable"),
      authOn("freezable") ? "Accounts can be frozen" : "No freeze authority", 6);
    add("Account not closable", authOn("closable"),
      authOn("closable") ? "Token accounts can be closed" : "Not closable", 3);
    add("Balance not mutable", authOn("balance_mutable_authority"),
      authOn("balance_mutable_authority") ? "Balances can be altered" : "Balances immutable", 5);
    add("No transfer hook", authOn("transfer_hook_upgradable"),
      authOn("transfer_hook_upgradable") ? "Transfer hook is upgradable" : "No upgradable hook", 3);
    const fee = record.transfer_fee && Object.keys(record.transfer_fee).length ? record.transfer_fee : null;
    add("No transfer fee", Boolean(fee), fee ? "Transfer fee configured" : "No transfer fee", 2);
  } else {
    add("Not a honeypot", truthy(record.is_honeypot),
      truthy(record.is_honeypot) ? "Flagged as a honeypot" : "No honeypot signature", 12);
    add("Source verified", !truthy(record.is_open_source),
      truthy(record.is_open_source) ? "Contract is open source" : "Source not verified", 4);
    add("Ownership not reclaimable", truthy(record.can_take_back_ownership),
      truthy(record.can_take_back_ownership) ? "Owner can reclaim ownership" : "No reclaim path", 6);
    add("No hidden owner", truthy(record.hidden_owner),
      truthy(record.hidden_owner) ? "Hidden owner detected" : "No hidden owner", 6);
    add("Transfers not pausable", truthy(record.transfer_pausable),
      truthy(record.transfer_pausable) ? "Transfers can be paused" : "Transfers cannot be paused", 5);
    add("Supply not mintable", truthy(record.is_mintable),
      truthy(record.is_mintable) ? "Supply can be minted" : "Supply fixed", 4);
    const buyTax = toNumber(record.buy_tax) || 0;
    const sellTax = toNumber(record.sell_tax) || 0;
    const highTax = buyTax > 0.1 || sellTax > 0.1;
    add("Tax under 10%", highTax,
      "buy " + (buyTax * 100).toFixed(1) + "% / sell " + (sellTax * 100).toFixed(1) + "%", 5);
  }
  return checks;
}

function topHolderShare(record) {
  const holders = (record && record.holders) || [];
  const total = holders.reduce((sum, h) => sum + (toNumber(h.percent) || 0), 0);
  return holders.length ? Math.round(total * 10000) / 100 : null;
}

/** USDC per EVM chain, for quoting a $10k sell-side route on KyberSwap. */
const EVM_USDC = Object.freeze({
  ethereum: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, kyber: "ethereum" },
  base: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, kyber: "base" },
  bsc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, kyber: "bsc" },
  arbitrum: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, kyber: "arbitrum" },
  polygon: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, kyber: "polygon" },
  avalanche: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, kyber: "avalanche" },
});
const HONEYPOT_CHAIN_IDS = Object.freeze({ ethereum: 1, bsc: 56, base: 8453 });
const LLAMA_CHAIN = Object.freeze({
  solana: "solana", ethereum: "ethereum", base: "base", bsc: "bsc",
  arbitrum: "arbitrum", polygon: "polygon", avalanche: "avax",
});

/** Routed price impact on EVM chains — Jupiter's counterpart, also keyless. */
async function fetchKyberImpact(chain, tokenAddress) {
  const usdc = EVM_USDC[chain.key];
  if (!usdc) return null;
  const amountIn = BigInt(IMPACT_TRADE_USD) * (10n ** BigInt(usdc.decimals));
  const url = "https://aggregator-api.kyberswap.com/" + usdc.kyber + "/api/v1/routes" +
    "?tokenIn=" + usdc.address + "&tokenOut=" + tokenAddress + "&amountIn=" + amountIn.toString();
  const payload = await fetchJson(url);
  const summary = payload && payload.data && payload.data.routeSummary;
  if (!summary) return null;
  const inUsd = toNumber(summary.amountInUsd);
  const outUsd = toNumber(summary.amountOutUsd);
  if (inUsd === null || outUsd === null || !inUsd) return null;
  return {
    tradeUsd: IMPACT_TRADE_USD,
    priceImpactPct: Math.round(((inUsd - outUsd) / inUsd) * 1e6) / 1e4,
    routes: Array.isArray(summary.route) ? summary.route.length : null,
    gasUsd: toNumber(summary.gasUsd),
    source: SOURCES.KYBERSWAP,
    note: null,
  };
}

/** Honeypot + buy/sell tax simulation for EVM chains (GoPlus's cross-check). */
async function fetchHoneypot(chain, tokenAddress) {
  const chainId = HONEYPOT_CHAIN_IDS[chain.key];
  if (!chainId) return null;
  const payload = await fetchJson(
    "https://api.honeypot.is/v2/IsHoneypot?address=" + tokenAddress + "&chainID=" + chainId);
  if (!payload || (!payload.honeypotResult && !payload.simulationResult)) return null;
  const sim = payload.simulationResult || {};
  return {
    isHoneypot: payload.honeypotResult ? Boolean(payload.honeypotResult.isHoneypot) : null,
    reason: payload.honeypotResult ? payload.honeypotResult.honeypotReason || null : null,
    buyTaxPct: toNumber(sim.buyTax),
    sellTaxPct: toNumber(sim.sellTax),
    transferTaxPct: toNumber(sim.transferTax),
    flags: ((payload.flags || []).map((f) => f.description || f.flag)).filter(Boolean),
    source: SOURCES.HONEYPOT,
  };
}

/** Independent price, for a third opinion alongside GeckoTerminal and DexScreener. */
async function fetchLlamaPrice(chain, tokenAddress) {
  const slug = LLAMA_CHAIN[chain.key];
  if (!slug) return null;
  const key = slug + ":" + tokenAddress;
  const payload = await fetchJson("https://coins.llama.fi/prices/current/" + key);
  const hit = payload && payload.coins && payload.coins[key];
  if (!hit) return null;
  return {
    priceUsd: toNumber(hit.price),
    confidence: toNumber(hit.confidence),
    decimals: toNumber(hit.decimals),
    updatedAt: toNumber(hit.timestamp),
    source: SOURCES.DEFILLAMA,
  };
}

async function fetchTokenIntel(chain, tokenAddress, row) {
  const sources = {};
  const isSolana = chain.key === "solana";

  const goPlusTarget = goPlusUrl(chain.key, tokenAddress);
  const [goPlusRaw, rugRaw, jupRaw] = await Promise.all([
    goPlusTarget
      ? fetchJson(goPlusTarget).then((d) => { sources.goplus = "ok"; return d; })
        .catch((e) => { sources.goplus = e.message; return null; })
      : Promise.resolve((sources.goplus = "chain not supported by GoPlus", null)),
    isSolana
      ? fetchJson(RUGCHECK_BASE + "/tokens/" + encodeURIComponent(tokenAddress) + "/report")
        .then((d) => { sources.rugcheck = "ok"; return d; })
        .catch((e) => { sources.rugcheck = e.message; return null; })
      : Promise.resolve((sources.rugcheck = "Solana only", null)),
    isSolana
      ? fetchJson(JUPITER_BASE + "/quote?inputMint=" + SOLANA_USDC + "&outputMint=" +
          encodeURIComponent(tokenAddress) + "&amount=" + (IMPACT_TRADE_USD * 1e6) + "&slippageBps=50")
        .then((d) => { sources.jupiter = "ok"; return d; })
        .catch((e) => { sources.jupiter = e.message; return null; })
      : Promise.resolve((sources.jupiter = "Solana only", null)),
  ]);

  // Keyless EVM counterparts to Jupiter/RugCheck, plus an independent price.
  const [kyber, honeypot, llama, jupToken] = await Promise.all([
    isSolana
      ? Promise.resolve((sources.kyberswap = "EVM only", null))
      : fetchKyberImpact(chain, tokenAddress)
        .then((d) => { sources.kyberswap = d ? "ok" : "no route"; return d; })
        .catch((e) => { sources.kyberswap = e.message; return null; }),
    isSolana
      ? Promise.resolve((sources.honeypot = "EVM only", null))
      : fetchHoneypot(chain, tokenAddress)
        .then((d) => { sources.honeypot = d ? "ok" : "no data"; return d; })
        .catch((e) => { sources.honeypot = e.message; return null; }),
    fetchLlamaPrice(chain, tokenAddress)
      .then((d) => { sources.defillama = d ? "ok" : "not indexed"; return d; })
      .catch((e) => { sources.defillama = e.message; return null; }),
    isSolana
      ? fetchJupiterTokens(chain, [tokenAddress])
        .then((map) => { const d = map.get(tokenAddress) || null; sources.jupiterTokens = d ? "ok" : "not indexed"; return d; })
        .catch((e) => { sources.jupiterTokens = e.message; return null; })
      : Promise.resolve((sources.jupiterTokens = "Solana only", null)),
  ]);

  const gpRecord = pickGoPlusRecord(goPlusRaw, tokenAddress);
  const checks = goPlusChecks(chain.key, gpRecord);
  // honeypot.is actually simulates a buy and a sell, so on EVM it catches what
  // static GoPlus flags miss. Appended as regular checks.
  if (honeypot) {
    if (honeypot.isHoneypot !== null) {
      checks.push({
        label: "Sell path works (simulated)", ok: !honeypot.isHoneypot,
        detail: honeypot.isHoneypot ? (honeypot.reason || "Simulated sell failed") : "Buy and sell both simulate",
        penalty: 10,
      });
    }
    if (honeypot.buyTaxPct !== null || honeypot.sellTaxPct !== null) {
      const high = (honeypot.buyTaxPct || 0) > 10 || (honeypot.sellTaxPct || 0) > 10;
      checks.push({
        label: "Simulated tax under 10%", ok: !high,
        detail: "buy " + (honeypot.buyTaxPct || 0).toFixed(1) + "% / sell " + (honeypot.sellTaxPct || 0).toFixed(1) + "%",
        penalty: 5,
      });
    }
  }
  const failed = checks.filter((c) => !c.ok);

  const rugRisks = ((rugRaw && rugRaw.risks) || []).map((r) => ({
    name: r.name, level: r.level, description: r.description, score: r.score,
  }));

  const goPlusHolders = toNumber(gpRecord && gpRecord.holder_count);
  const rugHolders = toNumber(rugRaw && rugRaw.totalHolders);
  // Holder count: GoPlus, then RugCheck, then Jupiter.
  const jupHolders = jupToken ? jupToken.holderCount : null;
  const holderCount = goPlusHolders !== null ? goPlusHolders
    : (rugHolders !== null ? rugHolders : jupHolders);
  recordHolderCount(chain.key, tokenAddress, holderCount);

  // Jupiter's routed quote on Solana, KyberSwap's on EVM.
  const impactPct = jupRaw && jupRaw.priceImpactPct !== undefined
    ? Math.round(Number(jupRaw.priceImpactPct) * 1e6) / 1e4 : null;
  const impact = impactPct !== null
    ? { tradeUsd: IMPACT_TRADE_USD, priceImpactPct: impactPct,
        routes: jupRaw && jupRaw.routePlan ? jupRaw.routePlan.length : null,
        source: SOURCES.JUPITER, note: null }
    : kyber;

  const llamaDeltaPct = llama && llama.priceUsd && row && Number.isFinite(row.priceUsd)
    ? Math.round(((row.priceUsd - llama.priceUsd) / llama.priceUsd) * 1e4) / 1e2 : null;

  const buys24h = row && row.txns24h ? toNumber(row.txns24h.buys) : null;
  const buyers24h = row && row.traders24h ? toNumber(row.traders24h.buyers) : null;
  const tradesPerBuyer = buys24h !== null && buyers24h ? buys24h / buyers24h : null;
  const volumePerHolder = row && holderCount ? toNumber(row.volume24hUsd) / holderCount : null;

  const flowNotes = [];
  if (tradesPerBuyer !== null && tradesPerBuyer > 4) flowNotes.push("Each buying wallet traded " + tradesPerBuyer.toFixed(1) + "x on average");
  if (row && Number.isFinite(row.volumeToLiquidity24h) && row.volumeToLiquidity24h > 20) flowNotes.push("Volume is " + row.volumeToLiquidity24h.toFixed(0) + "x liquidity");
  if (volumePerHolder !== null && volumePerHolder > 5000) flowNotes.push("$" + Math.round(volumePerHolder).toLocaleString() + " of volume per holder");

  return {
    server: "ok",
    chain: chain.key,
    tokenAddress: tokenAddress,
    fetchedAt: Date.now(),
    sources: sources,
    contractSafety: {
      available: Boolean(gpRecord) || Boolean(rugRaw) || Boolean(honeypot),
      checks: checks,
      failedCount: failed.length,
      penalty: Math.min(20, failed.reduce((sum, c) => sum + c.penalty, 0)),
      rugcheckScore: rugRaw ? toNumber(rugRaw.score_normalised) : null,
      rugcheckRisks: rugRisks,
      lpLockedPct: (() => {
        const markets = (rugRaw && rugRaw.markets) || [];
        const withLp = markets
          .map((m) => ({ liq: toNumber(m.liquidityA) || 0, pct: toNumber(m.lp && m.lp.lpLockedPct) }))
          .filter((m) => m.pct !== null)
          .sort((a, b) => b.liq - a.liq);
        if (withLp.length) return Math.min(100, Math.round(withLp[0].pct * 100) / 100);
        const fraction = toNumber(rugRaw && rugRaw.lpLockedPct);
        return fraction === null ? null : Math.min(100, Math.round(fraction * 10000) / 100);
      })(),
      launchpad: (() => {
        const lp = rugRaw && rugRaw.launchpad;
        if (!lp) return null;
        return typeof lp === "string" ? lp : (lp.name || lp.id || null);
      })(),
      creatorOtherTokens: rugRaw && Array.isArray(rugRaw.creatorTokens) ? rugRaw.creatorTokens.length : null,
      insidersDetected: rugRaw ? Boolean(rugRaw.graphInsidersDetected) : null,
    },
    holders: {
      count: holderCount,
      goplusCount: goPlusHolders,
      rugcheckCount: rugHolders,
      sourcesDisagree: goPlusHolders !== null && rugHolders !== null && goPlusHolders !== rugHolders,
      jupiterCount: jupHolders,
      topHolderSharePct: topHolderShare(gpRecord),
      jupiterTopHoldersPct: jupToken && jupToken.audit ? jupToken.audit.topHoldersPercentage : null,
      totalLpProviders: toNumber(rugRaw && rugRaw.totalLPProviders),
      growth: holderGrowth(chain.key, tokenAddress),
      changePct1h: jupToken && jupToken.stats1h ? jupToken.stats1h.holderChangePct : null,
      changePct24h: jupToken && jupToken.stats24h ? jupToken.stats24h.holderChangePct : null,
    },
    impact: impact || {
      tradeUsd: IMPACT_TRADE_USD, priceImpactPct: null, routes: null, source: null,
      note: "No keyless router for this chain",
    },
    honeypot: honeypot,
    priceCrossCheck: llama ? {
      llamaPriceUsd: llama.priceUsd,
      confidence: llama.confidence,
      feedPriceUsd: row ? row.priceUsd : null,
      deltaPct: llamaDeltaPct,
      source: SOURCES.DEFILLAMA,
    } : null,
    supply: jupToken ? {
      circulating: jupToken.circSupply, total: jupToken.totalSupply, source: SOURCES.JUPITER,
    } : null,
    jupiter: jupToken,
    flow: {
      tradesPerBuyer24h: tradesPerBuyer !== null ? Math.round(tradesPerBuyer * 100) / 100 : null,
      volumePerHolderUsd: volumePerHolder !== null ? Math.round(volumePerHolder) : null,
      volumeToLiquidity24h: row ? row.volumeToLiquidity24h : null,
      buyers24h: buyers24h,
      buys24h: buys24h,
      organicScore: jupToken ? jupToken.organicScore : null,
      organicSharePct24h: jupToken && jupToken.stats24h ? jupToken.stats24h.organicSharePct : null,
      netUsd5m: jupToken && jupToken.stats5m ? jupToken.stats5m.netUsd : null,
      notes: flowNotes,
      concernCount: flowNotes.length,
    },
  };
}

function bucketBaselines(trades) {
  if (!trades || trades.length < 20) return { samples: 0, metrics: {} };
  const withTime = trades.filter((t) => t.at).sort((a, b) => a.at - b.at);
  if (withTime.length < 20) return { samples: 0, metrics: {} };
  const bucketMs = 5 * 60 * 1000;
  const start = withTime[0].at;
  const buckets = new Map();
  withTime.forEach((t) => {
    const idx = Math.floor((t.at - start) / bucketMs);
    let b = buckets.get(idx);
    if (!b) { b = { volume: 0, buys: 0, buyers: new Set() }; buckets.set(idx, b); }
    b.volume += t.usd;
    if (t.kind === "buy") { b.buys += 1; b.buyers.add(t.wallet); }
  });
  const ordered = [...buckets.keys()].sort((a, b) => a - b).map((k) => buckets.get(k));
  if (ordered.length < 3) return { samples: ordered.length, metrics: {} };

  const build = (code, values) => {
    const current = values[values.length - 1];
    const history = values.slice(0, -1);
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((a, b) => a + (b - mean) * (b - mean), 0) / history.length;
    const stdev = Math.sqrt(variance);
    return {
      code: code, value: current,
      mean: Math.round(mean * 1000) / 1000,
      stdev: Math.round(stdev * 1000) / 1000,
      z: stdev > 0 ? Math.round(((current - mean) / stdev) * 100) / 100 : null,
      multiple: mean > 0 ? Math.round((current / mean) * 100) / 100 : null,
      samples: history.length,
    };
  };
  return {
    samples: ordered.length,
    windowMs: withTime[withTime.length - 1].at - start,
    source: "pool trades bucketed into 5m windows",
    metrics: {
      volume5mUsd: build("VOL_ANOM_5M", ordered.map((b) => b.volume)),
      buys5m: build("TRADE_ACTIVITY_5M", ordered.map((b) => b.buys)),
      buyers5m: build("BUYER_BREADTH_5M", ordered.map((b) => b.buyers.size)),
    },
  };
}

async function resolveTokenAddress(chain, tokenAddress) {
  try {
    const d = await fetchJson(DS_BASE + "/latest/dex/tokens/" + encodeURIComponent(tokenAddress));
    const pairs = (d && d.pairs) || [];
    const match = pairs.find((p) =>
      p && p.baseToken && p.baseToken.address &&
      p.baseToken.address.toLowerCase() === tokenAddress.toLowerCase());
    return match ? match.baseToken.address : null;
  } catch (error) {
    return null;
  }
}

async function resolvePoolAddress(chain, poolAddress) {
  try {
    const d = await fetchJson(DS_BASE + "/latest/dex/pairs/" + chain.ds + "/" +
      encodeURIComponent(poolAddress));
    const pair = (d && d.pairs && d.pairs[0]) || (d && d.pair) || null;
    return pair && pair.pairAddress ? pair.pairAddress : null;
  } catch (error) {
    return null;
  }
}

async function scorePoolOnDemand(chain, poolAddress) {
  const fetchedAt = Date.now();
  const gtPool = (address) => fetchJson(GT_BASE + "/networks/" + chain.gt + "/pools/" +
    encodeURIComponent(address) + "?include=base_token,quote_token,dex");

  let payload = null;
  try {
    payload = await gtPool(poolAddress);
  } catch (error) {
    if (error.status !== 404) throw error;
    const resolved = await resolvePoolAddress(chain, poolAddress);
    if (!resolved || resolved === poolAddress) throw error;
    poolAddress = resolved;
    payload = await gtPool(poolAddress);
  }
  const pool = payload && payload.data;
  if (!pool) throw new Error("pool not found on GeckoTerminal");
  const included = indexIncluded(payload);

  const baseTokenId = pool.relationships && pool.relationships.base_token &&
    pool.relationships.base_token.data ? pool.relationships.base_token.data.id : null;
  const tokenAddress = splitGtId(baseTokenId).address;

  const dexPairs = await fetchDexScreenerTokens([tokenAddress]).catch(() => []);
  const dexPairsByToken = new Map();
  dexPairs.forEach((pair) => {
    if (pair && pair.chainId && pair.chainId !== chain.ds) return;
    const address = pair && pair.baseToken && pair.baseToken.address;
    if (!address) return;
    const key = address.toLowerCase();
    if (!dexPairsByToken.has(key)) dexPairsByToken.set(key, []);
    dexPairsByToken.get(key).push(pair);
  });

  const row = Object.assign({ rank: 1 },
    buildRow(pool, included, chain, dexPairsByToken, fetchedAt));

  const trades = await fetchPoolTrades(chain, poolAddress).catch(() => []);
  const tradeStats = tradeStatsFrom(trades);
  const zScores = bucketBaselines(trades);
  const intel = await fetchTokenIntel(chain, row.tokenAddress, row).catch(() => null);
  const usdReference = await usdReferenceFor(row.quoteSymbol).catch(() => null);

  const scored = scoreRow(row, {
    zScores: zScores, tradeStats: tradeStats, rotation: rotationFor(chain.key, poolAddress),
    usdReference: usdReference, intel: intel, jupiter: intel ? intel.jupiter : null,
  });

  return Object.assign({ server: "ok", pool: poolAddress, fetchedAt: fetchedAt },
    row, scored, { zScores: zScores, tradeStats: tradeStats, intel: intel });
}

async function handleScore(url, response) {
  const chain = resolveChain(url.searchParams.get("chain"));
  const pool = (url.searchParams.get("pool") || "").trim();
  if (!chain || !pool) {
    sendJson(response, 400, { server: "error", error: "chain and pool are required" });
    return;
  }
  try {
    const data = await cached("score:" + chain.key + ":" + pool, 60000,
      () => scorePoolOnDemand(chain, pool));
    sendJson(response, 200, data);
  } catch (error) {
    sendJson(response, 502, { server: "error", error: error.message });
  }
}

const OBSERVATION_GAP_MS = Number(process.env.OBSERVATION_GAP_MS || 60000);
const OBSERVATION_MAX = Number(process.env.OBSERVATION_MAX || 400);
const observationStore = new Map();

function recordObservations(chainKey, rows) {
  const now = Date.now();
  rows.forEach((row) => {
    if (!row.tokenAddress || !Number.isFinite(row.priceUsd)) return;
    const key = chainKey + ":" + row.tokenAddress;
    const series = observationStore.get(key) || [];
    const last = series[series.length - 1];
    if (last && now - last.t < OBSERVATION_GAP_MS) return;
    series.push({
      t: now,
      stage: row.stage,
      score: row.score,
      flags: (row.riskFlags || []).map((f) => f.code),
      price: row.priceUsd,
      liquidity: row.liquidityUsd,
      symbol: row.symbol,
    });
    if (series.length > OBSERVATION_MAX) series.shift();
    observationStore.set(key, series);
  });
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function evaluationFor(chainKey, horizonMs) {
  const buckets = {};
  const now = Date.now();
  let matured = 0;
  let pending = 0;

  observationStore.forEach((series, key) => {
    if (!key.startsWith(chainKey + ":")) return;
    const latest = series[series.length - 1];
    series.forEach((obs, index) => {
      const age = now - obs.t;
      if (age < horizonMs) { pending += 1; return; }
      const target = series.find((s) => s.t >= obs.t + horizonMs);
      if (!target || !obs.price) return;
      matured += 1;
      const ret = ((target.price - obs.price) / obs.price) * 100;
      const forward = series.slice(index).filter((s) => s.t <= obs.t + horizonMs);
      const mfe = forward.length
        ? ((Math.max.apply(null, forward.map((s) => s.price)) - obs.price) / obs.price) * 100 : null;
      const liquidityDrop = obs.liquidity && latest.liquidity
        ? (latest.liquidity - obs.liquidity) / obs.liquidity : null;

      const bucket = buckets[obs.stage] || (buckets[obs.stage] = {
        stage: obs.stage, alerts: 0, returns: [], mfes: [], rugs: 0,
      });
      bucket.alerts += 1;
      bucket.returns.push(ret);
      if (mfe !== null) bucket.mfes.push(mfe);
      if (liquidityDrop !== null && liquidityDrop < -0.8) bucket.rugs += 1;
    });
  });

  const order = ["EXCEPTIONAL", "CONFIRMED", "EMERGING", "WATCH"];
  const rows = order.filter((s) => buckets[s]).map((s) => {
    const b = buckets[s];
    const wins = b.returns.filter((r) => r > 0).length;
    return {
      stage: s,
      alerts: b.alerts,
      precision: b.alerts ? Math.round((wins / b.alerts) * 100) / 100 : null,
      medianReturnPct: Math.round(median(b.returns) * 100) / 100,
      medianMfePct: b.mfes.length ? Math.round(median(b.mfes) * 100) / 100 : null,
      rugRate: b.alerts ? Math.round((b.rugs / b.alerts) * 100) / 100 : null,
    };
  });

  return {
    horizonMs: horizonMs,
    maturedObservations: matured,
    pendingObservations: pending,
    tokensTracked: [...observationStore.keys()].filter((k) => k.startsWith(chainKey + ":")).length,
    oldestObservationMs: (() => {
      let oldest = null;
      observationStore.forEach((series, key) => {
        if (!key.startsWith(chainKey + ":") || !series.length) return;
        if (oldest === null || series[0].t < oldest) oldest = series[0].t;
      });
      return oldest ? now - oldest : 0;
    })(),
    rows: rows,
  };
}

const mentionHistory = new Map();
const MENTION_MAX = 120;

function recordMentions(chainKey, rows) {
  const now = Date.now();
  rows.forEach((r) => {
    if (!r.countable) return;
    const key = chainKey + ":" + r.symbol;
    const series = mentionHistory.get(key) || [];
    const last = series[series.length - 1];
    if (last && now - last.t < 60000) return;
    series.push({ t: now, n: r.mentions });
    if (series.length > MENTION_MAX) series.shift();
    mentionHistory.set(key, series);
  });
}

function mentionBaseline(chainKey, symbol, current) {
  const series = mentionHistory.get(chainKey + ":" + symbol) || [];
  if (series.length < 4) return { baseline: null, vsBase: null, z: null, samples: series.length };
  const history = series.slice(0, -1).map((s) => s.n);
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((a, b) => a + (b - mean) * (b - mean), 0) / history.length;
  const stdev = Math.sqrt(variance);
  return {
    baseline: Math.round(mean * 100) / 100,
    vsBase: mean > 0 ? Math.round((current / mean) * 100) / 100 : null,
    z: stdev > 0 ? Math.round(((current - mean) / stdev) * 100) / 100 : null,
    samples: history.length,
  };
}

function evaluationReport(chainKey) {
  const h1 = evaluationFor(chainKey, 3600000);
  const h24 = evaluationFor(chainKey, 86400000);
  const byStage = {};
  h1.rows.forEach((r) => { byStage[r.stage] = Object.assign({}, r, { medianReturn1hPct: r.medianReturnPct }); });
  h24.rows.forEach((r) => {
    byStage[r.stage] = Object.assign({ stage: r.stage }, byStage[r.stage] || {},
      { medianReturn24hPct: r.medianReturnPct, alerts24h: r.alerts });
  });

  const buckets = [[0, 55], [55, 70], [70, 85], [85, 101]];
  const calibration = buckets.map(([lo, hi]) => ({ band: lo + "-" + (hi - 1), lo: lo, hi: hi, n: 0, returns: [] }));
  const causeCounts = {};
  const now = Date.now();

  observationStore.forEach((series, key) => {
    if (!key.startsWith(chainKey + ":")) return;
    series.forEach((obs) => {
      if (now - obs.t < 3600000) return;
      const target = series.find((s) => s.t >= obs.t + 3600000);
      if (!target || !obs.price) return;
      const ret = ((target.price - obs.price) / obs.price) * 100;
      const bucket = calibration.find((b) => obs.score >= b.lo && obs.score < b.hi);
      if (bucket) { bucket.n += 1; bucket.returns.push(ret); }
      if (ret < 0 && Array.isArray(obs.flags)) {
        obs.flags.forEach((code) => { causeCounts[code] = (causeCounts[code] || 0) + 1; });
      }
    });
  });

  return {
    stages: Object.keys(byStage).map((s) => byStage[s]),
    horizons: { short: h1, long: h24 },
    calibration: calibration.map((b) => ({
      band: b.band, observations: b.n,
      medianReturnPct: b.returns.length ? Math.round(median(b.returns) * 100) / 100 : null,
      winRate: b.returns.length
        ? Math.round((b.returns.filter((r) => r > 0).length / b.returns.length) * 100) / 100 : null,
    })),
    falsePositiveCauses: Object.keys(causeCounts)
      .map((code) => ({ code: code, count: causeCounts[code] }))
      .sort((a, b) => b.count - a.count).slice(0, 6),
  };
}

function walletRegistryFor(chainKey, filterAddress) {
  const wallets = new Map();
  walletSets.forEach((entry, key) => {
    if (!key.startsWith(chainKey + ":")) return;
    const pool = key.slice(chainKey.length + 1);
    entry.wallets.forEach((usd, address) => {
      const w = wallets.get(address) || { address: address, usd: 0, pools: new Set(), symbols: new Set() };
      w.usd += usd;
      w.pools.add(pool);
      if (entry.symbol) w.symbols.add(entry.symbol);
      wallets.set(address, w);
    });
  });

  let list = [...wallets.values()].map((w) => ({
    address: w.address,
    volumeUsd: Math.round(w.usd),
    poolsTouched: w.pools.size,
    symbols: [...w.symbols],
    label: w.pools.size >= 3 ? "MULTI-POOL" : w.pools.size === 2 ? "CROSS-POOL" : "SINGLE-POOL",
  }));

  if (filterAddress) {
    const needle = filterAddress.toLowerCase();
    list = list.filter((w) => w.address.toLowerCase() === needle);
  }
  list.sort((a, b) => b.poolsTouched - a.poolsTouched || b.volumeUsd - a.volumeUsd);

  return {
    poolsSampled: [...walletSets.keys()].filter((k) => k.startsWith(chainKey + ":")).length,
    walletsSeen: wallets.size,
    multiPool: list.filter((w) => w.poolsTouched > 1).length,
    rows: list.slice(0, 60),
  };
}

function rotationGraphFor(chainKey) {
  const pools = [...walletSets.entries()].filter(([key]) => key.startsWith(chainKey + ":"));
  const edges = [];
  for (let i = 0; i < pools.length; i++) {
    for (let k = i + 1; k < pools.length; k++) {
      const [keyA, a] = pools[i];
      const [keyB, b] = pools[k];
      let shared = 0;
      let usd = 0;
      a.wallets.forEach((usdA, wallet) => {
        if (b.wallets.has(wallet)) { shared += 1; usd += usdA + b.wallets.get(wallet); }
      });
      if (shared) {
        edges.push({
          from: a.symbol || keyA.slice(chainKey.length + 1, chainKey.length + 9),
          to: b.symbol || keyB.slice(chainKey.length + 1, chainKey.length + 9),
          sharedWallets: shared,
          combinedUsd: Math.round(usd),
        });
      }
    }
  }
  edges.sort((x, y) => y.combinedUsd - x.combinedUsd);

  const nodes = pools.map(([key, entry]) => {
    const inbound = edges.filter((e) => e.from === entry.symbol || e.to === entry.symbol);
    return {
      symbol: entry.symbol,
      wallets: entry.wallets.size,
      connections: inbound.length,
      sharedUsd: inbound.reduce((s, e) => s + e.combinedUsd, 0),
      sampledAt: entry.at,
    };
  }).sort((a, b) => b.sharedUsd - a.sharedUsd);

  return { poolsSampled: pools.length, nodes: nodes, edges: edges.slice(0, 40) };
}

const BIZ_CATALOG = "https://a.4cdn.org/biz/catalog.json";
const SOCIAL_TTL_MS = Number(process.env.SOCIAL_TTL_MS || 300000);

function fetchBizThreads() {
  return cached("biz:catalog", SOCIAL_TTL_MS, async () => {
    const pages = await fetchJson(BIZ_CATALOG);
    const threads = (Array.isArray(pages) ? pages : []).flatMap((p) => p.threads || []);
    return threads.map((t) => ({
      no: t.no,
      text: ((t.sub || "") + " " + (t.com || "")).replace(/<[^>]+>/g, " "),
      replies: t.replies || 0,
      time: (t.time || 0) * 1000,
    }));
  });
}

const SOCIAL_STOPWORDS = new Set([
  "THE", "AND", "FOR", "ALL", "NEW", "TOP", "BUY", "SELL", "USD", "USDC", "USDT",
  "SOL", "ETH", "BTC", "WIF", "CAT", "DOG", "PUMP", "MOON", "BULL", "BEAR",
]);

function mentionsFor(threads, symbol) {
  const clean = String(symbol || "").replace(/[^A-Za-z0-9]/g, "");
  if (clean.length < 3 || SOCIAL_STOPWORDS.has(clean.toUpperCase())) {
    return { countable: false, mentions: 0, threads: 0, replies: 0, reason: "symbol too generic to match safely" };
  }
  const re = new RegExp("(\$" + clean + "\\b)|(\\b" + clean + "\\b)", "i");
  const hits = threads.filter((t) => re.test(t.text));
  const newest = hits.slice().sort((x, y) => y.time - x.time)[0];
  return {
    countable: true,
    excerpt: newest ? newest.text.replace(/\s+/g, " ").trim().slice(0, 120) : null,
    mentions: hits.length,
    threads: hits.length,
    replies: hits.reduce((s, t) => s + t.replies, 0),
    newestMs: hits.length ? Math.max.apply(null, hits.map((t) => t.time)) : null,
  };
}

function promotionScanner(chain, rows) {
  return cached("promo:" + chain.key, 120000, async () => {
    const [boosts, profiles] = await Promise.all([
      fetchJson(DS_BASE + "/token-boosts/top/v1").catch(() => []),
      fetchJson(DS_BASE + "/token-profiles/latest/v1").catch(() => []),
    ]);
    const onChain = new Map((rows || []).map((r) => [String(r.tokenAddress || "").toLowerCase(), r]));
    const shape = (entry, kind) => {
      const address = String(entry.tokenAddress || "").toLowerCase();
      const match = onChain.get(address);
      return {
        kind: kind,
        chain: entry.chainId,
        tokenAddress: entry.tokenAddress,
        description: (entry.description || "").slice(0, 140),
        links: (entry.links || []).filter((l) => l && l.url).map((l) => ({ type: l.type || "link", url: l.url })),
        amount: entry.amount != null ? entry.amount : null,
        totalAmount: entry.totalAmount != null ? entry.totalAmount : null,
        onBoard: Boolean(match),
        symbol: match ? match.symbol : null,
        score: match ? match.score : null,
      };
    };
    const list = []
      .concat((Array.isArray(boosts) ? boosts : []).filter((b) => b.chainId === chain.ds).map((b) => shape(b, "BOOST")))
      .concat((Array.isArray(profiles) ? profiles : []).filter((p) => p.chainId === chain.ds).map((p) => shape(p, "PROFILE")));
    return {
      chain: chain.key,
      counts: { boosts: list.filter((l) => l.kind === "BOOST").length,
                profiles: list.filter((l) => l.kind === "PROFILE").length,
                matchedOnBoard: list.filter((l) => l.onBoard).length },
      rows: list.slice(0, 40),
    };
  });
}

async function boardRowsFor(chain) {
  const data = await cached("market:" + chain.key + ":trending:" + MAX_ROWS, CACHE_TTL_MS,
    () => buildMarketData({ chain: chain, tokenAddress: null, feed: "trending", limit: MAX_ROWS }));
  return data.rows || [];
}

async function handleRotation(url, response) {
  const chain = resolveChain(url.searchParams.get("chain"));
  if (!chain) { sendJson(response, 400, { server: "error", error: "unknown chain" }); return; }
  try {
    await boardRowsFor(chain);
    sendJson(response, 200, Object.assign({ server: "ok", chain: chain.key }, rotationGraphFor(chain.key)));
  } catch (error) {
    sendJson(response, 502, { server: "error", error: error.message });
  }
}

async function handleWallets(url, response) {
  const chain = resolveChain(url.searchParams.get("chain"));
  if (!chain) { sendJson(response, 400, { server: "error", error: "unknown chain" }); return; }
  const address = (url.searchParams.get("address") || "").trim() || null;
  try {
    await boardRowsFor(chain);
    sendJson(response, 200, Object.assign({ server: "ok", chain: chain.key },
      walletRegistryFor(chain.key, address)));
  } catch (error) {
    sendJson(response, 502, { server: "error", error: error.message });
  }
}

async function handleSocial(url, response) {
  const chain = resolveChain(url.searchParams.get("chain"));
  if (!chain) { sendJson(response, 400, { server: "error", error: "unknown chain" }); return; }
  try {
    const rows = await boardRowsFor(chain);
    const data = await promotionScanner(chain, rows);

    let threads = [];
    let socialError = null;
    try { threads = await fetchBizThreads(); }
    catch (error) { socialError = error.message; }

    const mentions = rows.map((row) => {
      const m = mentionsFor(threads, row.symbol);
      return {
        symbol: row.symbol,
        tokenAddress: row.tokenAddress,
        score: row.score,
        stage: row.stage,
        countable: m.countable,
        reason: m.reason || null,
        mentions: m.mentions,
        replies: m.replies,
        newestMs: m.newestMs || null,
        excerpt: m.excerpt || null,
        boosted: (data.rows || []).some((p) =>
          String(p.tokenAddress || "").toLowerCase() === String(row.tokenAddress || "").toLowerCase()),
      };
    }).sort((x, y) => y.mentions - x.mentions || y.replies - x.replies);

    recordMentions(chain.key, mentions);
    mentions.forEach((m) => {
      const base = mentionBaseline(chain.key, m.symbol, m.mentions);
      m.baseline = base.baseline;
      m.vsBase = base.vsBase;
      m.z = base.z;
      m.baselineSamples = base.samples;
    });

    sendJson(response, 200, Object.assign({ server: "ok" }, data, {
      social: {
        source: "4chan /biz/ public catalog",
        threadsScanned: threads.length,
        error: socialError,
        countable: mentions.filter((m) => m.countable).length,
        withMentions: mentions.filter((m) => m.mentions > 0).length,
        rows: mentions,
        absent: "X/Twitter and Telegram require paid API keys; Reddit blocks unauthenticated JSON (403).",
      },
    }));
  } catch (error) {
    sendJson(response, 502, { server: "error", error: error.message });
  }
}

async function handleEvaluation(url, response) {
  const chain = resolveChain(url.searchParams.get("chain"));
  if (!chain) { sendJson(response, 400, { server: "error", error: "unknown chain" }); return; }
  const horizonMs = Math.min(Math.max(Number(url.searchParams.get("horizonMs")) || 3600000, 60000), 86400000);
  try {
    await boardRowsFor(chain);
    sendJson(response, 200, Object.assign({ server: "ok", chain: chain.key },
      evaluationFor(chain.key, horizonMs), { report: evaluationReport(chain.key) }));
  } catch (error) {
    sendJson(response, 502, { server: "error", error: error.message });
  }
}

function handleSystem(url, response) {
  const now = Date.now();
  const minutes = Math.max((now - upstreamCalls.since) / 60000, 1 / 60);
  const providers = Object.keys(upstreamLatency).map((host) => {
    const l = upstreamLatency[host];
    const samples = l.samples.slice().sort((a, b) => a - b);
    const p50 = samples.length ? samples[samples.length >> 1] : null;
    const p95 = samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] : null;
    const errorRate = l.calls ? l.errors / l.calls : 0;
    return {
      provider: host,
      calls: l.calls,
      callsPerMinute: Math.round((l.calls / minutes) * 10) / 10,
      errors: l.errors,
      errorRatePct: Math.round(errorRate * 1000) / 10,
      lastError: l.lastError,
      p50Ms: p50,
      p95Ms: p95,
      status: errorRate > 0.25 ? "DEGRADED" : errorRate > 0 ? "PARTIAL" : "OK",
    };
  }).sort((a, b) => b.calls - a.calls);

  sendJson(response, 200, {
    server: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    windowSeconds: Math.round((now - upstreamCalls.since) / 1000),
    providers: providers,
    cache: {
      entries: cacheStore.size,
      inflight: inflight.size,
      historyPools: historyStore.size,
      walletSetsSampled: walletSets.size,
      observationTokens: observationStore.size,
      holderSeries: holderHistory.size,
      stagesTracked: stageStore.size,
      persistent: store.enabled,
      lastFlushAt: store.stats.lastFlushAt,
      storeWrites: store.stats.writes,
    },
    limits: {
      geckoterminalPerMinute: 30,
      dexscreenerPerMinute: 300,
      note: "Free-tier ceilings; callsPerMinute above is measured, not assumed.",
    },
  });
}

async function handleIntel(url, response) {
  const chain = resolveChain(url.searchParams.get("chain"));
  let token = (url.searchParams.get("token") || "").trim();
  if (!chain || !token) {
    sendJson(response, 400, { server: "error", error: "chain and token are required" });
    return;
  }
  const pool = (url.searchParams.get("pool") || "").trim();
  try {
    if (chain.key === "solana" && token === token.toLowerCase()) {
      const resolved = await resolveTokenAddress(chain, token);
      if (resolved) token = resolved;
    }
    const market = await cached("market:" + chain.key + ":trending:" + MAX_ROWS, CACHE_TTL_MS,
      () => buildMarketData({ chain: chain, tokenAddress: null, feed: "trending", limit: MAX_ROWS }));
    const row = (market.rows || []).find((r) =>
      r.tokenAddress === token || (pool && r.poolAddress === pool)) || null;
    const data = await cached("intel:" + chain.key + ":" + token, INTEL_CACHE_TTL_MS,
      () => fetchTokenIntel(chain, token, row));

    let tradeStats = null;
    if (row && row.poolAddress) {
      try {
        tradeStats = tradeStatsFrom(await fetchPoolTrades(chain, row.poolAddress));
      } catch (error) { tradeStats = null; }
    }
    const usdReference = row ? await usdReferenceFor(row.quoteSymbol).catch(() => null) : null;
    const zScores = row ? zScoresFor(chain.key, row) : { samples: 0, metrics: {} };
    const rotation = row ? rotationFor(chain.key, row.poolAddress) : null;
    const scored = row ? scoreRow(row, {
      zScores: zScores, tradeStats: tradeStats, rotation: rotation,
      usdReference: usdReference, intel: data, jupiter: data ? data.jupiter : null,
    }) : null;

    sendJson(response, 200, Object.assign({}, data, {
      zScores: zScores,
      tradeStats: tradeStats,
      rotation: rotation,
      usdReference: usdReference,
      scored: scored,
    }));
  } catch (error) {
    sendJson(response, 502, { server: "error", error: error.message });
  }
}

const OHLCV_TIMEFRAMES = Object.freeze({ minute: true, hour: true, day: true });

async function handleOhlcv(url, response) {
  const chain = resolveChain(url.searchParams.get("chain"));
  const pool = (url.searchParams.get("pool") || "").trim();
  if (!chain || !pool) {
    sendJson(response, 400, { server: "error", error: "chain and pool are required" });
    return;
  }
  const timeframe = OHLCV_TIMEFRAMES[url.searchParams.get("timeframe")]
    ? url.searchParams.get("timeframe") : "minute";
  const aggregate = Math.min(Math.max(Number(url.searchParams.get("aggregate")) || 1, 1), 60);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 60, 1), 300);

  const key = "ohlcv:" + chain.gt + ":" + pool + ":" + timeframe + ":" + aggregate + ":" + limit;
  try {
    const data = await cached(key, 30000, async () => {
      const target = (address) => GT_BASE + "/networks/" + chain.gt + "/pools/" +
        encodeURIComponent(address) + "/ohlcv/" + timeframe +
        "?aggregate=" + aggregate + "&limit=" + limit;
      let payload;
      try {
        payload = await fetchJson(target(pool));
      } catch (error) {
        if (error.status !== 404) throw error;
        const resolved = await resolvePoolAddress(chain, pool);
        if (!resolved || resolved === pool) throw error;
        payload = await fetchJson(target(resolved));
      }
      const list = payload && payload.data && payload.data.attributes &&
        payload.data.attributes.ohlcv_list;
      const bars = (Array.isArray(list) ? list : []).slice().reverse().map((b) => ({
        t: toTimestampMs(b[0]),
        o: toNumber(b[1]),
        h: toNumber(b[2]),
        l: toNumber(b[3]),
        c: toNumber(b[4]),
        v: toNumber(b[5]),
      }));
      return { server: "ok", chain: chain.key, pool: pool, timeframe: timeframe,
        aggregate: aggregate, source: SOURCES.GECKOTERMINAL, bars: bars };
    });
    sendJson(response, 200, data);
  } catch (error) {
    sendJson(response, 502, { server: "error", bars: [], error: error.message });
  }
}

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://" + (request.headers.host || HOST));
    console.log(new Date().toISOString() + " " + request.method + " " + url.pathname + url.search);
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    // HEAD is handled like GET (Node suppresses the body), so uptime monitors
    // and load balancers that probe with HEAD do not see a 405.
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/health") {
      sendJson(response, 200, healthData());
      return;
    }

    if (url.pathname === "/api/market") {
      handleMarket(url, response);
      return;
    }

    if (url.pathname === "/api/rotation") { handleRotation(url, response); return; }
    if (url.pathname === "/api/wallets") { handleWallets(url, response); return; }
    if (url.pathname === "/api/social") { handleSocial(url, response); return; }
    if (url.pathname === "/api/evaluation") { handleEvaluation(url, response); return; }
    if (url.pathname === "/api/system") { handleSystem(url, response); return; }

    if (url.pathname === "/api/score") {
      handleScore(url, response);
      return;
    }

    if (url.pathname === "/api/intel") {
      handleIntel(url, response);
      return;
    }

    if (url.pathname === "/api/ohlcv") {
      handleOhlcv(url, response);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      sendDashboard(response);
      return;
    }

    if (serveStatic(url, response)) return;
    if (!url.pathname.startsWith("/api/") && hasFrontend()) {
      sendDashboard(response);
      return;
    }

    sendJson(response, 404, { error: "Not found", routes: ["/", "/health", "/api/market"] });
  });
}

module.exports = {
  PORT,
  HOST,
  SOURCES,
  CHAINS,
  FEEDS,
  createServer,
  emptyMarketData,
  healthData,
  resolveChain,
  buildMarketData,
  createNormalizedResult,
  normalizeBirdeye,
  normalizeDexScreener,
  normalizeGeckoTerminal,
  normalizeGoPlus,
};

if (require.main === module) {
  const server = createServer();
  const stores = { historyStore, stageStore, holderHistory };

  // Restore the series this process would otherwise start empty, then prune
  // anything stale enough to distort a baseline.
  store.load(stores).then((result) => {
    if (!result.enabled) {
      console.log("Store:       RAM only (set FIREBASE_SERVICE_ACCOUNT to persist across restarts)");
      return;
    }
    pruneHistory();
    console.log("Store:       Firestore restored " + result.pools + " pool histories, " +
      result.stages + " stages, " + result.holders + " holder series");
    store.startAutoFlush(stores);
  }).catch((error) => console.error("store: load failed -", error.message));

  server.listen(PORT, HOST, () => {
    const shown = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
    console.log("VibeScreener server listening on " + HOST + ":" + PORT);
    console.log("Live sources: geckoterminal + dexscreener (both keyless)");
    console.log("Frontend:    " + (hasFrontend()
      ? "http://" + shown + ":" + PORT + "/"
      : "not bundled (API-only mode) - serve the React build separately"));
    console.log("API:         http://" + shown + ":" + PORT + "/api/market?chain=solana&feed=trending");
    console.log("Health:      http://" + shown + ":" + PORT + "/health");
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error("Port " + PORT + " is already in use. Set PORT to a free port.");
    } else {
      console.error("Server error:", error.message);
    }
    process.exit(1);
  });

  // Render and most container hosts stop a service with SIGTERM - including
  // when a free instance is put to sleep. Flushing here means the buffered
  // samples survive the sleep instead of dying with the process.
  const shutdown = (signal) => () => {
    console.log("Received " + signal + ", shutting down.");
    store.stopAutoFlush();
    const done = () => server.close(() => process.exit(0));
    store.flush(stores, signal.toLowerCase()).then(done).catch(done);
    setTimeout(() => process.exit(0), 15000).unref();
  };
  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("SIGINT", shutdown("SIGINT"));
}
