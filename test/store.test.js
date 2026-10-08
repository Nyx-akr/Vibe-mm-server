/**
 * Round-trip test for the on-disk archive.
 *
 *   npm test
 *
 * Every assertion here corresponds to a way the archive can silently lose or
 * corrupt data - duplicate appends, observations missing from the snapshot, an
 * unflushed fsync, a torn line swallowing its neighbour. Four of them were
 * real bugs caught on the first run. If one starts failing, something about
 * durability broke, not the test.
 *
 * It writes to a throwaway directory, so the real data/ is never touched.
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

const DIR = process.env.ARCHIVE_DIR || path.join(__dirname, ".tmp-archive");
process.env.ARCHIVE_DIR = DIR;
fs.rmSync(DIR, { recursive: true, force: true });

const target = process.argv[2] || path.join(__dirname, "..", "store.js");
const store = require(target);
const archive = require(path.join(path.dirname(target), "lib", "archive.js"));

let pass = 0;
const ok = (name) => { pass += 1; console.log("  ok  " + name); };

assert.strictEqual(store.enabled, true, "archive should be enabled");
ok("enabled on a writable dir");

// ---- fake in-memory stores, shaped like lib/memory.js -------------------
const stores = {
  historyStore: new Map(),
  holderHistory: new Map(),
  observationStore: new Map(),
};

const sample = (t, price) => ({ t, priceUsd: price, sources: { geckoterminal: price, dexscreener: price * 1.001 } });

stores.historyStore.set("base:0xpool1", {
  samples: [sample(1000, 1), sample(2000, 2)],
  symbol: "STONK", tokenAddress: "0xtok1",
});
store.touchPool("base", "0xpool1");

(async () => {
  // ---- first flush: both samples land -----------------------------------
  const n1 = await store.flush(stores, "test-1");
  assert.strictEqual(n1, 1, "one pool record");
  ok("first flush writes 1 record");

  const day = new Date().toISOString().slice(0, 10);
  const logPath = path.join(DIR, "log", day + ".jsonl");
  await new Promise((r) => setTimeout(r, 50));
  let lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].n, 2, "both samples archived");
  assert.strictEqual(lines[0].symbol, "STONK");
  assert.deepStrictEqual(lines[0].samples[0].sources, { geckoterminal: 1, dexscreener: 1.001 });
  ok("nested sources survive the round trip (CSV could not do this)");

  // ---- THE critical one: re-flush unchanged data appends nothing --------
  store.touchPool("base", "0xpool1");
  await store.flush(stores, "test-2");
  await new Promise((r) => setTimeout(r, 50));
  lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.strictEqual(lines.length, 1, "no duplicate record for unchanged series");
  ok("re-flushing unchanged series appends NOTHING (no duplication)");

  // ---- only new samples are appended ------------------------------------
  stores.historyStore.get("base:0xpool1").samples.push(sample(3000, 3));
  store.touchPool("base", "0xpool1");
  await store.flush(stores, "test-3");
  await new Promise((r) => setTimeout(r, 50));
  lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.strictEqual(lines.length, 2, "a second record");
  assert.strictEqual(lines[1].n, 1, "ONLY the new sample, not all three");
  assert.strictEqual(lines[1].samples[0].t, 3000);
  ok("incremental: only the 1 new sample appended, not the whole series");

  // ---- observations on their own cycle -----------------------------------
  stores.observationStore.set("base:0xtok1", [
    { t: 1000, score: 61, stage: "WATCH", symbol: "STONK" },
    { t: 2000, score: 74, stage: "ENTRY", symbol: "STONK" },
  ]);
  store.touchObservation("base", "0xtok1");
  await store.flushObservations(stores, "test-obs");
  await new Promise((r) => setTimeout(r, 50));
  lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  const obs = lines.filter((l) => l.kind === "observation");
  assert.strictEqual(obs.length, 1);
  assert.strictEqual(obs[0].n, 2);
  ok("observations archived under their own kind");

  // ---- wallet trades: each trade lands once --------------------------------
  // GeckoTerminal returns the last ~300 trades, so consecutive samples overlap.
  const tr = (at, wallet, usd) => ({ at, wallet, kind: "buy", usd });
  const s1 = [tr(100, "0xa", 5), tr(200, "0xb", 7), tr(200, "0xc", 9)];
  assert.strictEqual(store.archiveTrades("base", "0xpoolT", "TRD", s1), 3);
  // Overlapping resample: two already archived, one new trade AT the mark, one after.
  const s2 = [tr(200, "0xb", 7), tr(200, "0xc", 9), tr(200, "0xd", 1), tr(300, "0xe", 2)];
  assert.strictEqual(store.archiveTrades("base", "0xpoolT", "TRD", s2), 2);
  assert.strictEqual(store.archiveTrades("base", "0xpoolT", "TRD", s2), 0, "an identical resample appends nothing");
  store.seedTradeMark("base", "0xpoolT", s2);
  await archive.sync();
  const tradeRows = archive.read({ filter: (r) => r.kind === "trades" && r.pool === "0xpoolT" });
  assert.strictEqual(tradeRows.reduce((n, r) => n + r.trades.length, 0), 5, "five distinct trades on disk");
  ok("overlapping trade samples archive each trade exactly once");

  // ---- single-event rows ---------------------------------------------------
  // The app no longer writes here, but logs written before the raw-store split
  // still hold its app:journal rows. Compaction below must carry them across.
  archive.append({ kind: "app:journal", chain: "base", token: "0xtok1", t: 5000, score: 81, stage: "RUN", flags: ["organic", "rotating"] });
  archive.append({ kind: "app:journal", chain: "base", token: "0xtok2", t: 5000, score: 40, stage: "WATCH", flags: [] });
  await archive.sync();

  // ---- snapshot is valid JSON and complete -------------------------------
  const snap = JSON.parse(fs.readFileSync(path.join(DIR, "snapshot.json"), "utf8"));
  assert.strictEqual(snap.pools["base:0xpool1"].samples.length, 3);
  assert.strictEqual(snap.pools["base:0xpool1"].symbol, "STONK");
  ok("snapshot holds the full current series");
  assert.strictEqual(fs.existsSync(path.join(DIR, "snapshot.json.tmp")), false);
  ok("no .tmp left behind (atomic rename completed)");

  // ---- reload into fresh maps -------------------------------------------
  const fresh = { historyStore: new Map(), holderHistory: new Map(), observationStore: new Map() };
  const counts = await store.load(fresh);
  assert.strictEqual(counts.pools, 1);
  assert.strictEqual(fresh.historyStore.get("base:0xpool1").samples.length, 3);
  assert.strictEqual(fresh.historyStore.get("base:0xpool1").symbol, "STONK");
  assert.strictEqual(fresh.observationStore.get("base:0xtok1").length, 2);
  ok("boot reload restores pools + observations from snapshot");

  // ---- reload must NOT re-append what is already logged -------------------
  const before = fs.readFileSync(logPath, "utf8").trim().split("\n").length;
  store.touchPool("base", "0xpool1");
  await store.flush(fresh, "test-after-reload");
  await new Promise((r) => setTimeout(r, 50));
  const after = fs.readFileSync(logPath, "utf8").trim().split("\n").length;
  assert.strictEqual(after, before, "restart must not duplicate archived history");
  ok("high-water mark survives reload: a restart re-appends nothing");

  // ---- crash mid-write, then restart --------------------------------------
  // Simulate a process dying part-way through a line: close the stream, leave
  // a fragment with no newline, then write again as a fresh process would.
  store.close();
  fs.appendFileSync(logPath, '{"kind":"pool","chain":"base","trunc');
  const readBack = archive.read({ filter: (r) => r.kind === "pool" });
  assert.strictEqual(readBack.length, 2, "good lines still readable past a torn one");
  ok("a torn final line is skipped, not fatal");

  archive.append({ kind: "pool", chain: "base", pool: "0xafter", n: 0, samples: [] });
  await archive.sync();
  const after2 = archive.read({ filter: (r) => r.kind === "pool" });
  assert.strictEqual(after2.length, 3, "the record written after a tear is readable");
  assert.ok(after2.some((r) => r.pool === "0xafter"), "and it is the right one");
  ok("a record written AFTER a torn line is not swallowed by it");

  // ---- probe + usage ------------------------------------------------------
  const p = await store.probe();
  assert.strictEqual(p.verified, true, "probe wrote and read back its own record");
  ok("probe round-trips in " + p.roundTripMs + "ms (write " + p.writeMs + " / read " + p.readMs + ")");

  const u = store.usage();
  assert.strictEqual(u.ok, true);
  ok("usage reports " + u.bytes + "B across " + u.files + " day-file(s)");

  const insp = await store.inspect("poolHistory", 10);
  assert.strictEqual(insp.enabled, true);
  const doc = insp.documents.find((d) => d.id === "base__0xpool1");
  assert.ok(doc, "the pool appears in the listing");
  assert.strictEqual(doc.symbol, "STONK");
  assert.strictEqual(doc.chain, "base");
  assert.strictEqual(doc.lastSampleAt, 3000);
  ok("inspect() returns the admin panel's document shape");

  // ---- deep reads: the window RAM is too small to hold --------------------
  // seriesSince rebuilds per-pool series straight from the log, which is what
  // lets /api/history?since= answer for 48h while RAM holds only its hot few.
  const deep = archive.seriesSince({ kind: "pool", chain: "base", since: 0 });
  // 0xafter was written with an empty samples array by the crash test above,
  // so it is correctly absent rather than present-but-empty.
  assert.strictEqual(deep.series.size, 1, "the one pool that has samples");
  assert.strictEqual(deep.series.has("base:0xafter"), false, "a sampleless record yields no series");
  const rebuilt = deep.series.get("base:0xpool1");
  assert.strictEqual(rebuilt.length, 3, "all three samples, across two separate batches");
  assert.deepStrictEqual(rebuilt.map((r) => r.t), [1000, 2000, 3000], "in time order");
  ok("seriesSince() rebuilds a series from batches written at different times");

  // Batches overlap whenever a flush re-reads a series, so the fold MUST be
  // idempotent or every overlapping sample would be counted twice.
  archive.append({
    kind: "pool", chain: "base", pool: "0xpool1", n: 2,
    from: 2000, to: 3000, samples: [sample(2000, 2), sample(3000, 3)],
  });
  await archive.sync();
  const again = archive.seriesSince({ kind: "pool", chain: "base", since: 0 });
  assert.strictEqual(again.series.get("base:0xpool1").length, 3, "still three, not five");
  ok("overlapping batches de-duplicate by timestamp, not append twice");

  const windowed = archive.seriesSince({ kind: "pool", chain: "base", since: 2500 });
  assert.strictEqual(windowed.series.get("base:0xpool1").length, 1, "only the sample after `since`");
  ok("seriesSince() honours the `since` bound");

  // ---- compaction: 7 raw days, then a 1-minute rollup ---------------------
  // Realistic spacing matters here: the samples above are milliseconds apart
  // and would all collapse into one minute bucket, which tests nothing. Real
  // samples are 15s apart, so 5 minutes of them should survive as ~5 rows.
  const base = 1800000000000;
  const realistic = [];
  for (let i = 0; i < 20; i += 1) realistic.push(sample(base + i * 15000, 10 + i));
  archive.append({
    kind: "pool", chain: "arbitrum", pool: "0xreal", symbol: "REAL",
    n: realistic.length, from: realistic[0].t, to: realistic[realistic.length - 1].t,
    samples: realistic,
  });
  await archive.sync();

  const today = new Date().toISOString().slice(0, 10);
  const beforeReal = archive.seriesSince({ kind: "pool", chain: "arbitrum", since: 0 }).series.get("arbitrum:0xreal");
  assert.strictEqual(beforeReal.length, 20, "20 raw samples at 15s");
  const beforeSpan = beforeReal[beforeReal.length - 1].t - beforeReal[0].t;
  assert.strictEqual(beforeSpan, 19 * 15000, "spanning 4m45s");
  const compacted = archive.compactDay(today);
  assert.strictEqual(compacted.ok, true, "compaction succeeded");
  assert.strictEqual(fs.existsSync(path.join(DIR, "log", today + ".jsonl")), false, "raw file removed");
  assert.strictEqual(fs.existsSync(path.join(DIR, "log", today + ".1m.jsonl")), true, "rollup file written");
  ok("compactDay() replaces the raw day with a 1-minute rollup");

  const post = archive.seriesSince({ kind: "pool", chain: "arbitrum", since: 0 });
  assert.strictEqual(post.series.has("arbitrum:0xreal"), true, "the pool survived compaction");
  const postRows = post.series.get("arbitrum:0xreal");
  assert.ok(postRows.length < beforeReal.length, "fewer samples after the rollup");
  assert.ok(postRows.length >= 4 && postRows.length <= 6,
    "about one per minute over ~5 minutes, got " + postRows.length);
  assert.strictEqual(postRows[postRows.length - 1].t - postRows[0].t <= beforeSpan, true,
    "the compacted series stays inside the span it came from");
  assert.ok(postRows.every((r) => r.priceUsd !== undefined),
    "retained samples keep real observed values, not averages");
  // Decimation, not averaging: every retained price must be one we actually saw.
  const observed = new Set(realistic.map((r) => r.priceUsd));
  assert.ok(postRows.every((r) => observed.has(r.priceUsd)),
    "every retained value is a real reading, never an invented mean");
  ok("compaction preserves the pool, its span and its real values");

  // Readers must not care whether a day is raw or rolled up.
  const journalAfter = archive.read({ filter: (r) => r.kind === "app:journal" });
  assert.strictEqual(journalAfter.length, 2, "single-event rows carried across untouched");
  ok("app rows survive compaction (nothing to roll up, so nothing lost)");

  assert.strictEqual(archive.compactDay(today).ok, false, "a compacted day cannot be compacted again");
  ok("compacting an already-compacted day is refused, not silently destructive");

  // Compaction unlinks the raw day file. If the append stream still held it
  // open, Windows lets the unlink succeed and every later write lands in a
  // deleted inode - gone, with no error raised anywhere. So a write AFTER
  // compaction must be readable back.
  archive.append({
    kind: "pool", chain: "post", pool: "0xafter-compaction", n: 1,
    from: 1, to: 1, samples: [sample(1, 42)],
  });
  await archive.sync();
  const afterCompaction = archive.read({ filter: (r) => r.chain === "post" });
  assert.strictEqual(afterCompaction.length, 1,
    "a record written after compaction is on disk, not in a deleted file");
  ok("writes after compaction survive (the stream is reopened, not orphaned)");

  // ---- the storage timeline's four states --------------------------------
  // These drive the colours in SYSTEM HEALTH, so the meanings are pinned: a
  // hole before the archive existed must never be painted as data loss, and a
  // short hole must never be painted the same as a sustained outage.
  {
    const t0 = Date.parse("2026-06-01T00:00:00Z");
    const MIN = 60000;
    // Dense samples for an hour, a 10-minute nick, then a 2-hour hole.
    const rows = [];
    for (let i = 0; i < 60; i += 1) rows.push(sample(t0 + i * MIN, 10));
    for (let i = 70; i < 90; i += 1) rows.push(sample(t0 + i * MIN, 10));
    archive.append({
      kind: "pool", chain: "test", pool: "0xtl", n: rows.length,
      from: rows[0].t, to: rows[rows.length - 1].t, samples: rows,
    });
    await archive.sync();

    // Window starts an hour BEFORE the first sample, so the head is pre-archive.
    const tl = archive.timeline({
      kind: "pool", chain: "test",
      since: t0 - 60 * MIN, until: t0 + 210 * MIN,
      buckets: 27, lostGapMs: 30 * MIN,
    });
    assert.strictEqual(tl.ok, true);

    const stateAt = (minsFromT0) => {
      const want = t0 + minsFromT0 * MIN;
      const cell = tl.cells.filter((c) => c.t <= want).pop();
      return cell && cell.state;
    };

    assert.strictEqual(stateAt(-30), "none", "before the first record is NOT RECORDED");
    assert.strictEqual(stateAt(30), "healthy", "dense sampling is RECORDED");
    assert.strictEqual(stateAt(180), "lost", "a two-hour hole is DATA LOST");
    assert.ok(tl.tally.none > 0 && tl.tally.healthy > 0 && tl.tally.lost > 0,
      "all three states present");
    ok("timeline separates NOT RECORDED from DATA LOST (" +
      JSON.stringify(tl.tally) + ")");

    // `recorded` must exclude pre-archive time from its denominator, or the
    // figure would punish the archive for being young rather than for losing
    // anything.
    const denominator = tl.buckets - tl.tally.none;
    assert.ok(Math.abs(tl.recorded - (tl.tally.healthy + tl.tally.partial) / denominator) < 1e-9,
      "recorded excludes NOT RECORDED from the denominator");
    ok("`recorded` is measured against time the archive could have covered");
  }

  store.close();
  console.log("\n" + pass + " passed");
})().catch((e) => { console.error("\nFAILED: " + e.message); process.exit(1); });
