"use strict";

/**
 * Upstream HTTP: rate gate, timeout, cache, in-flight dedup and telemetry.
 *
 * This is the only file that talks to the outside world. It has no opinion
 * about what the bytes mean - it fetches, caches and counts.
 */

const { USER_AGENT } = require("./chains");

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 9000);

/* ---------------------------------------------------------------- telemetry */

const upstreamCalls = { total: 0, byHost: {}, since: Date.now() };
const upstreamLatency = {};

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return "unknown"; }
}

function countUpstream(url) {
  const host = hostOf(url);
  upstreamCalls.total += 1;
  upstreamCalls.byHost[host] = (upstreamCalls.byHost[host] || 0) + 1;
}

function recordUpstream(url, ms, error) {
  const host = hostOf(url);
  const l = upstreamLatency[host] ||
    (upstreamLatency[host] = { calls: 0, errors: 0, samples: [], lastError: null });
  l.calls += 1;
  if (error) { l.errors += 1; l.lastError = String(error.message || error).slice(0, 120); }
  else { l.samples.push(ms); if (l.samples.length > 60) l.samples.shift(); }
}

/**
 * Raw latency counters, forwarded as-is. The app turns these into p50/p95 and
 * error rates - the server does not, because that is a calculation.
 */
function upstreamTelemetry() {
  return {
    since: upstreamCalls.since,
    total: upstreamCalls.total,
    byHost: upstreamCalls.byHost,
    providers: Object.keys(upstreamLatency).map((host) => ({
      provider: host,
      calls: upstreamLatency[host].calls,
      errors: upstreamLatency[host].errors,
      lastError: upstreamLatency[host].lastError,
      latencySamplesMs: upstreamLatency[host].samples.slice(),
    })),
  };
}

/* --------------------------------------------------------------- rate gate */

/**
 * GeckoTerminal's keyless tier allows roughly 30 calls a minute, and Render's
 * free tier shares outbound IPs. Bursts are spaced out rather than failed.
 */
const GT_RATE_LIMIT = Number(process.env.GT_RATE_LIMIT || 25);
const GT_MAX_WAIT_MS = Number(process.env.GT_MAX_WAIT_MS || 6000);
const gtCallTimes = [];

async function geckoTerminalGate() {
  const deadline = Date.now() + GT_MAX_WAIT_MS;
  for (;;) {
    const now = Date.now();
    while (gtCallTimes.length && now - gtCallTimes[0] > 60000) gtCallTimes.shift();
    if (gtCallTimes.length < GT_RATE_LIMIT || now >= deadline) { gtCallTimes.push(now); return; }
    const waitMs = Math.min(60000 - (now - gtCallTimes[0]) + 50, deadline - now, 1500);
    await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 50)));
  }
}

/* ------------------------------------------------------------------- fetch */

async function fetchJson(url, options) {
  const timeoutMs = (options && options.timeoutMs) || FETCH_TIMEOUT_MS;
  if (url.indexOf("api.geckoterminal.com") !== -1) await geckoTerminalGate();
  countUpstream(url);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: Object.assign(
        { accept: "application/json", "user-agent": USER_AGENT },
        (options && options.headers) || {},
      ),
    });
    if (!response.ok) {
      const error = new Error("HTTP " + response.status + " from " + hostOf(url));
      error.status = response.status;
      throw error;
    }
    const parsed = await response.json();
    recordUpstream(url, Date.now() - startedAt, null);
    return parsed;
  } catch (error) {
    recordUpstream(url, Date.now() - startedAt, error);
    if (error.name === "AbortError") {
      throw new Error("timeout after " + timeoutMs + "ms from " + hostOf(url));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The same pipe as fetchJson, for upstreams that only speak XML or HTML.
 * Reddit is the reason this exists: its JSON endpoints answer 403 to
 * datacentre IPs, while the Atom feed of the same listing answers 200.
 */
async function fetchText(url, options) {
  const timeoutMs = (options && options.timeoutMs) || FETCH_TIMEOUT_MS;
  countUpstream(url);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: Object.assign(
        { accept: "text/html,application/xhtml+xml,application/xml", "user-agent": USER_AGENT },
        (options && options.headers) || {},
      ),
    });
    if (!response.ok) {
      const error = new Error("HTTP " + response.status + " from " + hostOf(url));
      error.status = response.status;
      throw error;
    }
    const body = await response.text();
    recordUpstream(url, Date.now() - startedAt, null);
    return body;
  } catch (error) {
    recordUpstream(url, Date.now() - startedAt, error);
    if (error.name === "AbortError") {
      throw new Error("timeout after " + timeoutMs + "ms from " + hostOf(url));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- cache */

const cacheStore = new Map();
const inflight = new Map();

async function cached(key, ttlMs, producer) {
  const hit = cacheStore.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const value = await producer();
      cacheStore.set(key, { value: value, expiresAt: Date.now() + ttlMs });
      return value;
    } catch (error) {
      if (hit) return hit.value;
      throw error;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

function cacheStats() {
  return { entries: cacheStore.size, inflight: inflight.size };
}

/* ----------------------------------------------------------------- parsing */

/** Field-level coercion only. Not a calculation - a string "1.5" becomes 1.5. */
function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toTimestampMs(value) {
  if (typeof value === "string" && Number.isNaN(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const number = toNumber(value);
  if (number === null) return null;
  return number > 1e12 ? number : number * 1000;
}

module.exports = {
  fetchJson, fetchText, cached, cacheStats, toNumber, toTimestampMs,
  upstreamTelemetry, FETCH_TIMEOUT_MS,
};
