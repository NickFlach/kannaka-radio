'use strict';

/**
 * gs-analytics-runner.js — the parent-side analysis job runner (review B1).
 *
 * Spawn-per-job worker_threads with hard resource limits, a wall-clock
 * terminate watchdog, concurrency 1, and a bounded queue. EVERY worker event
 * ('message'/'error'/'exit') is handled — an unhandled worker 'error' would
 * crash the shared radio process. analyze() never rejects; every outcome is a
 * resolved { ok, ... } object.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_WALL_MS = 30_000;
const DEFAULT_QUEUE_MAX = 4;

class GsaRunner {
  constructor(opts = {}) {
    this._queue = [];
    this._running = false;
    this._wallMs = opts.wallMs || DEFAULT_WALL_MS;
    this._queueMax = opts.queueMax || DEFAULT_QUEUE_MAX;
    this._workerPath = opts.workerPath || path.join(__dirname, 'gs-analytics-worker.js');
  }

  depth() { return this._queue.length + (this._running ? 1 : 0); }

  /** Enqueue one analysis. Resolves {ok:true, report} | {ok:false, error, bad?, busy?}. */
  analyze(kind, text) {
    if (this.depth() >= this._queueMax) return Promise.resolve({ ok: false, error: 'busy', busy: true });
    return new Promise((resolve) => {
      this._queue.push({ kind, text, resolve });
      this._drain();
    });
  }

  _drain() {
    if (this._running) return;
    const job = this._queue.shift();
    if (!job) return;
    this._running = true;
    let settled = false;
    const done = (out) => {
      if (settled) return;
      settled = true;
      this._running = false;
      try { job.resolve(out); } finally { setImmediate(() => this._drain()); }
    };
    let w;
    try {
      w = new Worker(this._workerPath, {
        workerData: { kind: job.kind, text: job.text },
        // An OOM kills the WORKER (job fails), never the station (review B5).
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
      });
    } catch (e) {
      return done({ ok: false, error: 'worker spawn failed' });
    }
    const timer = setTimeout(() => {
      w.terminate().catch(() => {});
      done({ ok: false, error: 'analysis timed out' });
    }, this._wallMs);
    if (timer.unref) timer.unref();
    w.once('message', (m) => {
      clearTimeout(timer);
      w.terminate().catch(() => {}); // spawn-per-job: nothing survives the job
      done(m && typeof m === 'object' ? m : { ok: false, error: 'malformed worker result' });
    });
    w.once('error', () => { clearTimeout(timer); done({ ok: false, error: 'analysis crashed' }); });
    w.once('exit', (code) => {
      clearTimeout(timer);
      if (!settled) done({ ok: false, error: code === 0 ? 'analysis ended without a result' : 'analysis crashed (resource limit)' });
    });
  }
}

module.exports = { GsaRunner };
