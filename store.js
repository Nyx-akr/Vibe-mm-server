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
const LOAD_LIMIT = Number(process.env.STORE_LOAD_LIMIT || 300);
const REQUEST_TIMEOUT_MS = Number(process.env.STORE_TIMEOUT_MS || 12000);

const stats = {
  enabled, projectId: PROJECT_ID,
  writes: 0, reads: 0, errors: 0,
  lastFlushAt: null, lastFlushDocs: 0, lastError: null, loadedAt: null,
};

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

function writeDoc(collection, id, fields) {
  return call("/" + collection + "/" + encodeURIComponent(id), {
    method: "PATCH",
    body: JSON.stringify({ fields: fields }),
  });
}

async function readCollection(collection) {
  const out = [];
  let pageToken = null;
  do {
    const query = "?pageSize=" + LOAD_LIMIT + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    const page = await call("/" + collection + query, { method: "GET" });
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
let flushTimer = null;
let flushing = false;

/** Marks a pool/token as changed; the next flush writes it. */
function touchPool(chainKey, poolAddress) { if (enabled) dirtyPools.add(docId(chainKey, poolAddress)); }
function touchStage(chainKey, tokenAddress) { if (enabled) dirtyStages.add(docId(chainKey, tokenAddress)); }
function touchHolders(chainKey, tokenAddress) { if (enabled) dirtyHolders.add(docId(chainKey, tokenAddress)); }

/**
 * Reads every persisted series back into the caller's in-memory Maps.
 * Returns counts so the boot log can report what came back.
 */
async function load(stores) {
  if (!enabled) return { enabled: false };
  const counts = { pools: 0, stages: 0, holders: 0 };
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
    stats.loadedAt = Date.now();
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
  let written = 0;
  try {
    for (const id of pools) {
      const series = stores.historyStore.get(id.replace("__", ":"));
      if (!series || !series.samples || !series.samples.length) continue;
      const [chainKey, pool] = id.split("__");
      await writeDoc("poolHistory", id, {
        chain: str(chainKey), pool: str(pool),
        updatedAt: int(Date.now()),
        sampleCount: int(series.samples.length),
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

function startAutoFlush(stores) {
  if (!enabled || flushTimer) return;
  flushTimer = setInterval(() => { flush(stores, "timer").catch(() => {}); }, FLUSH_MS);
  flushTimer.unref();
}

function stopAutoFlush() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

module.exports = {
  enabled, stats, flushIntervalMs: FLUSH_MS,
  load, flush, startAutoFlush, stopAutoFlush,
  touchPool, touchStage, touchHolders,
};
