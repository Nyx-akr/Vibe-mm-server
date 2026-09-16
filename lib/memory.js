"use strict";

/**
 * The server's RAM: rolling series of RAW numbers, nothing derived.
 *
 * This is the one thing a browser cannot do for itself - it is not open
 * around the clock, so it cannot watch a pool for hours to learn what that
 * pool's normal 5-minute volume looks like. The server samples and remembers;
 * the app reads the series back and computes the z-scores, baselines and
 * forward returns from it.
 *
 * Deliberately absent: scores, stages, risk flags, wash probabilities. None of
 * those are raw, so none of them are stored here any more.
 */

const store = require("../store");

/* ----------------------------------------------------- pool metric samples */

// 480 samples x 15s = a 2h rolling window per pool.
const HISTORY_MAX_SAMPLES = Number(process.env.HISTORY_MAX_SAMPLES || 480);
const HISTORY_MAX_POOLS = Number(process.env.HISTORY_MAX_POOLS || 600);
const HISTORY_MIN_GAP_MS = Number(process.env.HISTORY_MIN_GAP_MS || 15000);
/**
 * Baselines are only meaningful over a continuous window. When the service has
 * been asleep, restored samples can straddle a multi-hour gap, so anything
 * older than this is dropped before the app can read it as a baseline.
 */
const HISTORY_MAX_AGE_MS = Number(process.env.HISTORY_MAX_AGE_MS || 6 * 3600000);

const historyStore = new Map();
const holderHistory = new Map();
const observationStore = new Map();
const tradeSamples = new Map();

/**
 * One sample per pool per HISTORY_MIN_GAP_MS. The values stored are exactly
 * the values the providers reported - no ratio, no anomaly multiple.
 */
function recordSamples(chainKey, rows) {
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
    series.symbol = row.symbol || series.symbol || null;
    series.tokenAddress = row.tokenAddress || series.tokenAddress || null;

    const last = series.samples[series.samples.length - 1];
    if (last && now - last.t < HISTORY_MIN_GAP_MS) return;

    // Prefer whichever provider answered; this is presence, not preference -
    // a null from one source must not erase a number from the other.
    const gt = row.sources.geckoterminal || {};
    const ds = row.sources.dexscreener || {};
    const pick = (a, b) => (a === null || a === undefined ? (b === undefined ? null : b) : a);

    series.samples.push({
      t: now,
      volume5mUsd: pick(ds.volumeUsd && ds.volumeUsd.m5, gt.volumeUsd && gt.volumeUsd.m5),
      buys5m: pick(gt.transactions && gt.transactions.m5 && gt.transactions.m5.buys,
        ds.transactions && ds.transactions.m5 && ds.transactions.m5.buys),
      buyers5m: gt.transactions && gt.transactions.m5 ? gt.transactions.m5.buyers : null,
      liquidityUsd: pick(ds.liquidityUsd, gt.liquidityUsd),
      priceUsd: pick(ds.priceUsd, gt.priceUsd),
    });
    if (series.samples.length > HISTORY_MAX_SAMPLES) series.samples.shift();
    store.touchPool(chainKey, row.poolAddress);
  });
}

function pruneHistory() {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  historyStore.forEach((series, key) => {
    const kept = series.samples.filter((s) => s.t >= cutoff);
    if (!kept.length) historyStore.delete(key);
    else series.samples = kept;
  });
}

/** The raw series for one pool, or for every pool on a chain. */
function samplesFor(chainKey, poolAddress) {
  if (poolAddress) {
    const series = historyStore.get(chainKey + ":" + poolAddress);
    return series ? series.samples.slice() : [];
  }
  const out = {};
  historyStore.forEach((series, key) => {
    if (!key.startsWith(chainKey + ":")) return;
    out[key.slice(chainKey.length + 1)] = series.samples.slice();
  });
  return out;
}

/* ------------------------------------------------------------ holder counts */

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

/** The raw count series. Growth per hour is the app's arithmetic now. */
function holderSeries(chainKey, tokenAddress) {
  return (holderHistory.get(chainKey + ":" + tokenAddress) || []).slice();
}

/* -------------------------------------------------------------- observations */

const OBSERVATION_GAP_MS = Number(process.env.OBSERVATION_GAP_MS || 60000);
// 1500 snapshots x 60s = just over 25h, so a 24h outcome is measurable.
const OBSERVATION_MAX = Number(process.env.OBSERVATION_MAX || 1500);

/**
 * Price and liquidity snapshots per token, for the Evaluation tab.
 *
 * These used to carry the score and stage at the time. They cannot any more -
 * the server no longer computes either - so the app keeps its own score
 * journal and joins it to this series by timestamp.
 */
function recordObservations(chainKey, rows) {
  const now = Date.now();
  rows.forEach((row) => {
    if (!row.tokenAddress) return;
    const gt = row.sources.geckoterminal || {};
    const ds = row.sources.dexscreener || {};
    const price = ds.priceUsd === null || ds.priceUsd === undefined ? gt.priceUsd : ds.priceUsd;
    if (!Number.isFinite(price)) return;
    const liquidity = ds.liquidityUsd === null || ds.liquidityUsd === undefined
      ? gt.liquidityUsd : ds.liquidityUsd;

    const key = chainKey + ":" + row.tokenAddress;
    const series = observationStore.get(key) || [];
    const last = series[series.length - 1];
    if (last && now - last.t < OBSERVATION_GAP_MS) return;
    series.push({ t: now, price: price, liquidity: liquidity, symbol: row.symbol });
    if (series.length > OBSERVATION_MAX) series.shift();
    observationStore.set(key, series);
    store.touchObservation(chainKey, row.tokenAddress);
  });
}

function observationsFor(chainKey) {
  const out = {};
  observationStore.forEach((series, key) => {
    if (!key.startsWith(chainKey + ":")) return;
    out[key.slice(chainKey.length + 1)] = series.slice();
  });
  return out;
}

/* ------------------------------------------------------------ trade samples */

const TRADE_SAMPLE_MAX = Number(process.env.TRADE_SAMPLE_MAX || 300);

/**
 * GeckoTerminal only affords a trade pull for one pool per cycle, so samples
 * accumulate across the rotation and are kept until overwritten. Raw rows.
 */
function recordTrades(chainKey, poolAddress, symbol, trades) {
  tradeSamples.set(chainKey + ":" + poolAddress, {
    at: Date.now(),
    symbol: symbol || null,
    trades: trades.slice(-TRADE_SAMPLE_MAX),
  });
}

function tradesFor(chainKey, poolAddress) {
  if (poolAddress) {
    const hit = tradeSamples.get(chainKey + ":" + poolAddress);
    return hit ? [Object.assign({ poolAddress: poolAddress }, hit)] : [];
  }
  const out = [];
  tradeSamples.forEach((entry, key) => {
    if (!key.startsWith(chainKey + ":")) return;
    out.push(Object.assign({ poolAddress: key.slice(chainKey.length + 1) }, entry));
  });
  return out;
}

/* ------------------------------------------------------------------- stats */

function memoryStats() {
  return {
    historyPools: historyStore.size,
    holderSeries: holderHistory.size,
    observationTokens: observationStore.size,
    tradeSamples: tradeSamples.size,
  };
}

module.exports = {
  historyStore, holderHistory, observationStore, tradeSamples,
  HISTORY_MAX_SAMPLES, HISTORY_MIN_GAP_MS, HISTORY_MAX_AGE_MS,
  recordSamples, pruneHistory, samplesFor,
  recordHolderCount, holderSeries,
  recordObservations, observationsFor,
  recordTrades, tradesFor,
  memoryStats,
};
