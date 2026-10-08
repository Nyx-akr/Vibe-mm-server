"use strict";

/**
 * The on-disk archive.
 *
 * Two files, because the two jobs pull in opposite directions:
 *
 *   log/YYYY-MM-DD.jsonl   append-only, never rewritten. The complete record
 *                          of everything we ever sampled, at full detail.
 *   snapshot.json          the current in-RAM state, rewritten whole on every
 *                          flush so a restart comes back instantly instead of
 *                          replaying a 70MB log.
 *
 * An append can only ever damage the line it was writing, and a reader skips
 * unparseable lines - so a crash costs at most the last record. The snapshot
 * IS rewritten, which is the dangerous operation, so it goes to a temp file
 * and is renamed over the real one; rename is atomic, so a reader sees either
 * the whole old file or the whole new one, never a half-written mixture.
 *
 * Why JSONL and not CSV: our rows are nested (sources.{geckoterminal,
 * dexscreener,jupiter}, flag arrays, wallet sets). CSV would need those
 * flattened into positional columns, which breaks the first time a field is
 * added and corrupts silently the first time a string contains a comma.
 *
 * No npm dependencies - node:fs only.
 */

const fs = require("node:fs");
const path = require("node:path");

const DIR = process.env.ARCHIVE_DIR || path.join(__dirname, "..", "data");
const LOG_DIR = path.join(DIR, "log");
const SNAPSHOT = path.join(DIR, "snapshot.json");

let ready = false;
let readyError = null;

function ensure() {
  if (ready) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    ready = true;
    readyError = null;
  } catch (error) {
    readyError = error.message;
    ready = false;
  }
  return ready;
}

/* ------------------------------------------------------------- the log -- */

// One write stream, held open, rotated when the calendar day changes. Opening
// a stream per append would cost an open+close syscall pair per record.
let stream = null;
let streamDay = null;

function dayKey(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * True when the file exists and does NOT end in a newline - i.e. a previous
 * process died mid-write and left a partial line. Without this check the next
 * append concatenates onto that fragment, so one torn record would take the
 * following good record down with it.
 */
function endsMidLine(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (!size) return false;
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* closing */ } }
  }
}

function streamFor(at) {
  const day = dayKey(at);
  if (stream && streamDay === day) return stream;
  if (stream) { try { stream.end(); } catch (e) { /* replacing it anyway */ } }
  const file = path.join(LOG_DIR, day + ".jsonl");
  const torn = endsMidLine(file);
  stream = fs.createWriteStream(file, { flags: "a" });
  stream.on("error", (error) => { readyError = error.message; });
  streamDay = day;
  // Terminate the fragment so it fails to parse alone and the next record
  // stays clean. The fragment is lost either way; its neighbour need not be.
  if (torn) stream.write("\n");
  return stream;
}

/**
 * Appends one record. Returns the byte length written, or 0 if the archive is
 * unavailable - callers treat that as "not persisted" rather than throwing,
 * so a full disk degrades the server instead of stopping it.
 */
/**
 * Per-kind record counts for THIS PROCESS. Cheap, because it is counted as we
 * write. It is not the whole file - a restart resets it - which is why scan()
 * exists for the true totals and the admin panel labels the two differently.
 */
const written = new Map();

function append(record) {
  if (!ensure()) return 0;
  const now = Date.now();
  // `t` is EVENT time and may be far in the past (an app row replaying its own
  // history). The day-file is chosen by WRITE time instead - keying it off the
  // payload would scatter backfilled rows into 1970 and thrash the stream
  // closed and open on every alternation between old and new records.
  const line = JSON.stringify(Object.assign({ t: now }, record)) + "\n";
  try {
    streamFor(now).write(line);
    const bytes = Buffer.byteLength(line);
    const kind = record.kind || "unknown";
    const seen = written.get(kind) || { records: 0, bytes: 0, lastAt: null };
    seen.records += 1;
    seen.bytes += bytes;
    seen.lastAt = now;
    written.set(kind, seen);
    return bytes;
  } catch (error) {
    readyError = error.message;
    return 0;
  }
}

/** What this process has appended, by kind. */
function writtenByKind() {
  const out = {};
  written.forEach((value, kind) => { out[kind] = Object.assign({}, value); });
  return out;
}

/**
 * Flushes all the way to disk, so a kill after this cannot lose what we wrote.
 *
 * Two buffers sit in the way and both must be cleared, in order. The stream
 * opens asynchronously and queues writes in JS, so fsync alone would sync an
 * fd that the data had not reached yet - the empty write's callback fires only
 * once everything before it is handed to the fd, and fsync then pushes the OS
 * buffer to the platter.
 */
function sync() {
  return new Promise((resolve) => {
    if (!stream) return resolve();
    try {
      stream.write("", () => {
        const fd = stream && stream.fd;
        if (typeof fd !== "number") return resolve();
        fs.fsync(fd, () => resolve());
      });
    } catch (e) {
      resolve();
    }
  });
}

function close() {
  if (!stream) return;
  try { stream.end(); } catch (e) { /* shutting down */ }
  stream = null;
  streamDay = null;
}

/* -------------------------------------------------------- the snapshot -- */

/** Atomic: write beside the target, then rename over it. */
function writeSnapshot(state) {
  if (!ensure()) return 0;
  const body = JSON.stringify(state);
  const tmp = SNAPSHOT + ".tmp";
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, SNAPSHOT);
    return Buffer.byteLength(body);
  } catch (error) {
    readyError = error.message;
    try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
    return 0;
  }
}

function readSnapshot() {
  if (!ensure()) return null;
  try {
    const raw = fs.readFileSync(SNAPSHOT, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    // Missing is the normal first-boot case; corrupt is not, but the log is
    // still intact either way, so we start empty rather than refusing to boot.
    if (error.code !== "ENOENT") readyError = error.message;
    return null;
  }
}

/* ------------------------------------------------------------ reading --- */

/**
 * Every day-file we hold, newest first, as the stem a reader appends ".jsonl"
 * to. A compacted day is "2026-09-21.1m" and a raw one is "2026-09-21", so
 * both round-trip through `stem + ".jsonl"` to a real path.
 *
 * The stem, not the date, is what readers pass around - which means the date
 * comparison in daysCovering() must tolerate the ".1m" suffix. It does,
 * because the suffix only ever makes the string longer than the bare date it
 * starts with, so a prefix comparison still orders correctly.
 */
function days() {
  if (!ensure()) return [];
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length))
      .sort()
      .reverse();
  } catch (e) {
    return [];
  }
}

/**
 * A string field from the head of a log line, without parsing the line.
 *
 * append() writes `{"t":<ms>,` and then the record's own keys, and every
 * record we write leads with kind (and chain, when it has one). So both sit in
 * the first few dozen characters, while the bulk of a line - samples, trades -
 * comes after. `within` bounds where the field may start, so a nested field
 * of the same name deep in the payload (a trade's own "kind":"buy") is never
 * mistaken for the record's.
 */
function headField(line, name, within) {
  const tag = '"' + name + '":"';
  const at = line.indexOf(tag);
  if (at < 0 || at > within) return null;
  const end = line.indexOf('"', at + tag.length);
  return end < 0 ? null : line.slice(at + tag.length, end);
}

/**
 * Could this line be a record of `kind` (and `chain`)? Only a definite NO
 * skips it: a line whose head we cannot read is parsed as before, so this can
 * make a read faster but never make it miss a record.
 *
 * It is the difference between parsing a whole ~200MB day file and parsing the
 * ~40MB of it a caller wanted - most of what made archive reads block the
 * server for over a minute (2026-10-07).
 */
function mayMatch(line, kind, chain) {
  if (kind) {
    const k = headField(line, "kind", 48);
    if (k !== null && k !== kind) return false;
  }
  if (chain) {
    const c = headField(line, "chain", 96);
    if (c !== null && c !== chain) return false;
  }
  return true;
}

/**
 * Reads records back out of the log. `filter` is applied per record so a
 * caller can ask for one kind, one chain or one token without loading the
 * rest into an array first. `kind` does the same for one kind, but skips
 * other kinds before parsing them, and - unlike `filter` - can be passed to
 * the read worker (see lib/archive-offload.js), since it is data, not code.
 */
function read({ day, kind, filter, limit } = {}) {
  if (!ensure()) return [];
  const wanted = day ? [day] : days();
  const max = Number(limit) || 5000;
  const out = [];
  for (const d of wanted) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(LOG_DIR, d + ".jsonl"), "utf8");
    } catch (e) { continue; }
    // Not one line of this kind anywhere in the file: skip it without
    // splitting 200MB into lines.
    if (kind && raw.indexOf('"kind":"' + kind + '"') < 0) continue;
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line) continue;
      if (kind && !mayMatch(line, kind, null)) continue;
      let record;
      // A torn final line from a crash lands here; skipping it is the whole
      // reason the log is append-only.
      try { record = JSON.parse(line); } catch (e) { continue; }
      if (kind && record.kind !== kind) continue;
      if (filter && !filter(record)) continue;
      out.push(record);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * The records in the last `bytes` of one day file. For checking something
 * that was just appended - the latency probe - without parsing the whole day
 * to find the line it wrote a millisecond ago.
 */
function readTail({ day, bytes = 65536, kind } = {}) {
  if (!ensure()) return [];
  const file = path.join(LOG_DIR, day + ".jsonl");
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    // The first line is cut in half unless the window starts at byte 0.
    const lines = buf.toString("utf8").split("\n");
    if (len < size) lines.shift();
    const out = [];
    for (const line of lines) {
      if (!line || (kind && !mayMatch(line, kind, null))) continue;
      try {
        const record = JSON.parse(line);
        if (!kind || record.kind === kind) out.push(record);
      } catch (e) { /* torn */ }
    }
    return out;
  } catch (e) {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/* ---------------------------------------------------------- compaction -- */

/**
 * Raw days are kept at full 15s detail; older ones are rolled up to one sample
 * per minute and the raw file is dropped.
 *
 * The rollup keeps the LAST sample in each minute rather than averaging. A
 * mean would invent a value that was never observed, and these are already
 * windowed metrics (volume5mUsd, buys5m) where a mean of overlapping windows
 * means very little. Decimation keeps every retained number a real reading.
 *
 * Compacted files are named YYYY-MM-DD.1m.jsonl so the state of each day is
 * visible in a directory listing rather than hidden in a sidecar.
 */
const RETAIN_RAW_DAYS = Number(process.env.ARCHIVE_RAW_DAYS || 7);
const ROLLUP_MS = Number(process.env.ARCHIVE_ROLLUP_MS || 60000);

/** Every day file with its state, newest first. */
function dayFiles() {
  if (!ensure()) return [];
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const compacted = name.endsWith(".1m.jsonl");
        const day = compacted ? name.slice(0, -10) : name.slice(0, -6);
        return { day, name, compacted, file: path.join(LOG_DIR, name) };
      })
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  } catch (e) {
    return [];
  }
}

/**
 * Rolls one day file up to ROLLUP_MS resolution.
 *
 * The new file is written and fsynced under a temp name, renamed into place,
 * and only THEN is the raw file removed - so an interruption at any point
 * leaves either the raw day or the compacted day intact, never neither.
 */
function compactDay(day) {
  if (!ensure()) return { ok: false, error: readyError };
  const src = path.join(LOG_DIR, day + ".jsonl");
  const out = path.join(LOG_DIR, day + ".1m.jsonl");
  const tmp = out + ".tmp";

  let raw;
  try { raw = fs.readFileSync(src, "utf8"); } catch (e) { return { ok: false, error: e.message }; }
  const beforeBytes = Buffer.byteLength(raw);

  // key -> kind/chain/address identity plus a bucket map, so the rewritten
  // file keeps the same record shape readers already understand.
  const groups = new Map();
  let kept = 0;
  let dropped = 0;
  const passthrough = [];

  raw.split("\n").forEach((line) => {
    if (!line) return;
    let record;
    try { record = JSON.parse(line); } catch (e) { return; }
    const rows = record.samples || record.series;
    if (!Array.isArray(rows) || !rows.length) {
      // Rows with no series (app:journal marks, probes) are single events and
      // are carried across untouched - there is nothing to roll up.
      if (record.kind !== "_probe") passthrough.push(record);
      return;
    }
    const address = record.pool || record.token || "";
    const key = record.kind + "|" + (record.chain || "") + "|" + address;
    let group = groups.get(key);
    if (!group) {
      group = { kind: record.kind, chain: record.chain, pool: record.pool, token: record.token,
        symbol: record.symbol, buckets: new Map() };
      groups.set(key, group);
    }
    if (record.symbol && !group.symbol) group.symbol = record.symbol;
    rows.forEach((row) => {
      if (!row || !Number.isFinite(row.t)) return;
      const bucket = Math.floor(row.t / ROLLUP_MS);
      if (group.buckets.has(bucket)) dropped += 1; else kept += 1;
      group.buckets.set(bucket, row);
    });
  });

  const lines = [];
  groups.forEach((group) => {
    const rows = Array.from(group.buckets.values()).sort((a, b) => a.t - b.t);
    if (!rows.length) return;
    const record = {
      t: rows[rows.length - 1].t,
      kind: group.kind,
      chain: group.chain,
      n: rows.length,
      from: rows[0].t,
      to: rows[rows.length - 1].t,
      rollupMs: ROLLUP_MS,
    };
    if (group.pool) record.pool = group.pool;
    if (group.token) record.token = group.token;
    if (group.symbol) record.symbol = group.symbol;
    if (group.kind === "observation" || group.kind === "holders") record.series = rows;
    else record.samples = rows;
    lines.push(JSON.stringify(record));
  });
  passthrough.forEach((record) => lines.push(JSON.stringify(record)));

  const body = lines.length ? lines.join("\n") + "\n" : "";
  try {
    // If the append stream is open on the very day being compacted, close it
    // first. Unlinking a file that still has an open handle succeeds on
    // Windows (Node opens with share-delete), and every later write then goes
    // to a deleted inode - lost with no error anywhere. The next append
    // reopens against the new file.
    if (streamDay === day) close();

    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, out);
    fs.unlinkSync(src);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
    readyError = error.message;
    return { ok: false, error: error.message };
  }

  seriesCache.clear();
  return {
    ok: true, day,
    beforeBytes, afterBytes: Buffer.byteLength(body),
    kept, dropped,
    savedPct: beforeBytes ? Math.round((1 - Buffer.byteLength(body) / beforeBytes) * 100) : 0,
  };
}

/**
 * Compacts every raw day older than the retention window. Safe to call on a
 * timer and on boot; days already compacted are skipped.
 */
function compact(now) {
  if (!ensure()) return { ok: false, error: readyError, compacted: [] };
  const cutoffDay = new Date((now || Date.now()) - RETAIN_RAW_DAYS * 86400000)
    .toISOString().slice(0, 10);
  const done = [];
  dayFiles().forEach((entry) => {
    if (entry.compacted) return;
    if (entry.day >= cutoffDay) return;
    const result = compactDay(entry.day);
    done.push(result);
    if (result.ok) {
      console.log("archive: compacted " + entry.day + " to " + (ROLLUP_MS / 1000) +
        "s resolution, " + result.savedPct + "% smaller (" + result.dropped + " samples rolled up)");
    } else {
      console.error("archive: compaction of " + entry.day + " failed - " + result.error);
    }
  });
  return { ok: true, rawDays: RETAIN_RAW_DAYS, rollupMs: ROLLUP_MS, cutoffDay, compacted: done };
}

/* ------------------------------------------------- deep series reads ---- */

/**
 * The day files that could hold records written at or after `since`.
 *
 * Day files are keyed by WRITE date, and a record's event time is always at or
 * before the moment it was written, so a record from `since` can only be in a
 * file dated on or after `since`'s day. One day of slack is kept anyway,
 * because a batched row carries samples older than its own write time.
 */
function daysCovering(since) {
  const all = days().slice().sort();
  if (!since) return all;
  const from = new Date(since - 86400000).toISOString().slice(0, 10);
  return all.filter((d) => d >= from);
}

// Reconstructing series means parsing megabytes of JSON. The result is cached
// per (kind, chain, rounded since) and invalidated when the newest day file
// changes size, so a dashboard polling every 5s does not re-scan every time.
const seriesCache = new Map();
const SERIES_CACHE_MS = 30000;

function cacheFingerprint() {
  const today = days()[0];
  if (!today) return "empty";
  try {
    return today + ":" + fs.statSync(path.join(LOG_DIR, today + ".jsonl")).size;
  } catch (e) {
    return today + ":?";
  }
}

/**
 * Rebuilds per-key series from the log - the deep window the in-RAM Map is
 * deliberately too small to hold.
 *
 * Returns a Map of "chain:address" -> samples[], oldest first, de-duplicated
 * by timestamp. Overlapping batches are normal (a flush re-reads a series that
 * already had some samples archived), so the fold has to be idempotent.
 */
function seriesSince({ kind = "pool", chain = null, since = 0, until = 0 } = {}) {
  if (!ensure()) return { series: new Map(), scannedFiles: 0, tookMs: 0, cached: false };

  // The cache is keyed by `since` rounded DOWN, so one entry can serve any
  // request inside that bucket. That means the cached value is a SUPERSET of
  // what most callers asked for, and the exact bound has to be applied on the
  // way out - returning the bucket's rows verbatim would hand back samples
  // older than the caller requested.
  const bucket = Math.floor(since / SERIES_CACHE_MS) * SERIES_CACHE_MS;
  const cacheKey = kind + "|" + (chain || "*") + "|" + bucket + "|" + (until || 0);
  const fingerprint = cacheFingerprint();
  const hit = seriesCache.get(cacheKey);
  if (hit && hit.fingerprint === fingerprint && Date.now() - hit.at < SERIES_CACHE_MS) {
    return Object.assign({}, narrow(hit.value, since, until), { cached: true });
  }

  const startedAt = Date.now();
  // Scan from the bucket floor, not `since`, so the cached entry is the
  // superset every request in this bucket can be narrowed from.
  const scanFrom = bucket;
  const wanted = daysCovering(scanFrom);
  const series = new Map();
  const seen = new Map();

  wanted.forEach((day) => {
    let raw;
    try {
      raw = fs.readFileSync(path.join(LOG_DIR, day + ".jsonl"), "utf8");
    } catch (e) { return; }
    raw.split("\n").forEach((line) => {
      if (!line || !mayMatch(line, kind, chain)) return;
      let record;
      try { record = JSON.parse(line); } catch (e) { return; }
      if (record.kind !== kind) return;
      if (chain && record.chain !== chain) return;

      const address = record.pool || record.token;
      if (!address) return;
      const key = record.chain + ":" + address;

      // Batched kinds (pool, observation, holders) carry an array. Single-event
      // kinds - an app:journal score mark, for instance - ARE the row, so the
      // record itself becomes the one sample. Without this they were skipped
      // entirely and reported as zero coverage despite filling the log.
      const rows = Array.isArray(record.samples) ? record.samples
        : Array.isArray(record.series) ? record.series
          : [record];

      if (!series.has(key)) { series.set(key, []); seen.set(key, new Set()); }
      const into = series.get(key);
      const stamps = seen.get(key);
      rows.forEach((row) => {
        if (!row || !Number.isFinite(row.t)) return;
        if (scanFrom && row.t < scanFrom) return;
        if (until && row.t > until) return;
        // Batches overlap by design; the timestamp is the identity.
        if (stamps.has(row.t)) return;
        stamps.add(row.t);
        into.push(row);
      });
    });
  });

  series.forEach((rows, key) => {
    rows.sort((a, b) => a.t - b.t);
    if (!rows.length) series.delete(key);
  });

  const value = { series, scannedFiles: wanted.length, tookMs: Date.now() - startedAt };
  seriesCache.set(cacheKey, { at: Date.now(), fingerprint, value });
  const narrowed = narrow(value, since, until);
  // The cache is keyed by a rounded `since`, so it cannot grow without bound
  // in normal use; this is a guard against a caller passing arbitrary values.
  if (seriesCache.size > 64) {
    const oldest = Array.from(seriesCache.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) seriesCache.delete(oldest[0]);
  }
  return Object.assign({}, narrowed, { cached: false });
}

/**
 * Trims a cached (superset) result to a caller's exact bounds.
 *
 * The rows are copied rather than spliced, because the cached arrays are
 * shared with every other caller in the same bucket - trimming in place would
 * corrupt the cache for everyone after the first narrow request.
 */
function narrow(value, since, until) {
  if (!since && !until) return value;
  const out = new Map();
  value.series.forEach((rows, key) => {
    const kept = rows.filter((r) => (!since || r.t >= since) && (!until || r.t <= until));
    if (kept.length) out.set(key, kept);
  });
  return { series: out, scannedFiles: value.scannedFiles, tookMs: value.tookMs };
}

/**
 * How much of a window we actually observed.
 *
 * A number computed over "the last 24 hours" means something very different
 * when the server ran for 24 of those hours than when it ran for four. The
 * archive is the only thing that can answer this, because it is the only
 * record that keeps a timestamp for every sample instead of a rolling window.
 *
 * The window is cut into buckets and a bucket counts as observed if ANY sample
 * landed in it. Gaps are returned explicitly rather than only as a percentage,
 * because one four-hour hole and eight scattered half-hour holes are the same
 * percentage and very different problems.
 */
function coverage({ kind = "observation", chain = null, since, until, bucketMs = 300000 } = {}) {
  const end = until || Date.now();
  const start = since || (end - 86400000);
  if (!(end > start)) return { ok: false, error: "empty window" };

  const found = seriesSince({ kind, chain, since: start, until: end });
  const total = Math.max(1, Math.ceil((end - start) / bucketMs));
  const filled = new Set();
  let samples = 0;
  let firstAt = null;
  let lastAt = null;

  found.series.forEach((rows) => {
    rows.forEach((row) => {
      if (!Number.isFinite(row.t) || row.t < start || row.t > end) return;
      filled.add(Math.floor((row.t - start) / bucketMs));
      samples += 1;
      if (firstAt === null || row.t < firstAt) firstAt = row.t;
      if (lastAt === null || row.t > lastAt) lastAt = row.t;
    });
  });

  // Walk the buckets once and collapse runs of empty ones into gaps.
  const gaps = [];
  let runStart = null;
  for (let i = 0; i < total; i += 1) {
    if (filled.has(i)) {
      if (runStart !== null) {
        gaps.push({ from: start + runStart * bucketMs, to: start + i * bucketMs,
          ms: (i - runStart) * bucketMs });
        runStart = null;
      }
    } else if (runStart === null) {
      runStart = i;
    }
  }
  if (runStart !== null) {
    gaps.push({ from: start + runStart * bucketMs, to: end, ms: end - (start + runStart * bucketMs) });
  }

  const observedMs = filled.size * bucketMs;
  const longest = gaps.reduce((max, g) => (g.ms > max ? g.ms : max), 0);

  return {
    ok: true,
    kind, chain: chain || null,
    since: start, until: end,
    windowMs: end - start,
    bucketMs,
    buckets: total,
    observedBuckets: filled.size,
    // The headline: what fraction of the window we have any data for.
    coverage: filled.size / total,
    observedMs,
    missingMs: Math.max(0, (end - start) - observedMs),
    samples,
    series: found.series.size,
    firstAt, lastAt,
    gapCount: gaps.length,
    longestGapMs: longest,
    // Biggest first - those are the ones worth naming in a UI.
    gaps: gaps.sort((a, b) => b.ms - a.ms).slice(0, 12),
    scannedFiles: found.scannedFiles,
  };
}

/**
 * A bucket-by-bucket picture of the record, for drawing.
 *
 * coverage() answers "how much"; this answers "when, and how badly". Each
 * bucket lands in one of four states, and the distinction between the last two
 * is the one that matters:
 *
 *   healthy  - samples at or near the usual rate
 *   partial  - some samples, but noticeably fewer than usual, OR a short hole.
 *              This is what a rate-limited or briefly failing provider looks
 *              like: we were up and recording, just thinly.
 *   lost     - an empty bucket inside a SUSTAINED hole. We should have been
 *              recording and were not.
 *   none     - before the archive's first record. Nothing was lost because
 *              there was nothing yet to lose, so this must not be coloured as
 *              damage - it is simply outside our history.
 *
 * "The usual rate" is measured, not assumed: the reference is the median of
 * the non-empty buckets, so the classification calibrates itself to however
 * many pools or tokens happen to be in the feed.
 */
function timeline({ kind = "observation", chain = null, since, until, buckets = 96, lostGapMs = 1800000 } = {}) {
  const end = until || Date.now();
  const start = since || (end - 86400000);
  if (!(end > start)) return { ok: false, error: "empty window" };

  const count = Math.min(Math.max(Number(buckets) || 96, 4), 2000);
  const bucketMs = (end - start) / count;
  const found = seriesSince({ kind, chain, since: start, until: end });

  const counts = new Array(count).fill(0);
  let firstEver = null;
  found.series.forEach((rows) => {
    rows.forEach((row) => {
      if (!Number.isFinite(row.t)) return;
      if (firstEver === null || row.t < firstEver) firstEver = row.t;
      if (row.t < start || row.t >= end) return;
      const i = Math.min(count - 1, Math.floor((row.t - start) / bucketMs));
      counts[i] += 1;
    });
  });

  // The archive's true beginning, which may be earlier than this window.
  const oldestRecord = oldestRecordAt(kind, chain);
  const horizon = oldestRecord === null ? firstEver : oldestRecord;

  const nonEmpty = counts.filter((c) => c > 0).sort((a, b) => a - b);
  const reference = nonEmpty.length ? nonEmpty[Math.floor(nonEmpty.length / 2)] : 0;
  const partialBelow = reference * 0.5;

  // How long a run of empties has to be before it counts as loss rather than
  // a blip, expressed in buckets.
  const lostRun = Math.max(1, Math.ceil(lostGapMs / bucketMs));

  // Mark runs of empty buckets first, so each empty knows how long its own
  // hole is - a bucket cannot classify itself without its neighbours.
  const emptyRunLength = new Array(count).fill(0);
  let run = 0;
  for (let i = 0; i < count; i += 1) {
    if (counts[i] === 0) { run += 1; } else if (run) {
      for (let j = i - run; j < i; j += 1) emptyRunLength[j] = run;
      run = 0;
    }
  }
  if (run) for (let j = count - run; j < count; j += 1) emptyRunLength[j] = run;

  const cells = counts.map((n, i) => {
    const at = start + i * bucketMs;
    // Before we ever recorded anything: outside our history, not a loss.
    if (horizon !== null && at + bucketMs <= horizon) {
      return { t: at, samples: 0, state: "none" };
    }
    if (n === 0) {
      return { t: at, samples: 0, state: emptyRunLength[i] >= lostRun ? "lost" : "partial" };
    }
    if (reference && n < partialBelow) return { t: at, samples: n, state: "partial" };
    return { t: at, samples: n, state: "healthy" };
  });

  const tally = { healthy: 0, partial: 0, lost: 0, none: 0 };
  cells.forEach((c) => { tally[c.state] += 1; });

  return {
    ok: true,
    kind, chain: chain || null,
    since: start, until: end,
    bucketMs, buckets: count,
    referenceSamples: reference,
    lostGapMs,
    oldestRecordAt: horizon,
    tally,
    // Recorded fraction counts healthy + partial, and excludes `none` from the
    // denominator: judging us for time before the archive existed would make
    // the number say more about the archive's age than about its health.
    recorded: (count - tally.none) > 0
      ? (tally.healthy + tally.partial) / (count - tally.none) : null,
    cells,
    scannedFiles: found.scannedFiles,
  };
}

/**
 * When this particular series first appears in the archive.
 *
 * Per KIND and CHAIN, deliberately. A global "oldest record" is the wrong
 * anchor: one backfilled row carrying an ancient event time would drag the
 * horizon back years and make every empty bucket read as DATA LOST, because
 * the archive would appear to have existed the whole time. Asking when THIS
 * series starts keeps the grey state meaning what it says.
 */
const oldestCache = new Map();
function oldestRecordAt(kind, chain) {
  const key = (kind || "*") + "|" + (chain || "*");
  const hit = oldestCache.get(key);
  if (hit && Date.now() - hit.at < 300000) return hit.value;

  const all = days().slice().sort();
  let oldest = null;
  for (const day of all) {
    let raw;
    try { raw = fs.readFileSync(path.join(LOG_DIR, day + ".jsonl"), "utf8"); } catch (e) { continue; }
    for (const line of raw.split("\n")) {
      if (!line || !mayMatch(line, kind, chain)) continue;
      try {
        const record = JSON.parse(line);
        if (kind && record.kind !== kind) continue;
        if (chain && record.chain !== chain) continue;
        const rows = Array.isArray(record.samples) ? record.samples
          : Array.isArray(record.series) ? record.series : [record];
        rows.forEach((row) => {
          if (Number.isFinite(row && row.t) && (oldest === null || row.t < oldest)) oldest = row.t;
        });
      } catch (e) { /* torn line */ }
    }
    if (oldest !== null) break;
  }
  oldestCache.set(key, { at: Date.now(), value: oldest });
  return oldest;
}

/** Size on disk, so the admin panel can show what the archive costs. */
function usage() {
  if (!ensure()) return { ok: false, error: readyError, bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const perDay = [];
  dayFiles().forEach((entry) => {
    try {
      const stat = fs.statSync(entry.file);
      bytes += stat.size;
      files += 1;
      perDay.push({
        day: entry.day, bytes: stat.size, modifiedAt: stat.mtimeMs,
        compacted: entry.compacted,
        resolution: entry.compacted ? ROLLUP_MS : null,
      });
    } catch (e) { /* vanished between readdir and stat */ }
  });
  let snapshotBytes = 0;
  try { snapshotBytes = fs.statSync(SNAPSHOT).size; } catch (e) { /* none yet */ }
  return { ok: true, dir: DIR, bytes, files, snapshotBytes, days: perDay,
    rawDays: RETAIN_RAW_DAYS, rollupMs: ROLLUP_MS };
}

/**
 * Reads EVERY day file and reports what is actually in the archive: records
 * and bytes per kind, the time span covered, and how many lines failed to
 * parse. This is the honest answer to "what is stored", as opposed to
 * writtenByKind() which only knows about this process.
 *
 * It is a full scan, so it is on demand only - never on the admin poll. A
 * 40MB log takes a moment; the caller is expected to have asked for it.
 */
function scan() {
  if (!ensure()) return { ok: false, error: readyError };
  const startedAt = Date.now();
  const kinds = {};
  let records = 0;
  let bytes = 0;
  let torn = 0;
  let oldest = null;
  let newest = null;

  days().forEach((day) => {
    let raw;
    try {
      raw = fs.readFileSync(path.join(LOG_DIR, day + ".jsonl"), "utf8");
    } catch (e) { return; }
    raw.split("\n").forEach((line) => {
      if (!line) return;
      bytes += Buffer.byteLength(line) + 1;
      let record;
      try { record = JSON.parse(line); } catch (e) { torn += 1; return; }
      records += 1;
      const kind = record.kind || "unknown";
      const seen = kinds[kind] || { records: 0, bytes: 0, firstAt: null, lastAt: null };
      seen.records += 1;
      seen.bytes += Buffer.byteLength(line) + 1;
      // `t` is event time; `from`/`to` bound a batched row.
      const first = record.from || record.t;
      const last = record.to || record.t;
      if (first && (seen.firstAt === null || first < seen.firstAt)) seen.firstAt = first;
      if (last && (seen.lastAt === null || last > seen.lastAt)) seen.lastAt = last;
      if (first && (oldest === null || first < oldest)) oldest = first;
      if (last && (newest === null || last > newest)) newest = last;
      kinds[kind] = seen;
    });
  });

  return {
    ok: true,
    scannedInMs: Date.now() - startedAt,
    records, bytes, torn,
    oldestAt: oldest, newestAt: newest,
    spanMs: oldest && newest ? newest - oldest : 0,
    kinds,
    days: days().length,
  };
}

module.exports = {
  dir: DIR,
  logDir: LOG_DIR,
  snapshotPath: SNAPSHOT,
  get error() { return readyError; },
  ensure, append, sync, close,
  writeSnapshot, readSnapshot,
  days, dayFiles, read, readTail, usage, scan, writtenByKind, seriesSince, coverage, timeline,
  compact, compactDay, RETAIN_RAW_DAYS, ROLLUP_MS,
};
