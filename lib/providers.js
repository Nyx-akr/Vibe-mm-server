"use strict";

/**
 * Every upstream provider, and nothing else.
 *
 * The rule in this file: pick fields out of a provider payload into a stable
 * name, and stop. No ratios, no ages, no deltas, no blending of one provider
 * against another, no scores. Where two providers answer the same question,
 * BOTH answers are forwarded side by side under `sources` and the app decides
 * which to trust.
 *
 * Coercing "1.5" to 1.5 and an ISO date to epoch ms is parsing, not maths, so
 * that much happens here.
 */

const { GT_BASE, DS_BASE, FEEDS } = require("./chains");
const { fetchJson, cached, toNumber, toTimestampMs } = require("./fetcher");

const SOURCES = Object.freeze({
  DEXSCREENER: "dexscreener",
  GECKOTERMINAL: "geckoterminal",
  GOPLUS: "goplus",
  JUPITER: "jupiter",
  RUGCHECK: "rugcheck",
  KYBERSWAP: "kyberswap",
  HONEYPOT: "honeypot.is",
  DEFILLAMA: "defillama",
});

const GT_LIST_TTL_MS = Number(process.env.GT_LIST_TTL_MS || 180000);
const GT_CACHE_TTL_MS = Number(process.env.GT_CACHE_TTL_MS || 60000);
const DS_CACHE_TTL_MS = Number(process.env.DS_CACHE_TTL_MS || 1000);
const TRADES_CACHE_TTL_MS = Number(process.env.TRADES_CACHE_TTL_MS || 180000);
const JUP_CACHE_TTL_MS = Number(process.env.JUP_CACHE_TTL_MS || 30000);
const JUP_BATCH = Number(process.env.JUP_BATCH || 40);
const IMPACT_TRADE_USD = Number(process.env.IMPACT_TRADE_USD || 10000);

/* ------------------------------------------------- GeckoTerminal: pool list */

function indexIncluded(payload) {
  const included = (payload && payload.included) || [];
  return new Map(included.map((item) => [item.type + ":" + item.id, item]));
}

function splitGtId(id) {
  const raw = String(id || "");
  const idx = raw.indexOf("_");
  return idx === -1
    ? { network: null, address: raw || null }
    : { network: raw.slice(0, idx), address: raw.slice(idx + 1) };
}

const lastGoodFeed = new Map();

/**
 * Which pools exist is GeckoTerminal's job and changes slowly, so the list is
 * cached while DexScreener re-prices on every request. When GT rate-limits,
 * the previous list is served rather than blanking the chain.
 */
function fetchPoolList(chain, feed) {
  const build = FEEDS[feed] || FEEDS.trending;
  const key = chain.gt + ":" + feed;
  return cached("gt:feed:" + key, GT_LIST_TTL_MS, async () => {
    try {
      const payload = await fetchJson(build(chain.gt));
      const result = {
        pools: Array.isArray(payload && payload.data) ? payload.data : [],
        included: indexIncluded(payload),
        listFetchedAt: Date.now(),
        stale: false,
        staleReason: null,
      };
      if (result.pools.length) lastGoodFeed.set(key, result);
      return result;
    } catch (error) {
      const previous = lastGoodFeed.get(key);
      if (previous) return Object.assign({}, previous, { stale: true, staleReason: error.message });
      throw error;
    }
  });
}

async function resolvePoolAddress(chain, poolAddress) {
  try {
    const payload = await fetchJson(GT_BASE + "/search/pools?query=" +
      encodeURIComponent(poolAddress) + "&network=" + chain.gt);
    const first = payload && payload.data && payload.data[0];
    return first ? (first.attributes && first.attributes.address) || null : null;
  } catch (error) { return null; }
}

async function resolveTokenAddress(chain, tokenAddress) {
  try {
    const payload = await fetchJson(GT_BASE + "/search/pools?query=" +
      encodeURIComponent(tokenAddress) + "&network=" + chain.gt);
    const first = payload && payload.data && payload.data[0];
    if (!first) return null;
    const base = first.relationships && first.relationships.base_token &&
      first.relationships.base_token.data ? first.relationships.base_token.data.id : null;
    return splitGtId(base).address;
  } catch (error) { return null; }
}

/* ------------------------------------------- GeckoTerminal: field selection */

/** GT pool attributes to named fields. Nothing combined, nothing derived. */
function gtPoolFields(attributes) {
  const a = attributes || {};
  const vol = a.volume_usd || {};
  const chg = a.price_change_percentage || {};
  const tx = a.transactions || {};
  const win = (w) => ({
    buys: toNumber((tx[w] || {}).buys),
    sells: toNumber((tx[w] || {}).sells),
    buyers: toNumber((tx[w] || {}).buyers),
    sellers: toNumber((tx[w] || {}).sellers),
  });
  return {
    priceUsd: toNumber(a.base_token_price_usd),
    quoteTokenPriceUsd: toNumber(a.quote_token_price_usd),
    liquidityUsd: toNumber(a.reserve_in_usd),
    marketCapUsd: toNumber(a.market_cap_usd),
    fdvUsd: toNumber(a.fdv_usd),
    volumeUsd: {
      m5: toNumber(vol.m5), h1: toNumber(vol.h1), h6: toNumber(vol.h6), h24: toNumber(vol.h24),
    },
    priceChangePct: {
      m5: toNumber(chg.m5), m15: toNumber(chg.m15), h1: toNumber(chg.h1),
      h6: toNumber(chg.h6), h24: toNumber(chg.h24),
    },
    transactions: { m5: win("m5"), m15: win("m15"), h1: win("h1"), h24: win("h24") },
    poolCreatedAt: toTimestampMs(a.pool_created_at),
  };
}

/** DexScreener pair to named fields. Same rule. */
function dsPairFields(pair) {
  const p = pair || {};
  const vol = p.volume || {};
  const chg = p.priceChange || {};
  const tx = p.txns || {};
  const win = (w) => ({ buys: toNumber((tx[w] || {}).buys), sells: toNumber((tx[w] || {}).sells) });
  return {
    priceUsd: toNumber(p.priceUsd),
    liquidityUsd: toNumber(p.liquidity && p.liquidity.usd),
    marketCapUsd: toNumber(p.marketCap),
    fdvUsd: toNumber(p.fdv),
    volumeUsd: {
      m5: toNumber(vol.m5), h1: toNumber(vol.h1), h6: toNumber(vol.h6), h24: toNumber(vol.h24),
    },
    priceChangePct: {
      m5: toNumber(chg.m5), h1: toNumber(chg.h1), h6: toNumber(chg.h6), h24: toNumber(chg.h24),
    },
    transactions: { m5: win("m5"), h1: win("h1"), h24: win("h24") },
    pairCreatedAt: toTimestampMs(p.pairCreatedAt),
  };
}

/**
 * DexScreener returns every pair for a token. Picking the pool we asked about
 * is identity matching, not a judgement; the deepest-pair fallback only runs
 * when the address is absent from the response.
 */
function pickPair(pairs, poolAddress) {
  if (!pairs || !pairs.length) return null;
  if (poolAddress) {
    const exact = pairs.find((p) =>
      String(p.pairAddress || "").toLowerCase() === String(poolAddress).toLowerCase());
    if (exact) return exact;
  }
  return pairs.slice().sort((a, b) =>
    ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
}

function fetchDexScreenerTokens(addresses) {
  if (!addresses.length) return Promise.resolve([]);
  const batches = [];
  for (let i = 0; i < addresses.length; i += 30) batches.push(addresses.slice(i, i + 30));
  return cached("ds:tokens:" + batches.join("|"), DS_CACHE_TTL_MS, async () => {
    const responses = await Promise.all(batches.map((batch) =>
      fetchJson(DS_BASE + "/latest/dex/tokens/" + batch.join(",")).catch(() => null)));
    return responses.flatMap((r) => (r && Array.isArray(r.pairs) ? r.pairs : []));
  });
}

/* ----------------------------------------------------------------- Jupiter */

const JUP_TOKEN_BASE = "https://lite-api.jup.ag/tokens/v2";
const JUPITER_SWAP = "https://lite-api.jup.ag/swap/v1";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const jupiterCache = new Map();

/**
 * Jupiter windows carry buy/sell/organic volume. The USD split, the net ratio
 * and the organic share used to be computed here; they are forwarded raw now
 * so the app owns that arithmetic.
 */
function jupiterFields(token) {
  if (!token || !token.id) return null;
  const win = (w) => {
    const s = token[w];
    if (!s) return null;
    return {
      buyVolumeUsd: toNumber(s.buyVolume),
      sellVolumeUsd: toNumber(s.sellVolume),
      buyOrganicVolumeUsd: toNumber(s.buyOrganicVolume),
      sellOrganicVolumeUsd: toNumber(s.sellOrganicVolume),
      numBuys: toNumber(s.numBuys),
      numSells: toNumber(s.numSells),
      numTraders: toNumber(s.numTraders),
      numNetBuyers: toNumber(s.numNetBuyers),
      numOrganicBuyers: toNumber(s.numOrganicBuyers),
      holderChangePct: toNumber(s.holderChange),
      priceChangePct: toNumber(s.priceChange),
      liquidityChangePct: toNumber(s.liquidityChange),
    };
  };
  const audit = token.audit || {};
  const flag = (v) => (v === undefined ? null : v);
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
      mintAuthorityDisabled: flag(audit.mintAuthorityDisabled),
      freezeAuthorityDisabled: flag(audit.freezeAuthorityDisabled),
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
          const fields = jupiterFields(token);
          if (!fields) return;
          jupiterCache.set(token.id, { at: Date.now(), data: fields });
          out.set(token.id, fields);
          seen.add(token.id);
        });
        // Cache the misses too, so unknown mints are not re-queried every refresh.
        batch.forEach((mint) => {
          if (!seen.has(mint)) jupiterCache.set(mint, { at: Date.now(), data: null });
        });
      })
      .catch(() => {})));
  return out;
}

/* ------------------------------------------------------------------ trades */

/** Wallet-level trades for one pool. Raw rows; the app aggregates them. */
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
      wallet: a.tx_from_address || null,
      kind: a.kind || null,
      usd: toNumber(a.volume_in_usd),
      at: toTimestampMs(a.block_timestamp),
    })).filter((t) => t.wallet && Number.isFinite(t.usd));
  });
}

/* ------------------------------------------------------------------- OHLCV */

const OHLCV_TIMEFRAMES = Object.freeze({ minute: true, hour: true, day: true });

async function fetchOhlcv(chain, pool, timeframe, aggregate, limit) {
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
  return (Array.isArray(list) ? list : []).slice().reverse().map((b) => ({
    t: toTimestampMs(b[0]), o: toNumber(b[1]), h: toNumber(b[2]),
    l: toNumber(b[3]), c: toNumber(b[4]), v: toNumber(b[5]),
  }));
}

/* ------------------------------------------------- safety / holders / price */

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";

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

/** Identity lookup inside the GoPlus result object - no interpretation. */
function pickGoPlusRecord(payload, tokenAddress) {
  const result = payload && payload.result;
  if (!result) return null;
  return result[tokenAddress] || result[String(tokenAddress).toLowerCase()] ||
    result[Object.keys(result)[0]] || null;
}

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

/** Routed $10k quote on Solana. Raw impact fraction; the app scales it. */
async function fetchJupiterQuote(tokenAddress) {
  const payload = await fetchJson(JUPITER_SWAP + "/quote?inputMint=" + SOLANA_USDC +
    "&outputMint=" + encodeURIComponent(tokenAddress) +
    "&amount=" + (IMPACT_TRADE_USD * 1e6) + "&slippageBps=50");
  if (!payload) return null;
  return {
    source: SOURCES.JUPITER,
    tradeUsd: IMPACT_TRADE_USD,
    priceImpactPctRaw: toNumber(payload.priceImpactPct),
    routes: Array.isArray(payload.routePlan) ? payload.routePlan.length : null,
  };
}

/** The EVM counterpart. Also raw - amountInUsd and amountOutUsd. */
async function fetchKyberQuote(chain, tokenAddress) {
  const usdc = EVM_USDC[chain.key];
  if (!usdc) return null;
  const amountIn = BigInt(IMPACT_TRADE_USD) * (10n ** BigInt(usdc.decimals));
  const payload = await fetchJson("https://aggregator-api.kyberswap.com/" + usdc.kyber +
    "/api/v1/routes?tokenIn=" + usdc.address + "&tokenOut=" + tokenAddress +
    "&amountIn=" + amountIn.toString());
  const summary = payload && payload.data && payload.data.routeSummary;
  if (!summary) return null;
  return {
    source: SOURCES.KYBERSWAP,
    tradeUsd: IMPACT_TRADE_USD,
    amountInUsd: toNumber(summary.amountInUsd),
    amountOutUsd: toNumber(summary.amountOutUsd),
    routes: Array.isArray(summary.route) ? summary.route.length : null,
    gasUsd: toNumber(summary.gasUsd),
  };
}

async function fetchHoneypot(chain, tokenAddress) {
  const chainId = HONEYPOT_CHAIN_IDS[chain.key];
  if (!chainId) return null;
  const payload = await fetchJson(
    "https://api.honeypot.is/v2/IsHoneypot?address=" + tokenAddress + "&chainID=" + chainId);
  if (!payload || (!payload.honeypotResult && !payload.simulationResult)) return null;
  const sim = payload.simulationResult || {};
  return {
    source: SOURCES.HONEYPOT,
    isHoneypot: payload.honeypotResult ? Boolean(payload.honeypotResult.isHoneypot) : null,
    reason: payload.honeypotResult ? payload.honeypotResult.honeypotReason || null : null,
    buyTaxPct: toNumber(sim.buyTax),
    sellTaxPct: toNumber(sim.sellTax),
    transferTaxPct: toNumber(sim.transferTax),
    flags: ((payload.flags || []).map((f) => f.description || f.flag)).filter(Boolean),
  };
}

async function fetchLlamaPrice(chain, tokenAddress) {
  const slug = LLAMA_CHAIN[chain.key];
  if (!slug) return null;
  const key = slug + ":" + tokenAddress;
  const payload = await fetchJson("https://coins.llama.fi/prices/current/" + key);
  const hit = payload && payload.coins && payload.coins[key];
  if (!hit) return null;
  return {
    source: SOURCES.DEFILLAMA,
    priceUsd: toNumber(hit.price),
    confidence: toNumber(hit.confidence),
    decimals: toNumber(hit.decimals),
    updatedAt: toNumber(hit.timestamp),
  };
}

/* -------------------------------------------------------- reference venues */

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

/** Every venue quote, unreduced. The median used to be taken here. */
function fetchUsdReference(symbol) {
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
    return quotes.length ? { symbol: key, quotes: quotes } : null;
  });
}

/* ---------------------------------------------------------------- promotion */

const SOCIAL_TTL_MS = Number(process.env.SOCIAL_TTL_MS || 300000);
const BIZ_CATALOG = "https://a.4cdn.org/biz/catalog.json";

/** Raw board threads. Symbol matching and baselines happen in the app. */
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

function fetchPromotion(chain) {
  return cached("promo:" + chain.key, 120000, async () => {
    const [boosts, profiles] = await Promise.all([
      fetchJson(DS_BASE + "/token-boosts/top/v1").catch(() => []),
      fetchJson(DS_BASE + "/token-profiles/latest/v1").catch(() => []),
    ]);
    const shape = (entry, kind) => ({
      kind: kind,
      chain: entry.chainId,
      tokenAddress: entry.tokenAddress,
      description: (entry.description || "").slice(0, 140),
      links: (entry.links || []).filter((l) => l && l.url)
        .map((l) => ({ type: l.type || "link", url: l.url })),
      amount: entry.amount != null ? entry.amount : null,
      totalAmount: entry.totalAmount != null ? entry.totalAmount : null,
    });
    return []
      .concat((Array.isArray(boosts) ? boosts : []).filter((b) => b.chainId === chain.ds)
        .map((b) => shape(b, "BOOST")))
      .concat((Array.isArray(profiles) ? profiles : []).filter((p) => p.chainId === chain.ds)
        .map((p) => shape(p, "PROFILE")));
  });
}

module.exports = {
  SOURCES, IMPACT_TRADE_USD, OHLCV_TIMEFRAMES, GT_LIST_TTL_MS, GT_CACHE_TTL_MS,
  GOPLUS_BASE, RUGCHECK_BASE,
  indexIncluded, splitGtId, fetchPoolList, resolvePoolAddress, resolveTokenAddress,
  gtPoolFields, dsPairFields, pickPair, fetchDexScreenerTokens,
  jupiterFields, fetchJupiterTokens,
  fetchPoolTrades, fetchOhlcv,
  goPlusUrl, pickGoPlusRecord, fetchJupiterQuote, fetchKyberQuote,
  fetchHoneypot, fetchLlamaPrice,
  fetchUsdReference, fetchBizThreads, fetchPromotion,
};
