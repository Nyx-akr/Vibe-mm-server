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

/**
 * Lifetime counters cannot recover: a provider that failed for an hour after
 * boot reads as failing all day. So calls are also counted into one-minute
 * buckets, the last hour kept, and each error is filed by kind - a 429 is us
 * going too fast, a 404 is usually "that token is unknown", a timeout or a 5xx
 * is the provider. Counting, not judging: the app decides what they mean.
 */
const MINUTE_MS = 60000;
const MINUTES_KEPT = 60;

function errorKind(error) {
  const status = Number(error && error.status);
  if (status === 429) return "rateLimited";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  if (error && (error.name === "AbortError" || /timeout|aborted/i.test(String(error.message)))) return "timeout";
  return "network";
}

function recordUpstream(url, ms, error) {
  const host = hostOf(url);
  const l = upstreamLatency[host] ||
    (upstreamLatency[host] = { calls: 0, errors: 0, samples: [], lastError: null, lastErrorAt: null,
      lastOkAt: null, errorKinds: {}, minutes: [] });
  l.calls += 1;
  const minute = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  let bucket = l.minutes[l.minutes.length - 1];
  if (!bucket || bucket.t !== minute) {
    bucket = { t: minute, calls: 0, errors: 0, kinds: {}, msSum: 0, ok: 0 };
    l.minutes.push(bucket);
    while (l.minutes.length && l.minutes[0].t <= minute - MINUTES_KEPT * MINUTE_MS) l.minutes.shift();
  }
  bucket.calls += 1;
  if (error) {
    const kind = errorKind(error);
    l.errors += 1;
    l.lastError = String(error.message || error).slice(0, 120);
    l.lastErrorAt = Date.now();
    l.errorKinds[kind] = (l.errorKinds[kind] || 0) + 1;
    bucket.errors += 1;
    bucket.kinds[kind] = (bucket.kinds[kind] || 0) + 1;
  } else {
    l.samples.push(ms); if (l.samples.length > 60) l.samples.shift();
    l.lastOkAt = Date.now();
    bucket.ok += 1;
    bucket.msSum += ms;
  }
}

/**
 * Raw latency counters, forwarded as-is. The app turns these into p50/p95 and
 * error rates - the server does not, because that is a calculation.
 */
function upstreamTelemetry() {
  return {
    since: upstreamCalls.since,
    total: upstreamCalls.total,
    // GeckoTerminal's pacing right now: the adapted gap, the configured
    // floor and ceiling, and calls the gate held back (never sent).
    geckoterminal: {
      gapMs: gtGapMs, minGapMs: GT_MIN_GAP_MS, maxGapMs: GT_MAX_GAP_MS,
      perMinuteCap: GT_RATE_LIMIT, blockedUntil: gtBlockedUntil,
      queuedUntil: gtNextSlot, gated: Object.assign({}, gtGated),
    },
    byHost: upstreamCalls.byHost,
    providers: Object.keys(upstreamLatency).map((host) => ({
      provider: host,
      calls: upstreamLatency[host].calls,
      errors: upstreamLatency[host].errors,
      lastError: upstreamLatency[host].lastError,
      lastErrorAt: upstreamLatency[host].lastErrorAt,
      lastOkAt: upstreamLatency[host].lastOkAt,
      errorKinds: Object.assign({}, upstreamLatency[host].errorKinds),
      latencySamplesMs: upstreamLatency[host].samples.slice(),
      minuteMs: MINUTE_MS,
      minutes: upstreamLatency[host].minutes.map((b) =>
        ({ t: b.t, calls: b.calls, errors: b.errors, ok: b.ok, msSum: b.msSum, kinds: Object.assign({}, b.kinds) })),
    })),
  };
}

/* --------------------------------------------------------------- rate gate */

/**
 * GeckoTerminal's keyless tier is documented at ~30 calls a minute, but what
 * it actually ACCEPTS from us is about 9: measured on 2026-09-29, every one
 * of twenty straight minutes let 7-10 calls through and answered 429 to the
 * rest, while the gate was allowing 25. So the budget is ~10 a minute, and
 * anything above it is wasted calls that only prolong the 429s.
 */
const GT_RATE_LIMIT = Number(process.env.GT_RATE_LIMIT || 10);
/**
 * Calls are also SPACED, not just counted. GeckoTerminal answers 429 to a
 * burst well under its per-minute figure (measured: the second of two calls
 * a fraction of a second apart), so a per-minute budget alone let the boot
 * pass fire 8 pool lists at once and trip it. Nobody waits on these calls any
 * more - the collectors do - so queueing is cheap and the wait can be long.
 *
 * The gap ADAPTS: each 429 widens it by half (up to GT_MAX_GAP_MS), each
 * success narrows it by 2% back toward GT_MIN_GAP_MS. If GeckoTerminal
 * tightens or loosens its limit again, the pace follows without a redeploy.
 */
const GT_MIN_GAP_MS = Number(process.env.GT_MIN_GAP_MS || 6500);
const GT_MAX_GAP_MS = Number(process.env.GT_MAX_GAP_MS || 30000);
const GT_MAX_WAIT_MS = Number(process.env.GT_MAX_WAIT_MS || 60000);
const gtCallTimes = [];
let gtNextSlot = 0;
let gtGapMs = GT_MIN_GAP_MS;
/** Calls the gate refused before they left - never sent, so never counted as provider errors. */
const gtGated = { cooldown: 0, queueFull: 0, deferred: 0 };

function gtBackoff() { gtGapMs = Math.min(GT_MAX_GAP_MS, Math.round(gtGapMs * 1.5)); }
function gtRecover() { gtGapMs = Math.max(GT_MIN_GAP_MS, Math.round(gtGapMs * 0.98)); }

function gated(message, kind) {
  gtGated[kind] += 1;
  const error = new Error(message);
  error.status = 429;
  // Refused by us, not by GeckoTerminal: a caller should wait its turn, not
  // mark the target as failed.
  error.gated = kind;
  return error;
}

/**
 * After a 429 every GeckoTerminal caller backs off together. Without this the
 * gate only spaced calls out: each collector kept retrying on its own clock
 * (a failed pool list every 5s, per chain), and those retries are what kept
 * the limit tripped. Failing fast during the cooldown lets every caller fall
 * back to its last good data instead.
 */
const GT_COOLDOWN_MS = Number(process.env.GT_COOLDOWN_MS || 10000);
let gtBlockedUntil = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));

/**
 * `priority: "low"` is for work that can simply wait for the next tick - bars,
 * which only draw a chart. It takes a slot only when the gate is free right
 * now, so it never queues ahead of the pool lists and trades the board needs.
 */
async function geckoTerminalGate(priority) {
  if (Date.now() < gtBlockedUntil) {
    throw gated("HTTP 429 from api.geckoterminal.com (cooling down " +
      Math.ceil((gtBlockedUntil - Date.now()) / 1000) + "s)", "cooldown");
  }
  if (priority === "low" && gtNextSlot > Date.now()) {
    throw gated("GeckoTerminal busy - low-priority call deferred", "deferred");
  }
  // Take the next evenly spaced slot. Slots are claimed synchronously, so
  // callers that arrive together are queued in arrival order, not released
  // together.
  const gap = gtGapMs;
  const slot = Math.max(Date.now(), gtNextSlot);
  gtNextSlot = slot + gap;
  if (slot - Date.now() > GT_MAX_WAIT_MS) {
    gtNextSlot -= gap;
    throw gated("GeckoTerminal queue full (" + Math.round((slot - Date.now()) / 1000) + "s deep)", "queueFull");
  }
  await sleep(slot - Date.now());
  for (;;) {
    const now = Date.now();
    while (gtCallTimes.length && now - gtCallTimes[0] > 60000) gtCallTimes.shift();
    if (gtCallTimes.length < GT_RATE_LIMIT) { gtCallTimes.push(now); return; }
    await sleep(Math.min(60000 - (now - gtCallTimes[0]) + 50, 1500));
  }
}

/* ------------------------------------------------------------------- fetch */

async function fetchJson(url, options) {
  const timeoutMs = (options && options.timeoutMs) || FETCH_TIMEOUT_MS;
  const isGt = url.indexOf("api.geckoterminal.com") !== -1;
  if (isGt) await geckoTerminalGate(options && options.priority);
  countUpstream(url);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, Object.assign(
      {
        signal: controller.signal,
        headers: Object.assign(
          { accept: "application/json", "user-agent": USER_AGENT },
          (options && options.headers) || {},
        ),
      },
      // Bulk endpoints need POST (Ethos scores hundreds of identities in one
      // call). Passed through only when asked for, so every existing caller
      // stays a GET.
      options && options.method ? { method: options.method } : null,
      options && options.body ? { body: options.body } : null,
    ));
    if (!response.ok) {
      const error = new Error("HTTP " + response.status + " from " + hostOf(url));
      error.status = response.status;
      if (response.status === 429 && isGt) {
        const retryAfter = Number(response.headers.get("retry-after")) * 1000;
        gtBlockedUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, 120000) : GT_COOLDOWN_MS);
        gtBackoff();
      }
      throw error;
    }
    const parsed = await response.json();
    if (isGt) gtRecover();
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
