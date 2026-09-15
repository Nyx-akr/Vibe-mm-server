"use strict";

/**
 * Optional Firestore persistence.
 *
 * The server keeps its baselines, stage machine and holder series in RAM. On
 * Render's free tier that RAM is destroyed whenever the service sleeps, deploys
 * or restarts, so those series never grow past the current process. This module
 * mirrors them to Firestore and reloads them on boot.
 *
 * It is entirely optional: with no credentials configured every call is a no-op
 * and the server behaves exactly as it did before.
 *
 * No npm dependencies - the Firestore REST API is called directly, with a
 * service-account JWT signed by node:crypto.
 *
 * Cost shape: Firestore bills per document write, so samples are buffered in
 * RAM and flushed as ONE document per pool every FLUSH_MS (default 10 min),
 * which keeps a 60-80 pool feed inside the free tier's 20k writes/day.
 */

const crypto = require("node:crypto");

function parseAccount(raw) {
  if (!raw) return null;
  const text = raw.trim().startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.client_email && parsed.private_key) return parsed;
  } catch (error) {
    console.error("store: FIREBASE_SERVICE_ACCOUNT is not valid JSON or base64 JSON");
  }
  return null;
}

const account = parseAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || (account && account.project_id) || null;
const DATABASE = process.env.FIRESTORE_DATABASE || "(default)";
const enabled = Boolean(account && PROJECT_ID);
const BASE = enabled
  ? "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
    "/databases/" + encodeURIComponent(DATABASE) + "/documents"
  : null;

const FLUSH_MS = Number(process.env.STORE_FLUSH_MS || 600000);
// Observations are 60s-granularity score/price snapshots, so they tolerate a
// longer flush. Keeping them on a slower cycle holds total writes under the
// free tier's 20k/day: ~60 pools every 10min + ~60 tokens every 30min.
const OBSERVATION_FLUSH_MS = Number(process.env.STORE_OBSERVATION_FLUSH_MS || 1800000);
const LOAD_LIMIT = Number(process.env.STORE_LOAD_LIMIT || 300);
const REQUEST_TIMEOUT_MS = Number(process.env.STORE_TIMEOUT_MS || 12000);

const stats = {
  enabled, projectId: PROJECT_ID,
  writes: 0, reads: 0, errors: 0,
  lastFlushAt: null, lastFlushDocs: 0, lastError: null, loadedAt: null,
  // Round-trip timings, so the admin panel can show what Firestore costs us.
  writeLatency: { last: null, avg: null, min: null, max: null, samples: 0 },
  readLatency: { last: null, avg: null, min: null, max: null, samples: 0 },
  lastFlushMs: null, lastLoadMs: null,
};

function recordLatency(bucket, ms) {
  bucket.last = ms;
  bucket.min = bucket.min === null ? ms : Math.min(bucket.min, ms);
  bucket.max = bucket.max === null ? ms : Math.max(bucket.max, ms);
  bucket.avg = bucket.avg === null ? ms : Math.round((bucket.avg * bucket.samples + ms) / (bucket.samples + 1));
  bucket.samples += 1;
}

// ---------------------------------------------------------------- auth

let tokenCache = { token: null, expiresAt: 0 };

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const iat = Math.floor(Date.now() / 1000);
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: iat, exp: iat + 3600,
  });
  const signature = crypto.createSign("RSA-SHA256").update(unsigned)
    .sign(String(account.private_key).replace(/\\n/g, "\n"), "base64url");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + signature,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error("token exchange failed: " + (body.error_description || body.error || response.status));
  }
  tokenCache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function call(path, options) {
  const token = await accessToken();
  const response = await fetch(BASE + path, Object.assign({
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, options || {}));
  if (!response.ok) {
    const text = await response.text();
    throw new Error("firestore " + response.status + ": " + text.slice(0, 160));
  }
  return response.json();
}

// ------------------------------------------------- value serialisation

// Sample arrays are stored as one JSON string rather than a Firestore array of
// maps: Firestore counts every field name in every array element toward the
// 1 MiB document cap, so a JSON string fits roughly 3x more history per doc.
const str = (v) => ({ stringValue: String(v) });
const int = (v) => ({ integerValue: String(Math.round(v)) });
const readStr = (field) => (field && field.stringValue) || "";
const readInt = (field) => (field && field.integerValue != null ? Number(field.integerValue) : null);

function docId(chainKey, address) {
  return chainKey + "__" + String(address).replace(/\//g, "_");
}

async function writeDoc(collection, id, fields) {
  const startedAt = Date.now();
  const result = await call("/" + collection + "/" + encodeURIComponent(id), {
    method: "PATCH",
    body: JSON.stringify({ fields: fields }),
  });
  recordLatency(stats.writeLatency, Date.now() - startedAt);
  return result;
}

async function readCollection(collection) {
  const out = [];
  let pageToken = null;
  do {
    const query = "?pageSize=" + LOAD_LIMIT + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    const readStartedAt = Date.now();
    const page = await call("/" + collection + query, { method: "GET" });
    recordLatency(stats.readLatency, Date.now() - readStartedAt);
    (page.documents || []).forEach((doc) => out.push(doc));
    pageToken = page.nextPageToken || null;
    stats.reads += (page.documents || []).length;
  } while (pageToken && out.length < LOAD_LIMIT * 10);
  return out;
}

// ---------------------------------------------------------------- api

const dirtyPools = new Set();
const dirtyStages = new Set();
const dirtyHolders = new Set();
const dirtyObservations = new Set();
let flushTimer = null;
let observationTimer = null;
let flushing = false;

/** Marks a pool/token as changed; the next flush writes it. */
function touchPool(chainKey, poolAddress) { if (enabled) dirtyPools.add(docId(chainKey, poolAddress)); }
function touchStage(chainKey, tokenAddress) { if (enabled) dirtyStages.add(docId(chainKey, tokenAddress)); }
function touchHolders(chainKey, tokenAddress) { if (enabled) dirtyHolders.add(docId(chainKey, tokenAddress)); }
function touchObservation(chainKey, tokenAddress) { if (enabled) dirtyObservations.add(docId(chainKey, tokenAddress)); }

/**
 * Reads every persisted series back into the caller's in-memory Maps.
 * Returns counts so the boot log can report what came back.
 */
async function load(stores) {
  if (!enabled) return { enabled: false };
  const counts = { pools: 0, stages: 0, holders: 0, observations: 0 };
  const loadStartedAt = Date.now();
  const note = (error) => {
    stats.errors += 1;
    stats.lastError = error.message;
    console.error("store: read failed -", error.message);
    return [];
  };
  try {
    const pools = await readCollection("poolHistory").catch(note);
    pools.forEach((doc) => {
      const id = doc.name.split("/").pop();
      const samples = JSON.parse(readStr(doc.fields && doc.fields.samples) || "[]");
      if (!Array.isArray(samples) || !samples.length) return;
      const key = id.replace("__", ":");
      stores.historyStore.set(key, { samples: samples, touchedAt: Date.now() });
      counts.pools += 1;
    });

    const stages = await readCollection("stages").catch(note);
    stages.forEach((doc) => {
      const id = doc.name.split("/").pop();
      const f = doc.fields || {};
      const history = JSON.parse(readStr(f.history) || "[]");
      const stage = readStr(f.stage);
      if (!stage) return;
      stores.stageStore.set(id.replace("__", ":"), {
        stage: stage, since: readInt(f.since) || Date.now(),
        history: Array.isArray(history) ? history : [],
      });
      counts.stages += 1;
    });

    const holders = await readCollection("holders").catch(note);
    holders.forEach((doc) => {
      const id = doc.name.split("/").pop();
      const series = JSON.parse(readStr(doc.fields && doc.fields.series) || "[]");
      if (!Array.isArray(series) || !series.length) return;
      stores.holderHistory.set(id.replace("__", ":"), series);
      counts.holders += 1;
    });

    // Score/price snapshots per token - the series outcome tracking reads.
    if (stores.observationStore) {
      const observations = await readCollection("observations").catch(note);
      observations.forEach((doc) => {
        const id = doc.name.split("/").pop();
        const series = JSON.parse(readStr(doc.fields && doc.fields.series) || "[]");
        if (!Array.isArray(series) || !series.length) return;
        stores.observationStore.set(id.replace("__", ":"), series);
        counts.observations += 1;
      });
    }
    stats.loadedAt = Date.now();
    stats.lastLoadMs = Date.now() - loadStartedAt;
  } catch (error) {
    stats.errors += 1;
    stats.lastError = error.message;
  }
  return Object.assign({ enabled: true }, counts);
}

/** Writes everything marked dirty. Called on a timer and on shutdown. */
async function flush(stores, reason) {
  if (!enabled || flushing) return 0;
  const pools = Array.from(dirtyPools); dirtyPools.clear();
  const stages = Array.from(dirtyStages); dirtyStages.clear();
  const holders = Array.from(dirtyHolders); dirtyHolders.clear();
  if (!pools.length && !stages.length && !holders.length) return 0;

  flushing = true;
  const flushStartedAt = Date.now();
  let written = 0;
  try {
    for (const id of pools) {
      const series = stores.historyStore.get(id.replace("__", ":"));
      if (!series || !series.samples || !series.samples.length) continue;
      const [chainKey, pool] = id.split("__");
      const first = series.samples[0];
      const last = series.samples[series.samples.length - 1];
      await writeDoc("poolHistory", id, {
        chain: str(chainKey), pool: str(pool),
        // Identity, so a document is readable without cross-referencing the feed.
        symbol: str(series.symbol || ""),
        token: str(series.tokenAddress || ""),
        updatedAt: int(Date.now()),
        sampleCount: int(series.samples.length),
        firstSampleAt: int(first.t), lastSampleAt: int(last.t),
        samples: str(JSON.stringify(series.samples)),
      });
      written += 1;
    }
    for (const id of stages) {
      const entry = stores.stageStore.get(id.replace("__", ":"));
      if (!entry) continue;
      const [chainKey, token] = id.split("__");
      await writeDoc("stages", id, {
        chain: str(chainKey), token: str(token),
        stage: str(entry.stage), since: int(entry.since),
        history: str(JSON.stringify(entry.history || [])),
        updatedAt: int(Date.now()),
      });
      written += 1;
    }
    for (const id of holders) {
      const series = stores.holderHistory.get(id.replace("__", ":"));
      if (!series || !series.length) continue;
      const [chainKey, token] = id.split("__");
      await writeDoc("holders", id, {
        chain: str(chainKey), token: str(token),
        series: str(JSON.stringify(series)), updatedAt: int(Date.now()),
      });
      written += 1;
    }
    stats.writes += written;
    stats.lastFlushAt = Date.now();
    stats.lastFlushMs = Date.now() - flushStartedAt;
    stats.lastFlushDocs = written;
    if (written) console.log("store: flushed " + written + " docs (" + (reason || "timer") + ")");
  } catch (error) {
    stats.errors += 1;
    stats.lastError = error.message;
    console.error("store: flush failed -", error.message);
  } finally {
    flushing = false;
  }
  return written;
}

/**
 * Score/price snapshots, on their own slower cycle. One document per token
 * holds the whole series, so a longer interval costs nothing but writes.
 */
async function flushObservations(stores, reason) {
  if (!enabled || !stores.observationStore) return 0;
  const ids = Array.from(dirtyObservations);
  dirtyObservations.clear();
  if (!ids.length) return 0;
  let written = 0;
  try {
    for (const id of ids) {
      const series = stores.observationStore.get(id.replace("__", ":"));
      if (!series || !series.length) continue;
      const [chainKey, token] = id.split("__");
      const last = series[series.length - 1];
      await writeDoc("observations", id, {
        chain: str(chainKey), token: str(token),
        symbol: str(last.symbol || ""),
        lastStage: str(last.stage || ""), lastScore: int(last.score || 0),
        sampleCount: int(series.length),
        firstSampleAt: int(series[0].t), lastSampleAt: int(last.t),
        series: str(JSON.stringify(series)), updatedAt: int(Date.now()),
      });
      written += 1;
    }
    stats.writes += written;
    if (written) console.log("store: flushed " + written + " observation docs (" + (reason || "timer") + ")");
  } catch (error) {
    stats.errors += 1;
    stats.lastError = error.message;
    console.error("store: observation flush failed -", error.message);
  }
  return written;
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

/** Everything, for shutdown. */
function flushAll(stores, reason) {
  return Promise.all([flush(stores, reason), flushObservations(stores, reason)])
    .then(([a, b]) => a + b);
}


/**
 * Measures an actual Firestore round trip: one write, then one read back of
 * the same document. Used by the admin panel's "test now" button so the
 * numbers shown are current rather than averaged over the process lifetime.
 */
async function probe() {
  if (!enabled) return { enabled: false };
  const id = "_probe";
  const stamp = Date.now();
  const out = { enabled: true, at: stamp };
  try {
    const w0 = Date.now();
    await writeDoc("_admin", id, { at: int(stamp), note: str("admin panel latency probe") });
    out.writeMs = Date.now() - w0;

    const r0 = Date.now();
    const doc = await call("/_admin/" + id, { method: "GET" });
    out.readMs = Date.now() - r0;
    out.roundTripMs = out.writeMs + out.readMs;
    out.verified = readInt(doc.fields && doc.fields.at) === stamp;
  } catch (error) {
    out.error = error.message;
    stats.errors += 1;
    stats.lastError = error.message;
  }
  return out;
}

/**
 * Lists a collection's documents without their heavy series payloads, so the
 * admin panel can show what is stored and how fresh it is.
 */
async function inspect(collection, limit) {
  if (!enabled) return { enabled: false, documents: [] };
  const max = Math.min(Number(limit) || 25, 100);
  const startedAt = Date.now();
  const page = await call("/" + collection + "?pageSize=" + max, { method: "GET" });
  const documents = (page.documents || []).map((doc) => {
    const f = doc.fields || {};
    const series = readStr(f.samples) || readStr(f.series) || readStr(f.history) || "";
    return {
      id: doc.name.split("/").pop(),
      chain: readStr(f.chain) || null,
      symbol: readStr(f.symbol) || null,
      token: readStr(f.token) || null,
      pool: readStr(f.pool) || null,
      stage: readStr(f.stage) || readStr(f.lastStage) || null,
      sampleCount: readInt(f.sampleCount),
      firstSampleAt: readInt(f.firstSampleAt),
      lastSampleAt: readInt(f.lastSampleAt),
      updatedAt: readInt(f.updatedAt),
      payloadBytes: series.length,
      createTime: doc.createTime || null,
    };
  });
  return {
    enabled: true, collection: collection,
    fetchedInMs: Date.now() - startedAt,
    count: documents.length,
    hasMore: Boolean(page.nextPageToken),
    documents: documents,
  };
}

/** Pending-write counts, for the admin panel's queue view. */
function pending() {
  return {
    pools: dirtyPools.size, stages: dirtyStages.size,
    holders: dirtyHolders.size, observations: dirtyObservations.size,
  };
}

module.exports = {
  enabled, stats,
  flushIntervalMs: FLUSH_MS,
  observationFlushIntervalMs: OBSERVATION_FLUSH_MS,
  load, flush, flushObservations, flushAll, startAutoFlush, stopAutoFlush,
  touchPool, touchStage, touchHolders, touchObservation,
  probe, inspect, pending,
};
