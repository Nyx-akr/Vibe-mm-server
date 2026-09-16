"use strict";

/**
 * Documentation of where every Asset Detail value comes from and how it is
 * derived. It lives in the server, beside the code it describes, so the admin
 * panel reads one source of truth instead of a copy that drifts.
 *
 * Component weights are not repeated here - they are read from SCORE_MODEL at
 * runtime and merged in by payload().
 */

const SOURCES = [
  {
    id: "geckoterminal", label: "GeckoTerminal", keyless: true,
    limit: "~30 req/min per IP (shared on Render free tier)",
    endpoints: ["/networks/{net}/trending_pools", "/pools/{pool}/ohlcv/minute", "/pools/{pool}/trades"],
    provides: "price, liquidity, volume 5m/1h/24h, txns, traders, pool age, OHLCV bars, wallet-level trades",
    role: "pool discovery - decides which pools exist; the list is cached 3 min and the last good list is reused when it rate-limits",
  },
  {
    id: "dexscreener", label: "DexScreener", keyless: true, limit: "~300 req/min",
    endpoints: ["/latest/dex/tokens/{addresses}"],
    provides: "price, liquidity, volume, market cap, FDV, txns, socials - preferred over GeckoTerminal where both answer",
    role: "pricing - refreshed on every request, so values move at DexScreener's pace rather than the list's",
  },
  {
    id: "jupiter", label: "Jupiter", keyless: true, chains: "Solana only",
    endpoints: ["/tokens/v2/search (batched 40 mints)", "/swap/v1/quote"],
    provides: "organic score, holder count and change, USD buy/sell split, organic volume split, circulating supply, dev audit, launchpad, routed $10k price impact",
  },
  {
    id: "kyberswap", label: "KyberSwap", keyless: true, chains: "EVM only",
    endpoints: ["/{chain}/api/v1/routes"],
    provides: "routed $10k price impact on Ethereum, Base, BSC, Arbitrum, Polygon, Avalanche",
  },
  {
    id: "goplus", label: "GoPlus", keyless: true,
    endpoints: ["/token_security/{chainId}"],
    provides: "contract safety checks, holder count, top-10 holder list",
  },
  {
    id: "rugcheck", label: "RugCheck", keyless: true, chains: "Solana only",
    endpoints: ["/tokens/{mint}/report"],
    provides: "LP lock %, insider graph, creator token count, risk list",
  },
  {
    id: "honeypot", label: "honeypot.is", keyless: true, chains: "EVM only",
    endpoints: ["/v2/IsHoneypot"],
    provides: "simulated buy and sell, measured buy/sell tax",
  },
  {
    id: "defillama", label: "DefiLlama", keyless: true,
    endpoints: ["/prices/current/{chain}:{token}"],
    provides: "independent price and confidence, as a third opinion on price",
  },
  {
    id: "cex", label: "Binance + Coinbase + CoinGecko", keyless: true,
    endpoints: ["spot price"],
    provides: "quote-token USD median (SOL / ETH / BNB ...)",
  },
  {
    id: "history", label: "Server history (RAM, mirrored to Firestore)", keyless: true,
    endpoints: ["internal"],
    provides: "15s pool samples, 60s score/price observations, stage transitions, holder series",
  },
];

const PANELS = [
  {
    panel: "SCORE DECOMPOSITION",
    fields: [
      { field: "Volume anomaly", source: "geckoterminal + history", freshness: "15s samples, needs 8",
        formula: "clamp01(0.5 + 0.3 x log10(vol5m / mean vol5m over the window)) x 100" },
      { field: "Trade activity", source: "geckoterminal + history", freshness: "15s samples, needs 8",
        formula: "same shape as volume anomaly, applied to the 5m buy count" },
      { field: "Buyer breadth", source: "geckoterminal", freshness: "live",
        formula: "0.5 x multipleScore(buyers5m / baseline) + 0.5 x logScore(buyers24h, 10, 3000)" },
      { field: "Net demand", source: "jupiter, else geckoterminal trades, else txn counts", freshness: "30s cache",
        formula: "clamp01(0.5 + netRatio / 2) x 100 where netRatio = (buyUSD - sellUSD) / totalUSD" },
      { field: "Liquidity / executability", source: "geckoterminal + jupiter or kyberswap", freshness: "5min cache",
        formula: "0.5 x logScore(liquidityUsd, 1e4, 1e6) + 0.5 x clamp01(1 - impactPct / 2.5) x 100" },
      { field: "Price confirmation", source: "dexscreener vs geckoterminal", freshness: "live",
        formula: "clamp01(1 - abs(priceDeltaPct) / 5) x 100; flat 40 when only one source priced it" },
      { field: "Holder growth", source: "jupiter, else holder series", freshness: "30s cache",
        formula: "clamp01(0.5 + holderChange1hPct / 4) x 100" },
      { field: "Wallet quality", source: "goplus + rugcheck, else jupiter audit", freshness: "5min cache",
        formula: "clamp01(1 - top10SharePct / 60), x0.75 if insiders detected, x0.8 if creator has >20 tokens, x1.15 if LP >90% locked" },
      { field: "Capital rotation", source: "geckoterminal trades", freshness: "one pool sampled per 20s",
        formula: "clamp01(sharedWalletPct / 25) x 100 - wallets this pool shares with other sampled pools" },
      { field: "Cross-venue confirm", source: "dexscreener", freshness: "live",
        formula: "logScore(venueCount, 1, 20) x (sourcesAgreeing > 1 ? 1 : 0.6)" },
      { field: "USD reference", source: "cex", freshness: "60s cache",
        formula: "clamp01(1 - deviationPct / 2) x 100 where deviation = |quotePrice - median| / median x 100" },
      { field: "Data quality", source: "self", freshness: "live",
        formula: "measured components / 11 x 100" },
      { field: "Organic flow", source: "jupiter, else geckoterminal trades", freshness: "30s cache", modifier: true,
        formula: "Jupiter organic score, else 0.4 x (oneAndDone/80) + 0.35 x (1 - top5/70) + 0.25 x (1 - (trades per wallet - 1)/5)" },
      { field: "Contract safety", source: "goplus + rugcheck + honeypot", freshness: "5min cache", modifier: true,
        formula: "passed checks / total checks x 100" },
      { field: "RAW", source: "computed", freshness: "live",
        formula: "sum(component value x weight) / sum(weights of components that computed)" },
      { field: "RISK PENALTY", source: "computed", freshness: "live",
        formula: "min(15, sum of triggered risk-flag penalties)" },
      { field: "FINAL", source: "computed", freshness: "live",
        formula: "clamp(RAW - PENALTY, 0, 100)" },
    ],
  },
  {
    panel: "EXECUTION PRICE",
    fields: [
      { field: "Bars (primary)", source: "geckoterminal", freshness: "150s cache",
        formula: "last 60 one-minute closes from the OHLCV endpoint" },
      { field: "Bars (fallback)", source: "history", freshness: "15s samples",
        formula: "this server's own priceUsd series, drawn when GeckoTerminal rate-limits the request" },
      { field: "Bar height", source: "computed", freshness: "-",
        formula: "8 + (close - min) / (max - min) x 92 percent of panel height" },
      { field: "Price / delta 5M", source: "dexscreener, else geckoterminal", freshness: "live",
        formula: "priceUsd and priceChangePct.m5 as reported" },
    ],
  },
  {
    panel: "MARKET",
    fields: [
      { field: "MKT CAP", source: "dexscreener, else geckoterminal, else jupiter", freshness: "live", formula: "reported directly" },
      { field: "LIQUIDITY", source: "dexscreener, else geckoterminal", freshness: "live", formula: "reported directly" },
      { field: "VOL 5M", source: "dexscreener, else geckoterminal", freshness: "live", formula: "reported directly" },
      { field: "VOL 24H", source: "dexscreener, else geckoterminal", freshness: "live", formula: "reported directly" },
      { field: "BUYERS 5M", source: "geckoterminal", freshness: "live", formula: "traders5m.buyers" },
      { field: "BUYERS 24H", source: "geckoterminal", freshness: "live", formula: "traders24h.buyers" },
      { field: "B/S RATIO 24H", source: "geckoterminal", freshness: "live", formula: "buys24h / sells24h" },
      { field: "VOL/LIQ 24H", source: "computed", freshness: "live", formula: "volume24hUsd / liquidityUsd" },
      { field: "POOL AGE", source: "geckoterminal", freshness: "live", formula: "now - poolCreatedAt" },
      { field: "HOLDERS", source: "goplus, else rugcheck, else jupiter", freshness: "5min cache", formula: "first source that answers; disagreement flagged" },
      { field: "TOP-10 SHARE", source: "goplus", freshness: "5min cache", formula: "sum of the top-10 holders' percentages" },
      { field: "IMPACT $10K", source: "jupiter (Solana) or kyberswap (EVM)", freshness: "5min cache",
        formula: "quote a real $10,000 buy: (amountInUsd - amountOutUsd) / amountInUsd x 100" },
      { field: "NET BUY 5M", source: "jupiter, else geckoterminal trades", freshness: "30s cache", formula: "buyVolume - sellVolume over 5 minutes" },
      { field: "WASH PROB", source: "computed", freshness: "30s cache", formula: "100 - organic flow score (a proxy, not a wash-trading model)" },
      { field: "ORGANIC SCORE", source: "jupiter", freshness: "30s cache", formula: "Jupiter's own 0-100 organic score" },
      { field: "ORGANIC VOL 24H", source: "jupiter", freshness: "30s cache", formula: "(buyOrganic + sellOrganic) / (buy + sell) x 100" },
      { field: "HOLDERS delta 1H", source: "jupiter", freshness: "30s cache", formula: "stats1h.holderChange percent" },
      { field: "CIRC SUPPLY", source: "jupiter", freshness: "30s cache", formula: "circSupply" },
      { field: "DEV MIGRATIONS", source: "jupiter", freshness: "30s cache", formula: "audit.devMigrations - how many prior tokens this dev migrated" },
      { field: "LAUNCHPAD", source: "jupiter", freshness: "30s cache", formula: "launchpad name, e.g. pump.fun" },
      { field: "PRICE vs LLAMA", source: "defillama", freshness: "5min cache", formula: "(feedPrice - llamaPrice) / llamaPrice x 100" },
      { field: "SELL SIMULATION", source: "honeypot", freshness: "5min cache", formula: "simulated buy then sell; EVM chains only" },
    ],
  },
  {
    panel: "STAGE TIMELINE",
    fields: [
      { field: "Stage badge", source: "computed", freshness: "live",
        formula: "bands WATCH 0 / EMERGING 55 / CONFIRMED 70 / EXCEPTIONAL 85; promotes immediately, demotes only once the score falls 3 points below the band" },
      { field: "Stage times", source: "history", freshness: "on change", formula: "recorded transition timestamps, newest per stage" },
    ],
  },
  {
    panel: "RISK FLAGS",
    fields: [
      { field: "NEW_POOL", source: "geckoterminal", freshness: "live", formula: "age < 2h gives HIGH and -4; age < 24h gives MED and -2" },
      { field: "SINGLE_SOURCE", source: "computed", freshness: "live", formula: "fewer than 2 providers priced the pool: -3" },
      { field: "THIN_LIQUIDITY", source: "dexscreener", freshness: "live", formula: "liquidity under $50,000: -4" },
      { field: "EXTREME_TURNOVER", source: "computed", freshness: "live", formula: "24h volume more than 20x liquidity: -3" },
      { field: "VOLUME_CONCENTRATED", source: "geckoterminal trades", freshness: "rotation", formula: "top 5 wallets over 70% of traded volume: -4" },
      { field: "CONTRACT_CHECKS", source: "goplus + rugcheck + honeypot", freshness: "5min cache", formula: "any failed check: -3, or -6 when the safety score is below 70" },
      { field: "LOW_ORGANIC_FLOW", source: "jupiter", freshness: "30s cache", formula: "organic flow under 40: -3" },
    ],
  },
  {
    panel: "TRIGGER REASONS",
    fields: [
      { field: "Text", source: "computed", freshness: "live", formula: "the evidence string each component's own equation produced" },
      { field: "z", source: "history", freshness: "15s samples", formula: "(current - mean) / stdev over the sample series" },
      { field: "x (multiple)", source: "history", freshness: "15s samples", formula: "current / mean" },
    ],
  },
  {
    panel: "CONTRACT SAFETY",
    fields: [
      { field: "GoPlus checks", source: "goplus", freshness: "5min cache",
        formula: "mint authority, freeze authority, closable account, mutable balance, transfer hook, transfer fee, honeypot signature, verified source, hidden owner, pausable transfers, tax under 10%" },
      { field: "Sell path works", source: "honeypot", freshness: "5min cache", formula: "a simulated sell succeeds (EVM only)" },
      { field: "Simulated tax", source: "honeypot", freshness: "5min cache", formula: "tax measured from the simulation rather than read from the contract" },
      { field: "LP lock / insiders / creator tokens", source: "rugcheck", freshness: "5min cache", formula: "feeds Wallet quality rather than shown as a check" },
    ],
  },
  {
    panel: "OUTCOME TRACKING",
    fields: [
      { field: "15M / 1H / 4H / 12H / 24H", source: "none yet", freshness: "-",
        formula: "NOT IMPLEMENTED - always grey. The observations collection now holds score and price every 60s for ~25h, which is the input this needs." },
    ],
  },
];


/**
 * How data moves through the server, for the admin panel's pipeline view.
 * Kept here so the page describes the system as it is rather than as it was.
 */
const PIPELINE = [
  { stage: "1. Discover", detail: "GeckoTerminal trending_pools decides which pools exist, per chain.",
    cadence: "list cached 3 min (GT_LIST_TTL_MS); last good list reused on a 429" },
  { stage: "2. Refresh", detail: "DexScreener prices the discovered pools; GeckoTerminal fills anything it lacks.",
    cadence: "every request (1s cache)" },
  { stage: "3. Warm", detail: "A background loop refreshes one chain at a time so eight chains never burst GeckoTerminal at once, and samples keep accruing with nobody watching.",
    cadence: "one chain every 20s, full cycle 160s (WARM_INTERVAL_MS x ACTIVE_CHAINS)" },
  { stage: "4. Enrich", detail: "On demand for one token: Jupiter or KyberSwap impact, GoPlus and RugCheck safety, honeypot.is simulation, DefiLlama price check.",
    cadence: "5 min cache, fetched when a detail tab opens" },
  { stage: "5. Calculate", detail: "calculations/index.js turns raw provider rows into components, modifiers, risk flags, stages and summaries. server.js does no maths.",
    cadence: "per request" },
  { stage: "6. Remember", detail: "15s pool samples, 60s score/price observations, stage transitions and holder counts held in RAM.",
    cadence: "samples every 15s, observations every 60s" },
  { stage: "7. Persist", detail: "Firestore mirrors those series so they survive sleeps, deploys and restarts. Optional - off without credentials.",
    cadence: "pools every 10 min, observations every 30 min, plus a flush on shutdown" },
];

/** Merges live SCORE_MODEL weights into the documented catalogue. */
function payload(scoreModel) {
  const weights = {};
  (scoreModel || []).forEach((component) => { weights[component.label] = component.weight; });
  return {
    server: "ok",
    generatedAt: Date.now(),
    sources: SOURCES,
    pipeline: PIPELINE,
    panels: PANELS.map((panel) => ({
      panel: panel.panel,
      fields: panel.fields.map((field) =>
        Object.assign({}, field, { weight: weights[field.field] || null })),
    })),
  };
}

module.exports = { SOURCES, PANELS, PIPELINE, payload };
