"use strict";

/**
 * Runs the archive's heavy READS on a worker thread.
 *
 * Reading the archive back means parsing day files of ~200MB each, and the
 * week-long coverage timeline reads over a gigabyte of them. On the main
 * thread that froze the whole server for 30-90s at a time: /health went
 * silent, the supervisor killed the process, and anyone on the shared link got
 * a 502 - every six minutes, all night (2026-10-07). On a worker the same work
 * just takes a core for a while; requests keep being answered.
 *
 * Calls queue on the one worker and run one at a time, so two big scans never
 * run side by side and double the memory. If the worker cannot be started the
 * call runs inline instead - it blocks like it used to, but it never fails
 * just because threads are unavailable.
 */

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const archive = require("./archive");

// Read-only entry points. Anything that writes must stay on the main thread.
const READS = new Set(["seriesSince", "coverage", "timeline", "scan", "read"]);

let worker = null;
let nextId = 1;
const waiting = new Map();

function start() {
  if (worker) return worker;
  let w;
  try {
    w = new Worker(path.join(__dirname, "archive-worker.js"));
  } catch (error) {
    return null;
  }
  w.on("message", ({ id, ok, value, error }) => {
    const pending = waiting.get(id);
    if (!pending) return;
    waiting.delete(id);
    if (!waiting.size) w.unref();
    if (ok) pending.resolve(value); else pending.reject(new Error(error));
  });
  const died = (reason) => {
    if (worker !== w) return;
    worker = null;
    // Whatever was queued on it is never coming back; the next call starts a
    // fresh worker.
    const error = reason instanceof Error ? reason : new Error("archive worker exited (" + reason + ")");
    waiting.forEach((pending) => pending.reject(error));
    waiting.clear();
  };
  w.on("error", died);
  w.on("exit", died);
  // An idle worker must not hold the process open on shutdown, but one with a
  // call in flight must - otherwise a script with nothing else to do exits
  // before the answer arrives. So it is ref'd per call and unref'd when the
  // queue drains. (After the listeners: attaching 'message' re-refs it.)
  w.unref();
  worker = w;
  return w;
}

/** archive[fn](...args), answered from the worker. Always a Promise. */
function call(fn, ...args) {
  if (!READS.has(fn)) return Promise.reject(new Error("not an archive read: " + fn));
  const w = start();
  if (!w) {
    try { return Promise.resolve(archive[fn](...args)); } catch (error) { return Promise.reject(error); }
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.ref();
    w.postMessage({ id, fn, args });
  });
}

function stop() {
  const w = worker;
  worker = null;
  if (w) w.terminate().catch(() => {});
}

module.exports = { call, stop };
