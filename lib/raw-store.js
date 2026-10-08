"use strict";

/**
 * The raw store - the only thing the app reads.
 *
 * The server's collectors write every provider answer here as plain JSON
 * files, and the app reads those files. There is no request/response between
 * the two: the app never asks the server to fetch, compute or sample anything,
 * and the server never answers the app. It writes; the app reads what was
 * written.
 *
 *   data/raw/manifest.json            what is here and when each file was written
 *   data/raw/<chain>/market.json      the feed rows, each provider's answer side by side
 *   data/raw/<chain>/history.json     rolling 15s samples per pool (the hot window)
 *   data/raw/<chain>/trades.json      wallet-level trade samples per pool
 *   data/raw/<chain>/intel.json       per-token safety/holder/route payloads
 *   data/raw/<chain>/ohlcv.json       minute bars per pool
 *   data/raw/<chain>/observations.json      60s price/liquidity series (hot window)
 *   data/raw/<chain>/observations-48h.json  the same, 48h deep, from the archive
 *   data/raw/<chain>/promotion.json   DexScreener boosts/profiles
 *   data/raw/social.json              the social corpus
 *   data/raw/reference.json           CEX/aggregator reference quotes per symbol
 *   data/raw/coverage.json            what the archive recorded, per bucket
 *   data/raw/system.json              process counters, upstream telemetry, archive health
 *
 * Every file is written whole to a temp name and renamed over the old one, so
 * a reader sees the previous complete file or the new complete file, never a
 * half-written one.
 *
 * The files are served by `serve()` as bytes off disk - no query parameters, no
 * logic, no upstream calls. A 304 answers an unchanged file, so the app can
 * re-read a megabyte corpus every few seconds for the price of a stat().
 */

const fs = require("fs");
const path = require("path");
const archive = require("./archive");

const DIR = path.resolve(process.env.RAW_DIR || path.join(archive.dir, "raw"));
const MANIFEST = "manifest.json";

let ready = false;
let lastError = null;

function ensure() {
  if (ready) return true;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    ready = true;
  } catch (error) {
    lastError = error.message;
  }
  return ready;
}

/** `rel` is a forward-slash path under DIR; anything that escapes it is refused. */
function resolve(rel) {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.split("/").some((part) => part === ".." || part === "")) return null;
  if (!/^[a-z0-9_./-]+\.json$/i.test(clean)) return null;
  const full = path.join(DIR, clean);
  return full.startsWith(DIR + path.sep) ? full : null;
}

const manifest = { files: {} };
const stats = { writes: 0, bytes: 0, errors: 0, lastError: null, lastErrorAt: null, lastWriteAt: null };

/**
 * Per-file failures. A lifetime error count cannot say WHICH file readers are
 * stuck on: a big file OneDrive keeps locked can fail every write while the
 * small ones succeed, and the reader sees a copy hours old with no warning.
 * Only files that have failed at least once appear here.
 */
const failing = {};

function noteFailure(rel, error) {
  stats.errors += 1;
  stats.lastError = error.message || String(error);
  stats.lastErrorAt = Date.now();
  const f = failing[rel] || (failing[rel] = { errors: 0, lastErrorAt: null, lastOkAt: null, lastError: null });
  f.errors += 1;
  f.lastErrorAt = stats.lastErrorAt;
  f.lastError = String(stats.lastError).slice(0, 160);
}

function noteSuccess(rel, at) {
  if (failing[rel]) failing[rel].lastOkAt = at;
}

function writeFileAtomic(full, body) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = full + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, body);
  // A reader holding the old file open can make the rename fail on Windows for
  // a moment. One retry after a short spin covers it; a second failure is real.
  try {
    fs.renameSync(tmp, full);
  } catch (error) {
    const until = Date.now() + 25;
    while (Date.now() < until) { /* spin */ }
    fs.renameSync(tmp, full);
  }
}

/**
 * Writes one raw file. `body` is the provider data as collected; `writtenAt`
 * is stamped on so a reader can always say how old what it is looking at is.
 * Returns the bytes written, 0 on failure. Never throws into a collector.
 */
function write(rel, body) {
  if (!ensure()) return 0;
  const full = resolve(rel);
  if (!full) { noteFailure(rel, new Error("refused path " + rel)); return 0; }
  const at = Date.now();
  try {
    const text = JSON.stringify(Object.assign({ writtenAt: at }, body));
    writeFileAtomic(full, text);
    const bytes = Buffer.byteLength(text);
    manifest.files[rel] = { at: at, bytes: bytes };
    stats.writes += 1;
    stats.bytes += bytes;
    stats.lastWriteAt = at;
    noteSuccess(rel, at);
    scheduleManifest();
    return bytes;
  } catch (error) {
    noteFailure(rel, error);
    return 0;
  }
}

/** Reads a raw file back, for the server's own boot restore. Null if absent. */
function read(rel) {
  const full = resolve(rel);
  if (!full) return null;
  try { return JSON.parse(fs.readFileSync(full, "utf8")); } catch (error) { return null; }
}

// The manifest is rewritten at most once a second rather than on every file,
// because a collector pass writes several files back to back.
let manifestTimer = null;
function scheduleManifest() {
  if (manifestTimer) return;
  manifestTimer = setTimeout(() => {
    manifestTimer = null;
    try {
      writeFileAtomic(path.join(DIR, MANIFEST), JSON.stringify({
        service: "vibescreener-raw-store",
        writtenAt: Date.now(),
        files: manifest.files,
      }));
      noteSuccess(MANIFEST, Date.now());
    } catch (error) {
      noteFailure(MANIFEST, error);
    }
  }, 1000);
  if (manifestTimer.unref) manifestTimer.unref();
}

/** Picks the previous manifest back up, so file ages survive a restart. */
function loadManifest() {
  const prior = read(MANIFEST);
  if (prior && prior.files) Object.assign(manifest.files, prior.files);
}

/**
 * Serves one file as bytes. GET/HEAD only, no query handling, weak ETag from
 * size + mtime so an unchanged file costs a 304.
 */
function serve(rel, request, response) {
  const full = resolve(rel);
  if (!full) { response.writeHead(404); response.end(); return; }
  let stat;
  try { stat = fs.statSync(full); } catch (error) {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not written yet", path: rel }));
    return;
  }
  const etag = 'W/"' + stat.size.toString(16) + "-" + Math.floor(stat.mtimeMs).toString(16) + '"';
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.headers["if-none-match"] === etag) { response.writeHead(304); response.end(); return; }
  response.setHeader("Content-Length", stat.size);
  response.writeHead(200);
  if (request.method === "HEAD") { response.end(); return; }
  fs.createReadStream(full).on("error", () => response.destroy()).pipe(response);
}

module.exports = {
  dir: DIR,
  get error() { return lastError; },
  stats, manifest, failing,
  ensure, write, read, serve, loadManifest,
};
