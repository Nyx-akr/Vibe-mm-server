"use strict";

/**
 * THE THIRD STORE - what the app computed, kept on disk so everyone sees it.
 *
 * The first two stores are split by who writes them: the RAW store is provider
 * data the collector fetched, the APP store (IndexedDB) is what one browser
 * worked out. That second one is per-browser, so a visitor over the tunnel got
 * an empty history and the owner lost every hour no tab was open.
 *
 * This is the third: the app's RESULTS, on this machine's disk, served to
 * every viewer. The rule the user set:
 *
 *   server off  -> nothing recorded, nobody sees anything
 *   server on   -> results are saved and shown to everyone
 *
 * It deliberately reverses the no-browser-writes half of the raw-store split.
 * What it does NOT reverse: the server still derives nothing. It validates a
 * shape and appends. Every number in here was computed by the app.
 *
 * WRITES ARE LOCAL-ONLY. The tunnel puts this server on the public internet,
 * so an open POST would let any visitor forge scores. Only a caller on this
 * machine may write; everyone else reads. See isLocalCaller in share.js.
 *
 * Layout - one file per chain per UTC hour, mirroring the browser's own trail
 * records, so merging the two is a concatenation rather than a reconciliation:
 *
 *   data/app/<chain>/trail/<hourMs>.json
 *     { writtenAt, chain, hour, keys: [...], tokens: { "<token>": [[t, avg, now, ...parts]] } }
 */

const fs = require("fs");
const path = require("path");

const APP_DIR = process.env.APP_STORE_DIR ||
  path.join(__dirname, "..", "data", "app");

const HOUR_MS = 3600000;
/** Hours older than this are deleted on sweep. Matches the browser's trail. */
const KEEP_MS = Number(process.env.APP_STORE_KEEP_MS || 14 * 24 * HOUR_MS);
/** A mark older than this is refused - a clock-skewed client cannot rewrite history. */
const MAX_BACKDATE_MS = Number(process.env.APP_STORE_BACKDATE_MS || 2 * HOUR_MS);

const stats = {
  writes: 0, bytes: 0, marks: 0, rejected: 0, lastWriteAt: null, lastError: null,
};

function ensure() {
  try { fs.mkdirSync(APP_DIR, { recursive: true }); return true; }
  catch (error) { stats.lastError = error.message; return false; }
}

/** Keeps a relative path inside APP_DIR - no traversal, no absolute paths. */
function resolve(rel) {
  const clean = String(rel || "").replace(/^\/+/, "");
  if (!clean || clean.indexOf("..") !== -1) return null;
  const full = path.join(APP_DIR, clean);
  return full.startsWith(APP_DIR) ? full : null;
}

function writeFileAtomic(full, body) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = full + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, body);
  // Same Windows rename race the raw store hits: a reader holding the old file
  // can fail the rename for an instant. One retry covers it.
  try {
    fs.renameSync(tmp, full);
  } catch (error) {
    const until = Date.now() + 25;
    while (Date.now() < until) { /* spin */ }
    fs.renameSync(tmp, full);
  }
}

const hourOf = (t) => Math.floor(t / HOUR_MS) * HOUR_MS;
const trailRel = (chain, hour) => chain + "/trail/" + hour + ".json";

function readJson(full) {
  try { return JSON.parse(fs.readFileSync(full, "utf8")); } catch (error) { return null; }
}

/**
 * Appends a batch of trail marks.
 *
 * `payload` is { chain, keys: [...], tokens: { token: [[t, avg, now, ...parts], ...] } }
 * exactly as the browser holds them. Marks are bucketed into their own UTC
 * hour, so one post may touch two files across an hour boundary.
 *
 * De-duplicates on timestamp per token: the app may re-post a mark it is not
 * sure landed, and two tabs on the same machine post the same minute.
 */
function appendTrail(payload) {
  if (!ensure()) return { ok: false, error: "store unavailable" };
  const chain = String((payload && payload.chain) || "").trim();
  const tokens = (payload && payload.tokens) || null;
  const keys = (payload && payload.keys) || null;
  if (!/^[a-z0-9_-]{2,24}$/.test(chain) || !tokens || typeof tokens !== "object" ||
      !Array.isArray(keys)) {
    stats.rejected += 1;
    return { ok: false, error: "bad payload" };
  }

  const now = Date.now();
  const oldest = now - MAX_BACKDATE_MS;
  const byHour = new Map();
  let accepted = 0;

  Object.keys(tokens).forEach((token) => {
    if (!/^[A-Za-z0-9:_-]{6,120}$/.test(token)) return;
    const marks = Array.isArray(tokens[token]) ? tokens[token] : [];
    marks.forEach((m) => {
      // A mark is [t, avg, now, ...componentValues] - numbers or null.
      if (!Array.isArray(m) || m.length < 3) return;
      const t = m[0];
      if (!Number.isFinite(t) || t > now + 60000 || t < oldest) return;
      const hour = hourOf(t);
      if (!byHour.has(hour)) byHour.set(hour, new Map());
      const forHour = byHour.get(hour);
      if (!forHour.has(token)) forHour.set(token, []);
      forHour.get(token).push(m);
      accepted += 1;
    });
  });

  if (!accepted) { stats.rejected += 1; return { ok: false, error: "no usable marks" }; }

  let files = 0;
  try {
    byHour.forEach((forHour, hour) => {
      const rel = trailRel(chain, hour);
      const full = resolve(rel);
      if (!full) return;
      const prior = readJson(full);
      // A model change rewrites the component list; an hour keeps one layout
      // rather than mixing two, same rule the browser trail uses.
      const sameLayout = prior && Array.isArray(prior.keys) &&
        prior.keys.join() === keys.join();
      const merged = sameLayout && prior.tokens ? prior.tokens : {};

      forHour.forEach((marks, token) => {
        const existing = Array.isArray(merged[token]) ? merged[token] : [];
        const seen = new Set(existing.map((m) => m[0]));
        const added = marks.filter((m) => !seen.has(m[0]));
        merged[token] = existing.concat(added).sort((a, b) => a[0] - b[0]);
      });

      const text = JSON.stringify({
        writtenAt: Date.now(), chain, hour, keys, tokens: merged,
      });
      writeFileAtomic(full, text);
      files += 1;
      stats.bytes += Buffer.byteLength(text);
    });
    stats.writes += 1;
    stats.marks += accepted;
    stats.lastWriteAt = Date.now();
    stats.lastError = null;
    return { ok: true, accepted, files };
  } catch (error) {
    stats.lastError = error.message;
    return { ok: false, error: error.message };
  }
}

/** Which hours exist for a chain, newest first - the app's read index. */
function trailIndex(chain) {
  const dir = resolve(chain + "/trail");
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((n) => /^\d+\.json$/.test(n))
      .map((n) => Number(n.slice(0, -5)))
      .filter((h) => Number.isFinite(h))
      .sort((a, b) => b - a);
  } catch (error) { return []; }
}

/** Deletes hours past retention. Cheap enough to run on the collector's clock. */
function sweep() {
  if (!fs.existsSync(APP_DIR)) return 0;
  const dropBefore = Date.now() - KEEP_MS;
  let removed = 0;
  try {
    fs.readdirSync(APP_DIR).forEach((chain) => {
      const dir = path.join(APP_DIR, chain, "trail");
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach((name) => {
        const hour = Number(String(name).replace(/\.json$/, ""));
        if (Number.isFinite(hour) && hour + HOUR_MS < dropBefore) {
          try { fs.unlinkSync(path.join(dir, name)); removed += 1; } catch (e) { /* next sweep */ }
        }
      });
    });
  } catch (error) { stats.lastError = error.message; }
  return removed;
}

function sizeOnDisk() {
  let bytes = 0;
  let files = 0;
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else { try { bytes += fs.statSync(full).size; files += 1; } catch (err) { /* skip */ } }
    });
  };
  walk(APP_DIR);
  return { bytes, files };
}

function health() {
  const chains = fs.existsSync(APP_DIR)
    ? fs.readdirSync(APP_DIR).filter((n) => fs.existsSync(path.join(APP_DIR, n, "trail")))
    : [];
  return Object.assign({
    dir: APP_DIR,
    chains: chains.map((c) => ({ chain: c, hours: trailIndex(c).length })),
    keepMs: KEEP_MS,
  }, stats, sizeOnDisk());
}

/** Serves a stored file read-only, with an ETag so repeat reads are 304s. */
function serve(rel, request, response) {
  const full = resolve(rel);
  if (!full || !fs.existsSync(full)) return false;
  try {
    const stat = fs.statSync(full);
    const etag = '"' + stat.size + "-" + Number(stat.mtimeMs).toString(36) + '"';
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { ETag: etag });
      response.end();
      return true;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      ETag: etag,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(full).pipe(response);
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  APP_DIR, HOUR_MS, KEEP_MS,
  appendTrail, trailIndex, sweep, serve, health, hourOf, trailRel, stats,
};
