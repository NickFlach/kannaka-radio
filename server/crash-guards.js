'use strict';

/**
 * crash-guards.js — keep the station on air when a stray error escapes.
 *
 * WHY: server/index.js mounts an ASYNC handler on http.createServer, and Node
 * does not catch a rejected handler promise. Since Node 15 an unhandled
 * rejection is FATAL by default, so one missing `.catch()` anywhere — in a
 * route, a poller, a webhook — takes down a 24/7 public radio station: the
 * stream drops, the Icecast source disconnects, and systemd restarts into a
 * cold playlist. The same is true of an uncaught exception, which this codebase
 * already knows about from another angle (a callback-less sqlite `db.run` that
 * errors emits an unhandled 'error' event and kills the shared process).
 *
 * WHAT: log the failure loudly and completely — then keep serving. That trade
 * is right *here* specifically because the subsystems that touch money are
 * built to survive an interrupted step: every Stripe/ledger write is a guarded
 * single-statement CAS with an idempotency key, and the airing ledger, the
 * approval outbox and the analytics jobs all reconcile on boot. Continuing is
 * therefore recoverable, while crashing is a guaranteed on-air outage.
 *
 * SAFETY VALVE: if errors arrive in a storm (a wedged process throwing on every
 * request), swallowing them forever would serve garbage indefinitely. After
 * `maxInWindow` failures inside `windowMs` we stop pretending and exit, letting
 * systemd restart cleanly.
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_IN_WINDOW = 10;

/**
 * Install the process-level guards. Idempotent per process.
 * @param {object}   [opts]
 * @param {function} [opts.logger]      console-like error sink (for tests)
 * @param {function} [opts.exit]        process.exit replacement (for tests)
 * @param {number}   [opts.windowMs]    storm window
 * @param {number}   [opts.maxInWindow] failures allowed in the window
 * @returns {object} handle with { count(), _onRejection, _onException }
 */
function installCrashGuards(opts = {}) {
  const log = opts.logger || ((...a) => console.error(...a));
  const exit = opts.exit || ((code) => process.exit(code));
  const windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
  const maxInWindow = opts.maxInWindow || DEFAULT_MAX_IN_WINDOW;
  const proc = opts.process || process;

  let recent = []; // timestamps of recent failures

  const record = (kind, err) => {
    const now = Date.now();
    recent = recent.filter((t) => now - t < windowMs);
    recent.push(now);
    // Log the whole thing — a guard that hides the failure is worse than the
    // crash it prevented, because nobody ever learns the bug exists.
    let detail;
    try { detail = (err && err.stack) || String(err); } catch (_) { detail = '<unprintable error>'; }
    log(`[crash-guard] ${kind} — station kept running (${recent.length} in the last ${Math.round(windowMs / 1000)}s):\n${detail}`);
    if (recent.length >= maxInWindow) {
      log(`[crash-guard] ${recent.length} failures inside ${Math.round(windowMs / 1000)}s — the process looks wedged; exiting for a clean restart.`);
      exit(1);
    }
  };

  const onRejection = (reason) => record('unhandled promise rejection', reason);
  const onException = (err) => record('uncaught exception', err);

  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);

  return {
    count: () => recent.length,
    _onRejection: onRejection,
    _onException: onException,
  };
}

module.exports = { installCrashGuards, DEFAULT_WINDOW_MS, DEFAULT_MAX_IN_WINDOW };
