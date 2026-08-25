/**
 * gshub-init-failure.test.js — a failed GhostSignalsHub init must degrade the
 * hub, not kill the radio (#155).
 *
 * `GhostSignalsHub.init()` was a plain (non-async) method whose first three
 * statements can all throw SYNCHRONOUSLY: loadSqlite3() when the module is
 * absent, mkdirSync() when the data dir cannot be created, and
 * new sqlite3.Database() on an unopenable path. Those throws escaped BEFORE
 * the Promise was constructed, so the `.catch()` in server/index.js never got
 * a chance to attach — the exception propagated as an uncaught error and the
 * whole radio exited 1 at startup.
 *
 * Reproduced before the fix as:
 *   EXIT=1  ... Error: ENOENT: no such file or directory, mkdir '<bad>/.kannaka'
 *       at GhostSignalsHub.init (server/ghostsignals-hub.js:142)
 *       at Object.<anonymous> (server/index.js:570)
 *
 * This spawns the real server with an unwritable home so init genuinely fails.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0;
let failed = 0;

function test(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

/**
 * A home directory that cannot be created on either platform, so
 * `mkdirSync(<home>/.kannaka)` fails deterministically.
 *   win32: a drive letter that does not exist — FOUND, not assumed.
 *   posix: a path under /dev/null, which is ENOTDIR rather than a missing dir.
 *
 * #233: this used to hardcode `Z:`, which is the first letter Windows hands to
 * a mapped network drive. On a host that has one, `Z:\...` is writable, the
 * subsystem initialises fine, and all six assertions fail — reporting a
 * regression that is really just somebody's file server. The unwritable path
 * is a precondition of the test, so it gets established rather than assumed.
 */
function absentDriveRoot() {
  // Walk down from Z: so the answer is stable on a machine with few drives,
  // and skip anything `fs` can reach at all.
  for (let c = 'Z'.charCodeAt(0); c >= 'D'.charCodeAt(0); c--) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      fs.accessSync(root);
    } catch {
      return root;
    }
  }
  return null;
}

const UNWRITABLE_HOME = (() => {
  if (process.platform !== 'win32') return '/dev/null/no-such-home-gshub-155';
  const root = absentDriveRoot();
  if (!root) {
    // Every letter D-Z is mounted. Rather than run the suite against a
    // writable path — which would turn six real assertions into six false
    // failures — say so and stop. A test that cannot establish its own
    // precondition must not pretend it did.
    console.error(
      '  ⚠ gshub-init-failure: no absent drive letter between D: and Z: on this host,\n' +
      '    so an unwritable HOME cannot be constructed. Skipping rather than reporting\n' +
      '    a failure that would be about the drive map, not the code.',
    );
    process.exit(0);
  }
  return path.join(root, 'no-such-drive-gshub-155');
})();

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
  });
}

(async () => {
  console.log('\ngshub-init-failure.test.js');

  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js', '--port', String(port)], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOME: UNWRITABLE_HOME, USERPROFILE: UNWRITABLE_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));
  let exitCode = null;
  child.on('exit', (c) => { exitCode = c; });

  // Wait for readiness (or an early death).
  for (let i = 0; i < 80 && exitCode === null; i++) {
    try { await get(port, '/api/state'); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }

  try {
    test('#155 the radio survives a GhostSignalsHub init failure',
      exitCode === null,
      `server exited with ${exitCode}; log tail:\n${serverLog.slice(-400)}`);

    if (exitCode === null) {
      const state = await get(port, '/api/state').catch((e) => ({ status: 'ERR ' + e.message, body: '' }));
      test('#155 unrelated endpoints keep serving',
        state.status === 200, `/api/state -> ${state.status}`);

      const gs = await get(port, '/api/gshub/stats').catch((e) => ({ status: 'ERR ' + e.message, body: '' }));
      test('#155 gshub answers 503 rather than crashing or 500-ing',
        gs.status === 503, `/api/gshub/stats -> ${gs.status} ${gs.body.slice(0, 160)}`);
      test('#155 the 503 names the subsystem instead of leaking an internal error',
        typeof gs.body === 'string' && gs.body.includes('ghostsignals_unavailable'),
        `body=${gs.body.slice(0, 200)}`);
      test('#155 no null-dereference message reaches the client',
        !/Cannot read properties of null/.test(gs.body),
        `body=${gs.body.slice(0, 200)}`);

      test('#155 the init failure is reported in the log',
        /\[gshub\] init failed:/.test(serverLog),
        `log tail:\n${serverLog.slice(-300)}`);
    }
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  GhostSignals init failure: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(failed === 0 ? 0 : 1);
})();
