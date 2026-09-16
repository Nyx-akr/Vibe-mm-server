"use strict";

/**
 * Every value the screener derives lives here.
 *
 * server.js fetches from the providers, caches, persists and serves HTTP; it
 * does not decide what anything means. Raw provider rows come into these
 * functions and finished numbers come out, which keeps one place to read when
 * you want to know how a score, stage, flag or baseline was produced - and one
 * place to change it.
 *
 * Everything here is pure: same inputs, same outputs, no fetching, no caching,
 * no clock beyond what is passed in. The one exception is the stage machine,
 * which needs memory of the previous stage, so its store is handed in by the
 * caller rather than kept here.
 */

// toNumber is defined in server.js and passed down where needed; these helpers
// only depend on plain JS.
function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

/** Points the score must fall below the current band before demoting. */
const HYSTERESIS = Number(process.env.STAGE_HYSTERESIS || 3);

const STAGES = Object.freeze([
  { name: "EXCEPTIONAL", min: 85 },
  { name: "CONFIRMED", min: 70 },
  { name: "EMERGING", min: 55 },
  { name: "WATCH", min: 0 },
]);

const to100 = (v) => Math.round(clamp01(v) * 100);

const multipleScore = (multiple) =>
  Number.isFinite(multiple) && multiple > 0 ? to100(0.5 + 0.3 * Math.log10(multiple)) : null;

const logScore = (value, lo, hi) =>
  Number.isFinite(value) && value > 0
    ? to100((Math.log10(Math.max(value, 1)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)))
    : null;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function percentDelta(from, to) {
  if (from === null || to === null || !from) return null;
  return ((to - from) / from) * 100;
}

function statsFor(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) * (b - mean), 0) / clean.length;
  return { mean: mean, stdev: Math.sqrt(variance), n: clean.length };
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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

/**
 * The stage machine is the one stateful calculation: it needs to know the
 * previous stage to apply hysteresis. The caller owns that store (and any
 * persistence side effect) and hands both in.
 */
function stageFor(stageStore, chainKey, tokenAddress, score, onTransition) {
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
    if (onTransition) onTransition(next);
  }
  return prior;
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
  // The stage machine needs memory, so the caller supplies it through extras.
  // Without one, the score still returns - just with no stage history.
  const stage = typeof context.stageFor === "function"
    ? context.stageFor(row.chain, row.tokenAddress, score)
    : { stage: (STAGES.find((s) => score >= s.min) || STAGES[STAGES.length - 1]).name,
        since: Date.now(), history: [] };

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

/**
 * Screening is for emerging tokens, so blue chips, stablecoins and wrapped
 * natives are excluded. They dominate trending pools by volume - a live sample
 * had USDC as the base token of 19 of 160 rows - without ever being the kind of
 * asset this dashboard exists to surface.
 *
 * Two independent tests, either of which excludes a token:
 *   - it is a known stablecoin, wrapped native or liquid-staking derivative
 *   - its market cap is above MAJOR_MARKET_CAP_USD
 */
const STABLE_SYMBOLS = new Set([
  "USDC", "USDT", "DAI", "USDG", "USDE", "USDS", "USDD", "USD1", "USDBC", "USDY",
  "FDUSD", "TUSD", "PYUSD", "FRAX", "LUSD", "SUSD", "BUSD", "EURC", "GUSD", "CRVUSD",
]);
const WRAPPED_OR_MAJOR_SYMBOLS = new Set([
  "ETH", "WETH", "BTC", "WBTC", "CBBTC", "TBTC", "LBTC",
  "SOL", "WSOL", "BNB", "WBNB", "AVAX", "WAVAX", "MATIC", "WMATIC", "POL", "WPOL",
  "HYPE", "WHYPE", "STETH", "WSTETH", "WEETH", "RETH", "EZETH", "RSETH",
  "SAVAX", "JITOSOL", "MSOL", "BSOL", "JUPSOL", "LINK",
]);
const MAJOR_MARKET_CAP_USD = Number(process.env.MAJOR_MARKET_CAP_USD || 1e9);

/**
 * Bridged assets carry a chain suffix - BTC.b and WETH.e on Avalanche, USDC.e
 * on several L2s - so the suffix is stripped before matching. Without this,
 * bridged majors slipped through the screen.
 */
function normalizeSymbol(raw) {
  let symbol = String(raw || "").toUpperCase().trim();
  if (symbol.charAt(0) === "$") symbol = symbol.slice(1);
  const dot = symbol.lastIndexOf(".");
  if (dot > 0 && symbol.length - dot <= 3) symbol = symbol.slice(0, dot);
  return symbol;
}

function isMajorToken(row, options) {
  const ceiling = (options && options.maxMarketCapUsd) || MAJOR_MARKET_CAP_USD;
  const symbol = normalizeSymbol(row && row.symbol);
  if (STABLE_SYMBOLS.has(symbol) || WRAPPED_OR_MAJOR_SYMBOLS.has(symbol)) return true;
  const cap = toNumber(row && row.marketCapUsd);
  return cap !== null && cap > ceiling;
}

/**
 * Trending pools list the same token under several pools, so the feed showed
 * duplicates. Keeps the deepest pool per token and reports what it dropped.
 */
function screenRows(rows, options) {
  const opts = options || {};
  const excluded = { majors: 0, duplicates: 0 };
  const byToken = new Map();
  const kept = [];

  rows.forEach((row) => {
    if (!opts.includeMajors && isMajorToken(row, opts)) { excluded.majors += 1; return; }
    const key = row.tokenAddress || row.poolAddress;
    if (!key) { kept.push(row); return; }
    const seen = byToken.get(key);
    if (!seen) { byToken.set(key, row); kept.push(row); return; }
    excluded.duplicates += 1;
    // Same token, different pool: keep whichever has the deeper liquidity.
    if ((toNumber(row.liquidityUsd) || 0) > (toNumber(seen.liquidityUsd) || 0)) {
      kept[kept.indexOf(seen)] = row;
      byToken.set(key, row);
    }
  });

  return { rows: kept, excluded: excluded };
}

module.exports = {
  // model definitions
  SCORE_MODEL, SCORE_MODIFIERS, STAGES, HYSTERESIS,
  // scalar helpers
  isMajorToken, screenRows, MAJOR_MARKET_CAP_USD,
  toNumber, clamp01, to100, multipleScore, logScore, percentDelta, statsFor, median,
  // derived inputs
  tradeStatsFrom, bucketBaselines,
  // the score itself
  computeComponents, computeModifiers, assessRisk, scoreRow,
  // stage machine (caller supplies the store)
  stageFor,
  // presentation-facing summaries
  topReasonFor, summarize,
};
