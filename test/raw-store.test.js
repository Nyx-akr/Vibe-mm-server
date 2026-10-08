/**
 * The raw store is the only thing the app reads, so each assertion here is a
 * way the app could be handed something wrong: a half-written file, a file
 * outside the store, or a stale body where a new one was written.
 *
 * Writes to a throwaway directory; the real data/raw is never touched.
 */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert");

const DIR = path.join(__dirname, ".tmp-raw");
process.env.RAW_DIR = DIR;
fs.rmSync(DIR, { recursive: true, force: true });

const raw = require("../lib/raw-store");

let pass = 0;
const ok = (name) => { pass += 1; console.log("  ok  " + name); };

function get(port, rel, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/raw/" + rel, headers: headers || {} }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, etag: res.headers.etag, body }));
    }).on("error", reject);
  });
}

(async () => {
  try {
    const bytes = raw.write("solana/market.json", { chain: "solana", rows: [{ symbol: "A" }] });
    assert.ok(bytes > 0);
    const back = raw.read("solana/market.json");
    assert.strictEqual(back.rows[0].symbol, "A");
    assert.ok(Number.isFinite(back.writtenAt), "every file is stamped with writtenAt");
    ok("write then read round-trips, stamped with writtenAt");

    assert.strictEqual(fs.readdirSync(path.join(DIR, "solana")).some((f) => f.endsWith(".tmp")), false);
    ok("no temp file left behind (atomic rename)");

    assert.strictEqual(raw.write("../escape.json", { x: 1 }), 0);
    assert.strictEqual(raw.write("solana/../../escape.json", { x: 1 }), 0);
    assert.strictEqual(raw.write("solana/not-json.txt", { x: 1 }), 0);
    assert.strictEqual(fs.existsSync(path.join(DIR, "..", "escape.json")), false);
    ok("paths outside the store, or not .json, are refused");

    const server = http.createServer((req, res) => {
      raw.serve(decodeURIComponent(req.url.slice("/raw/".length)), req, res);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const first = await get(port, "solana/market.json");
    assert.strictEqual(first.status, 200);
    assert.strictEqual(JSON.parse(first.body).rows[0].symbol, "A");
    assert.ok(first.etag, "an ETag is sent");
    ok("serve() returns the file as written");

    const again = await get(port, "solana/market.json", { "If-None-Match": first.etag });
    assert.strictEqual(again.status, 304);
    ok("an unchanged file answers 304");

    // mtime resolution can be coarse; make sure the size differs as well.
    await new Promise((r) => setTimeout(r, 20));
    raw.write("solana/market.json", { chain: "solana", rows: [{ symbol: "A" }, { symbol: "B" }] });
    const changed = await get(port, "solana/market.json", { "If-None-Match": first.etag });
    assert.strictEqual(changed.status, 200);
    assert.strictEqual(JSON.parse(changed.body).rows.length, 2);
    ok("a rewritten file is served fresh, never the stale body");

    const missing = await get(port, "solana/never.json");
    assert.strictEqual(missing.status, 404);
    const escape = await get(port, "..%2Fpackage.json");
    assert.strictEqual(escape.status, 404);
    ok("missing files and traversal attempts are 404");

    server.close();
    await new Promise((r) => setTimeout(r, 1100));
    const manifest = raw.read("manifest.json");
    assert.ok(manifest && manifest.files["solana/market.json"], "manifest lists the file");
    ok("manifest records what was written and when");

    console.log("\n" + pass + " passed");
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  }
})();
