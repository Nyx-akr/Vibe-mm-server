"use strict";

/**
 * Sharing layer - everything needed to put this collector on the public
 * internet, and nothing the collector needs to run locally.
 *
 * The collector and the raw store are untouched by this file. `server.js`
 * calls `handle()` once, before its own routes; when sharing is off, or when
 * a request is not ours, `handle()` returns false and the server behaves
 * exactly as it did before this module existed. Delete the file and the one
 * call site and nothing else changes.
 *
 * What it adds, and why each part is needed to share a link:
 *
 *   - THE APP. The collector serves raw JSON; the dashboard is a separate
 *     static build. A visitor needs both from ONE origin, because the app
 *     picks its data origin per browser (localStorage) and a stranger's
 *     "localhost" is their own machine, not this one. Served from the same
 *     port, the app reads /raw off the origin it was loaded from and there is
 *     nothing for a visitor to configure.
 *
 *   - GZIP. A raw file like solana/observations.json is ~4.6 MB of JSON, and
 *     there is one per chain. Uncompressed, a first load is tens of megabytes
 *     off a home upload link, per visitor. JSON compresses by roughly 85%.
 *     Compression is negotiated, so a client that does not ask still gets the
 *     bytes raw-store.js wrote.
 *
 *   - PATH REDACTION. /health reports raw.dir and store.dir, which are
 *     absolute paths on the machine running this. The supervisor needs them;
 *     the internet does not. Remote callers get the liveness fields only.
 *
 * Off by default in the sense that matters: with no built app and no
 * SHARE_WEB_DIR, the only thing it does is compress, and it never intercepts
 * /raw or /health content - it re-serves the same bytes.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/** The built dashboard. Sibling repo by default, overridable for odd layouts. */
const WEB_DIR = path.resolve(
  process.env.SHARE_WEB_DIR ||
  path.join(__dirname, "..", "..", "Vibe-MM-React", "dist")
);

const GZIP_ENABLED = process.env.SHARE_GZIP !== "off";
/** Below this, framing and CPU cost more than the bytes saved. */
const GZIP_MIN_BYTES = Number(process.env.SHARE_GZIP_MIN || 1024);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Text compresses; images, fonts and archives are already compressed. */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg)/;

const stats = {
  appRequests: 0,
  rawRequests: 0,
  compressed: 0,
  bytesOut: 0,
  bytesSaved: 0,
  lastRequestAt: null,
};

/** Is the dashboard build present? Checked per call so a build mid-run lands. */
function webRoot() {
  try {
    return fs.statSync(path.join(WEB_DIR, "index.html")).isFile() ? WEB_DIR : null;
  } catch (error) {
    return null;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/**
 * Is this the supervisor, or someone out on the internet?
 *
 * The socket address alone is not the answer, and getting that wrong leaks
 * the very thing this is here to protect: a tunnel runs ON this machine and
 * connects to the server over loopback, so every visitor looks like
 * 127.0.0.1. Verified by watching /health through a live trycloudflare URL
 * return the full payload, absolute paths and all.
 *
 * Local means all three: a loopback socket, no proxy forwarding headers, and
 * a Host the caller could only have written by dialling this machine
 * directly. Anything else is treated as remote, which is the safe way round -
 * the worst case is the supervisor seeing fewer fields than it needs, and it
 * only reads `status`.
 */
function isLocalCaller(request) {
  const address = (request.socket && request.socket.remoteAddress) || "";
  if (!LOOPBACK.has(address)) return false;

  const h = request.headers || {};
  if (h["x-forwarded-for"] || h["x-forwarded-host"] || h["x-real-ip"] ||
      h["cf-connecting-ip"] || h["cf-ray"] || h["forwarded"]) return false;

  // "127.0.0.1:8787" -> "127.0.0.1"; also handles a bracketed IPv6 host.
  const host = String(h.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK.has(host) || host === "";
}

function acceptsGzip(request) {
  return GZIP_ENABLED && /\bgzip\b/.test(String(request.headers["accept-encoding"] || ""));
}

/**
 * Sends a body, compressed when it is worth it and the client asked.
 *
 * Content-Length is set from the bytes actually sent, so a 304 on the next
 * request still matches: the ETag describes the file, not the encoding, and
 * Vary tells any cache in between that the two differ.
 */
function send(request, response, status, body, type, extraHeaders) {
  const headers = Object.assign({ "Content-Type": type }, extraHeaders || {});
  let out = body;
  if (COMPRESSIBLE.test(type) && body.length >= GZIP_MIN_BYTES && acceptsGzip(request)) {
    const zipped = zlib.gzipSync(body);
    // Pathological inputs can grow. Send whichever is smaller.
    if (zipped.length < body.length) {
      stats.compressed += 1;
      stats.bytesSaved += body.length - zipped.length;
      out = zipped;
      headers["Content-Encoding"] = "gzip";
    }
  }
  headers["Vary"] = headers["Vary"] ? headers["Vary"] + ", Accept-Encoding" : "Accept-Encoding";
  headers["Content-Length"] = out.length;
  stats.bytesOut += out.length;
  response.writeHead(status, headers);
  if (request.method === "HEAD") { response.end(); return; }
  response.end(out);
}

/** Resolves a URL path inside a root, refusing anything that escapes it. */
function safeJoin(root, rel) {
  const full = path.resolve(root, "." + path.sep + rel.replace(/^\/+/, ""));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return full === root || full.startsWith(prefix) ? full : null;
}

/**
 * A raw file, gzipped. Same ETag, same 304 behaviour, same bytes on the wire
 * when the client does not accept gzip - in which case this declines and
 * raw-store.js serves it as before.
 */
function serveRawCompressed(rel, request, response, rawStore) {
  if (!acceptsGzip(request)) return false;
  const full = safeJoin(rawStore.dir, rel);
  if (!full) return false;
  let stat;
  try { stat = fs.statSync(full); } catch (error) { return false; }
  if (!stat.isFile() || stat.size < GZIP_MIN_BYTES) return false;

  // Byte-identical to raw-store.js, so a client can move between the two
  // paths without its cached copy being invalidated.
  const etag = 'W/"' + stat.size.toString(16) + "-" + Math.floor(stat.mtimeMs).toString(16) + '"';
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { ETag: etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding" });
    response.end();
    stats.rawRequests += 1;
    return true;
  }

  let body;
  try { body = fs.readFileSync(full); } catch (error) { return false; }
  stats.rawRequests += 1;
  send(request, response, 200, body, "application/json; charset=utf-8", {
    ETag: etag,
    "Cache-Control": "no-cache",
  });
  return true;
}

/**
 * The dashboard. Hashed asset filenames are immutable and cached hard;
 * index.html never is, so a rebuild reaches an open tab on reload.
 *
 * Unknown paths fall back to index.html because the app routes client-side
 * (/admin is a route, not a file) - but only for document requests, so a
 * missing asset still 404s instead of returning HTML that fails to parse.
 */
function serveApp(request, response, pathname) {
  const root = webRoot();
  if (!root) return false;

  let rel = pathname === "/" ? "/index.html" : pathname;
  let full = safeJoin(root, rel);
  let isFallback = false;

  const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } };

  if (!exists(full)) {
    const looksLikeFile = path.extname(rel) !== "";
    if (looksLikeFile) return false;
    full = path.join(root, "index.html");
    isFallback = true;
    if (!exists(full)) return false;
  }

  let body;
  try { body = fs.readFileSync(full); } catch (error) { return false; }

  const ext = path.extname(full).toLowerCase();
  const type = TYPES[ext] || "application/octet-stream";
  const hashed = /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(path.basename(full));
  stats.appRequests += 1;
  stats.lastRequestAt = Date.now();
  send(request, response, 200, body, type, {
    "Cache-Control": isFallback || !hashed
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });
  return true;
}

/** /health for a caller that is not the supervisor: liveness, no file paths. */
function serveRedactedHealth(request, response, healthData) {
  const full = healthData();
  const body = Buffer.from(JSON.stringify({
    status: full.status,
    service: full.service,
    role: full.role,
    timestamp: full.timestamp,
    uptimeSeconds: full.uptimeSeconds,
    chains: full.chains,
    raw: full.raw ? {
      writes: full.raw.writes,
      errors: full.raw.errors,
      lastWriteAt: full.raw.lastWriteAt,
    } : null,
    shared: true,
  }));
  send(request, response, 200, body, "application/json; charset=utf-8");
  return true;
}

/**
 * The one hook. Returns true when this module answered the request.
 *
 * Order matters: /raw and /health keep their meaning and are only re-served
 * (compressed, redacted); the app is offered last, so it can never shadow a
 * collector route.
 */
function handle(request, response, url, deps) {
  const pathname = url.pathname;
  const d = deps || {};

  if (pathname.startsWith("/raw/")) {
    if (!d.rawStore) return false;
    const rel = decodeURIComponent(pathname.slice("/raw/".length));
    try {
      return serveRawCompressed(rel, request, response, d.rawStore);
    } catch (error) {
      return false; // any trouble here: let the plain path serve it
    }
  }

  if (pathname === "/health") {
    if (isLocalCaller(request) || !d.healthData) return false;
    try {
      return serveRedactedHealth(request, response, d.healthData);
    } catch (error) {
      return false;
    }
  }

  try {
    return serveApp(request, response, pathname);
  } catch (error) {
    return false;
  }
}

/** Where the dashboard is being served from, or null when there is no build. */
function webStatus() {
  const root = webRoot();
  return { serving: Boolean(root), dir: root || WEB_DIR, gzip: GZIP_ENABLED };
}

module.exports = { handle, webStatus, stats, WEB_DIR };
