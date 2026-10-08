"use strict";

/**
 * Local-disk persistence.
 *
 * The server keeps its raw sample series and holder counts in RAM, and that RAM
 * is destroyed on every restart. This module mirrors them to a file on the
 * machine and reloads them on boot, so the series outlive the process.
 *
 * It replaces an earlier cloud mirror, and that removed a constraint rather
 * than just swapping a backend: the old backend billed per write, so samples
 * had to be buffered and flushed every TEN MINUTES to ration them. A local
 * append has no such price, so the flush interval drops to 30s and the
 * archive is effectively realtime. Do not slow it down again - that was
 * billing, not durability.
 *
 * Two files, via lib/archive.js:
 *   log/YYYY-MM-DD.jsonl   append-only, full detail, the complete dataset
 *   snapshot.json          current state, atomically rewritten, for fast boot
 *
 * Only samples NEWER than what we already archived are appended, so the log
 * grows by what was actually observed rather than re-writing whole series.
 *
 * No npm dependencies - node:fs only, through lib/archive.js.
 */

const archive = require("./lib/archive");
// Reads that parse day files run off the main thread - see the file header.
const offload = require("./lib/archive-offload");

const enabled = process.env.ARCHIVE_DISABLED !== "1" && archive.ensure();

// Disk writes are free, so these are about freshness, not cost. The old cloud
// values were 600000 / 1800000 and existed only to ration billed writes.
const FLUSH_MS = Number(process.env.STORE_FLUSH_MS || 30000);
const OBSERVATION_FLUSH_MS = Number(process.env.STORE_OBSERVATION_FLUSH_MS || 60000);

const stats = {
  enabled,
  projectId: null,
  dir: archive.dir,
  writes: 0, reads: 0, errors: 0,
  lastFlushAt: null, lastFlushDocs: 0, lastError: null, loadedAt: null,
  // Round-trip timings, so the admin panel can show what the archive costs us.
  writeLatency: { last: null, avg: null, min: null, max: null, samples: 0 },
  readLatency: { last: null, avg: null, min: null, max: null, samples: 0 },
  lastFlushMs: null, lastLoadMs: null,
  lastFlushBytes: 0, bytesWritten: 0,
};

function recordLatency(bucket, ms) {
  bucket.last = ms;
  bucket.min = bucket.min === null ? ms : Math.min(bucket.min, ms);
  bucket.max = bucket.max === null ? ms : Math.max(bucket.max, ms);
  bucket.avg = bucket.avg === null ? ms : Math.round((bucket.avg * bucket.samples + ms) / (bucket.samples + 1));
  bucket.samples += 1;
}

function note(error) {
  stats.errors += 1;
  stats.lastError = error && error.message ? error.message : String(error);
}

// The id shape the original store used. Kept because the admin panel and the
// inspect view still address records this way.
function docId(chainKey, address) {
  return chainKey + "__" + String(address).replace(/\//g, "_");
}

/* ---------------------------------------------------------------- api -- */

const dirtyPools = new Set();
const dirtyHolders = new Set();
const dirtyObservations = new Set();

// The high-water mark per key: the timestamp of the newest sample already in
// the log. Without this, every flush would re-append whole series and a day's
// log would be far larger than what was actually observed.
const archivedUpTo = new Map();

let flushTimer = null;
let observationTimer = null;
let flushing = false;

/** Marks a pool/token as changed; the next flush writes it. */
function touchPool(chainKey, poolAddress) { if (enabled) dirtyPools.add(docId(chainKey, poolAddress)); }
function touchHolders(chainKey, tokenAddress) { if (enabled) dirtyHolders.add(docId(chainKey, tokenAddress)); }
function touchObservation(chainKey, tokenAddress) { if (enabled) dirtyObservations.add(docId(chainKey, tokenAddress)); }

/** The samples of a series we have not archived yet, oldest first. */
function freshSamples(key, samples) {
  const since = archivedUpTo.get(key) || 0;
  const fresh = samples.filter((s) => s && Number(s.t) > since);
  if (fresh.length) archivedUpTo.set(key, Number(fresh[fresh.length - 1].t));
  return fresh;
}

/** "base:0xabc" -> "base__0xabc", matching docId. */
function keyToId(key) {
  const cut = key.indexOf(":");
  if (cut < 0) return docId("", key);
  return docId(key.slice(0, cut), key.slice(cut + 1));
}

/**
 * Reads the snapshot back into the caller's in-memory Maps.
 * Returns counts so the boot log can report what came back.
 */
async function load(stores) {
  if (!enabled) return { enabled: false };
  const counts = { pools: 0, holders: 0, observations: 0 };
  const loadStartedAt = Date.now();
  try {
    const snap = archive.readSnapshot();
    if (!snap) {
      stats.loadedAt = Date.now();
      stats.lastLoadMs = Date.now() - loadStartedAt;
      return Object.assign({ enabled: true, empty: true }, counts);
    }

    Object.keys(snap.pools || {}).forEach((key) => {
      const entry = snap.pools[key];
      const samples = (entry && entry.samples) || [];
      if (!Array.isArray(samples) || !samples.length) return;
      stores.historyStore.set(key, {
        samples: samples,
        symbol: entry.symbol || "",
        tokenAddress: entry.tokenAddress || "",
        touchedAt: Date.now(),
      });
      // Resume the high-water mark, so a restart does not re-append history
      // that is already in an earlier day's log.
      archivedUpTo.set(keyToId(key), Number(samples[samples.length - 1].t) || 0);
      counts.pools += 1;
    });

    Object.keys(snap.holders || {}).forEach((key) => {
      const series = snap.holders[key];
      if (!Array.isArray(series) || !series.length) return;
      stores.holderHistory.set(key, series);
      archivedUpTo.set("holders:" + keyToId(key), Number(series[series.length - 1].t) || 0);
      counts.holders += 1;
    });

    if (stores.observationStore) {
      Object.keys(snap.observations || {}).forEach((key) => {
        const series = snap.observations[key];
        if (!Array.isArray(series) || !series.length) return;
        stores.observationStore.set(key, series);
        archivedUpTo.set("obs:" + keyToId(key), Number(series[series.length - 1].t) || 0);
        counts.observations += 1;
      });
    }

    stats.reads += counts.pools + counts.holders + counts.observations;
    stats.loadedAt = Date.now();
    stats.lastLoadMs = Date.now() - loadStartedAt;
    recordLatency(stats.readLatency, stats.lastLoadMs);
  } catch (error) {
    note(error);
  }
  return Object.assign({ enabled: true }, counts);
}

/** Rewrites snapshot.json from the live Maps. Atomic; see lib/archive.js. */
function snapshot(stores) {
  const state = { at: Date.now(), pools: {}, holders: {}, observations: {} };
  stores.historyStore.forEach((series, key) => {
    if (!series || !series.samples || !series.samples.length) return;
    state.pools[key] = {
      samples: series.samples,
      symbol: series.symbol || "",
      tokenAddress: series.tokenAddress || "",
    };
  });
  stores.holderHistory.forEach((series, key) => {
    if (Array.isArray(series) && series.length) state.holders[key] = series;
  });
  if (stores.observationStore) {
    stores.observationStore.forEach((series, key) => {
      if (Array.isArray(series) && series.length) state.observations[key] = series;
    });
  }
  return archive.writeSnapshot(state);
}

/** Appends everything marked dirty. Called on a timer and on shutdown. */
async function flush(stores, reason) {
  if (!enabled || flushing) return 0;
  const pools = Array.from(dirtyPools); dirtyPools.clear();
  const holders = Array.from(dirtyHolders); dirtyHolders.clear();
  if (!pools.length && !holders.length) return 0;

  flushing = true;
  const flushStartedAt = Date.now();
  let written = 0;
  let bytes = 0;
  try {
    for (const id of pools) {
      const key = id.replace("__", ":");
      const series = stores.historyStore.get(key);
      if (!series || !series.samples || !series.samples.length) continue;
      const fresh = freshSamples(id, series.samples);
      if (!fresh.length) continue;
      const parts = id.split("__");
      bytes += archive.append({
        kind: "pool",
        chain: parts[0], pool: parts[1],
        // Identity, so a line is readable without cross-referencing the feed.
        symbol: series.symbol || "",
        token: series.tokenAddress || "",
        from: fresh[0].t, to: fresh[fresh.length - 1].t,
        n: fresh.length,
        samples: fresh,
      });
      written += 1;
    }

    for (const id of holders) {
      const key = id.replace("__", ":");
      const series = stores.holderHistory.get(key);
      if (!series || !series.length) continue;
      const fresh = freshSamples("holders:" + id, series);
      if (!fresh.length) continue;
      const parts = id.split("__");
      bytes += archive.append({
        kind: "holders",
        chain: parts[0], token: parts[1],
        n: fresh.length, series: fresh,
      });
      written += 1;
    }

    bytes += snapshot(stores);

    stats.writes += written;
    stats.bytesWritten += bytes;
    stats.lastFlushBytes = bytes;
    stats.lastFlushAt = Date.now();
    stats.lastFlushMs = Date.now() - flushStartedAt;
    stats.lastFlushDocs = written;
    recordLatency(stats.writeLatency, stats.lastFlushMs);
    if (written) console.log("store: archived " + written + " records, " + bytes + "B (" + (reason || "timer") + ")");
  } catch (error) {
    note(error);
    console.error("store: flush failed -", stats.lastError);
  } finally {
    flushing = false;
  }
  return written;
}

/** Score/price snapshots, on their own cycle. */
async function flushObservations(stores, reason) {
  if (!enabled || !stores.observationStore) return 0;
  const ids = Array.from(dirtyObservations);
  dirtyObservations.clear();
  if (!ids.length) return 0;
  let written = 0;
  let bytes = 0;
  try {
    for (const id of ids) {
      const series = stores.observationStore.get(id.replace("__", ":"));
      if (!series || !series.length) continue;
      const fresh = freshSamples("obs:" + id, series);
      if (!fresh.length) continue;
      const parts = id.split("__");
      const last = fresh[fresh.length - 1];
      bytes += archive.append({
        kind: "observation",
        chain: parts[0], token: parts[1],
        symbol: last.symbol || "",
        from: fresh[0].t, to: last.t,
        n: fresh.length, series: fresh,
      });
      written += 1;
    }
    // The snapshot must be rewritten here too, not only in flush(). The two
    // run on separate timers and in parallel during flushAll, so relying on a
    // pool flush to carry observations into the boot file left them archived
    // in the log but absent on reload.
    if (written) bytes += snapshot(stores);

    stats.writes += written;
    stats.bytesWritten += bytes;
    if (written) console.log("store: archived " + written + " observation records, " + bytes + "B (" + (reason || "timer") + ")");
  } catch (error) {
    note(error);
    console.error("store: observation flush failed -", stats.lastError);
  }
  return written;
}

/* ---- wallet trades ---------------------------------------------------- */

/**
 * Wallet-level trades, archived as they are sampled.
 *
 * GeckoTerminal returns a pool's last ~300 trades, so consecutive samples
 * overlap heavily. Trades carry no id, so identity is (time, wallet, side,
 * size); a per-pool high-water mark plus the keys AT that mark means each
 * trade lands in the log once, however many samples it appeared in.
 */
const tradeMarks = new Map();
const tradeKey = (x) => x.at + "|" + x.wallet + "|" + x.kind + "|" + x.usd;

function markFrom(trades) {
  let top = 0;
  (trades || []).forEach((x) => { if (Number.isFinite(x.at) && x.at > top) top = x.at; });
  const keys = new Set();
  (trades || []).forEach((x) => { if (x.at === top) keys.add(tradeKey(x)); });
  return { t: top, keys: keys };
}

/** Marks trades already on disk (from a restored sample) as archived. */
function seedTradeMark(chainKey, poolAddress, trades) {
  const id = "trades:" + docId(chainKey, poolAddress);
  if (!tradeMarks.has(id)) tradeMarks.set(id, markFrom(trades));
}

/** Appends the trades not archived before. Returns how many were new. */
function archiveTrades(chainKey, poolAddress, symbol, trades) {
  if (!enabled) return 0;
  const id = "trades:" + docId(chainKey, poolAddress);
  const mark = tradeMarks.get(id) || { t: 0, keys: new Set() };
  const fresh = (trades || [])
    .filter((x) => x && Number.isFinite(x.at) &&
      (x.at > mark.t || (x.at === mark.t && !mark.keys.has(tradeKey(x)))))
    .sort((p, q) => p.at - q.at);
  if (!fresh.length) return 0;
  try {
    const bytes = archive.append({
      kind: "trades",
      chain: chainKey, pool: poolAddress, symbol: symbol || "",
      from: fresh[0].at, to: fresh[fresh.length - 1].at,
      n: fresh.length, trades: fresh,
    });
    const top = fresh[fresh.length - 1].at;
    const keys = top === mark.t ? mark.keys : new Set();
    fresh.forEach((x) => { if (x.at === top) keys.add(tradeKey(x)); });
    tradeMarks.set(id, { t: top, keys: keys });
    stats.writes += 1;
    stats.bytesWritten += bytes;
    return fresh.length;
  } catch (error) {
    note(error);
    return 0;
  }
}

function startAutoFlush(stores) {
  if (!enabled) return;
  if (!flushTimer) {
    flushTimer = setInterval(() => { flush(stores, "timer").catch(() => {}); }, FLUSH_MS);
    flushTimer.unref();
  }
  if (!observationTimer) {
    observationTimer = setInterval(() => {
      flushObservations(stores, "timer").catch(() => {});
    }, OBSERVATION_FLUSH_MS);
    observationTimer.unref();
  }
}

function stopAutoFlush() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (observationTimer) { clearInterval(observationTimer); observationTimer = null; }
}

/** Everything, for shutdown. fsync last, so a kill after this loses nothing. */
function flushAll(stores, reason) {
  return Promise.all([flush(stores, reason), flushObservations(stores, reason)])
    .then(async (counts) => { await archive.sync(); return counts[0] + counts[1]; });
}

/**
 * Measures an actual disk round trip: one append + fsync, then one read back.
 * Used by the admin panel's "test now" button.
 */
async function probe() {
  if (!enabled) return { enabled: false, error: archive.error };
  const stamp = Date.now();
  const out = { enabled: true, at: stamp, dir: archive.dir };
  try {
    const w0 = Date.now();
    archive.append({ kind: "_probe", at: stamp, note: "admin panel latency probe" });
    await archive.sync();
    out.writeMs = Date.now() - w0;

    const r0 = Date.now();
    // The line was appended a moment ago, so it is in the file's last few KB.
    // Reading the whole day to find it parsed ~200MB every five minutes.
    const found = archive.readTail({
      day: new Date(stamp).toISOString().slice(0, 10),
      kind: "_probe",
    }).filter((r) => r.at === stamp);
    out.readMs = Date.now() - r0;
    out.roundTripMs = out.writeMs + out.readMs;
    out.verified = found.length === 1;
    out.usage = archive.usage();
  } catch (error) {
    out.error = error.message;
    note(error);
  }
  return out;
}

// The collection names the admin panel asks for, mapped onto the `kind`
// written into the log.
const COLLECTION_KIND = {
  poolHistory: "pool",
  observations: "observation",
  holders: "holders",
  stages: "app:stage",
  trades: "trades",
};

/**
 * Lists recent records without their heavy series payloads, so the admin panel
 * can show what is stored and how fresh it is. Same document shape the
 * original store returned, so the panel renders unchanged.
 */
async function inspect(collection, limit) {
  if (!enabled) return { enabled: false, documents: [] };
  const max = Math.min(Number(limit) || 25, 100);
  const kind = COLLECTION_KIND[collection] || collection;
  const startedAt = Date.now();
  // Newest day first; the newest record per id wins. On the read worker: a
  // kind with no records (app:stage, often) reads every day file to say so.
  const rows = await offload.call("read", { kind, limit: max * 20 });
  const seen = new Map();
  for (let i = rows.length - 1; i >= 0 && seen.size < max; i -= 1) {
    const r = rows[i];
    const id = docId(r.chain || "", r.pool || r.token || r.id || "");
    if (seen.has(id)) continue;
    const series = r.samples || r.series || [];
    const last = series[series.length - 1];
    seen.set(id, {
      id: id,
      chain: r.chain || null,
      symbol: r.symbol || null,
      token: r.token || null,
      pool: r.pool || null,
      stage: r.stage || null,
      sampleCount: r.n || series.length || null,
      firstSampleAt: r.from || (series[0] && series[0].t) || null,
      lastSampleAt: r.to || (last && last.t) || null,
      updatedAt: r.t || null,
      payloadBytes: JSON.stringify(series).length,
      createTime: null,
    });
  }
  return {
    enabled: true, collection: collection,
    fetchedInMs: Date.now() - startedAt,
    count: seen.size,
    hasMore: rows.length >= max * 20,
    documents: Array.from(seen.values()),
  };
}

/** Pending-write counts, for the admin panel's queue view. */
function pending() {
  return {
    pools: dirtyPools.size,
    holders: dirtyHolders.size, observations: dirtyObservations.size,
  };
}

function usage() { return archive.usage(); }

/**
 * A graded verdict on whether the archive is actually working, rather than a
 * pile of numbers the panel has to interpret. Each problem carries its own
 * sentence, because "DEGRADED" with no reason is not worth showing.
 *
 * Levels: ok | degraded | failed.
 */
function health() {
  const problems = [];
  let level = "ok";

  if (!enabled) {
    return {
      level: "failed",
      summary: "Not archiving - nothing survives a restart.",
      problems: [archive.error || "archive disabled by ARCHIVE_DISABLED"],
    };
  }

  if (archive.error) {
    level = "failed";
    problems.push("Last disk operation failed: " + archive.error);
  }

  if (stats.errors > 0) {
    if (level !== "failed") level = "degraded";
    problems.push(stats.errors + " error(s) this process; last was: " + (stats.lastError || "unknown"));
  }

  // A flush that has not run in several intervals means the timer stalled or
  // every flush is throwing - either way the log is behind what is in RAM.
  const sinceFlush = stats.lastFlushAt ? Date.now() - stats.lastFlushAt : null;
  if (sinceFlush !== null && sinceFlush > FLUSH_MS * 4) {
    if (level !== "failed") level = "degraded";
    problems.push("No flush for " + Math.round(sinceFlush / 1000) + "s (interval is " +
      Math.round(FLUSH_MS / 1000) + "s).");
  }

  // The dirty sets should drain every flush. A large standing queue means
  // writes are failing silently or the series are being touched faster than
  // they can be written.
  const queued = pending();
  const totalQueued = queued.pools + queued.holders + queued.observations;
  if (totalQueued > 2000) {
    if (level !== "failed") level = "degraded";
    problems.push(totalQueued + " records queued and not yet written.");
  }

  const use = archive.usage();
  if (!use.ok) {
    level = "failed";
    problems.push("Cannot read the archive directory: " + (use.error || "unknown"));
  }

  const summary = level === "ok"
    ? "Archiving to disk, flushing every " + Math.round(FLUSH_MS / 1000) + "s."
    : level === "degraded"
      ? "Archiving, but something is behind or erroring."
      : "Not archiving reliably - data is being lost.";

  return {
    level, summary, problems,
    sinceFlushMs: sinceFlush,
    queued: totalQueued,
    writtenByKind: archive.writtenByKind(),
  };
}

// Each of these parses day files - up to a week of them - so they run on the
// read worker and return Promises. Called inline they froze the server long
// enough for the supervisor to kill it (2026-10-07).
function scan() { return offload.call("scan"); }
const seriesSince = (options) => offload.call("seriesSince", options);
const coverage = (options) => offload.call("coverage", options);
const timeline = (options) => offload.call("timeline", options);

module.exports = {
  enabled, stats,
  backend: "disk",
  dir: archive.dir,
  flushIntervalMs: FLUSH_MS,
  observationFlushIntervalMs: OBSERVATION_FLUSH_MS,
  load, flush, flushObservations, flushAll, startAutoFlush, stopAutoFlush,
  touchPool, touchHolders, touchObservation,
  archiveTrades, seedTradeMark,
  probe, inspect, pending, usage, health, scan,
  seriesSince, coverage, timeline,
  compact: archive.compact, dayFiles: archive.dayFiles,
  rawDays: archive.RETAIN_RAW_DAYS, rollupMs: archive.ROLLUP_MS,
  close: archive.close, stopReader: offload.stop,
  read: archive.read, days: archive.days,
};
