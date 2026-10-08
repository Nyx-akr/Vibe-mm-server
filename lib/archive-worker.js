"use strict";

/**
 * The worker side of lib/archive-offload.js. Loads its own copy of the archive
 * module and answers read calls, one at a time, in the order they arrive.
 *
 * It only ever READS the day files. The write stream, the snapshot and
 * compaction all stay on the main thread, so the two never fight over a file.
 */

const { parentPort } = require("node:worker_threads");
const archive = require("./archive");

parentPort.on("message", ({ id, fn, args }) => {
  let reply;
  try {
    reply = { id, ok: true, value: archive[fn](...(args || [])) };
  } catch (error) {
    reply = { id, ok: false, error: (error && error.message) || String(error) };
  }
  parentPort.postMessage(reply);
});
