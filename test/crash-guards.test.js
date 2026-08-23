'use strict';

/**
 * crash-guards.test.js — the guards must be REAL: a stray rejection or throw
 * kills an unguarded Node process (fatal by default since Node 15), and this
 * server mounts an async handler on http.createServer, so that failure mode is
 * one missing `.catch()` away from dropping the live stream.
 *
 * These spawn actual child processes rather than asserting on mocks, because
 * the whole claim is about process-level behaviour: the control child MUST die
 * and the guarded child MUST survive. If the control ever stops dying, the test
 * has stopped proving anything.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARDS = path.join(__dirname, '..', 'server', 'crash-guards.js').replace(/\\/g, '\\\\');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

function node(src) {
  return spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 20000 });
}

console.log('crash-guards.test.js');

run('CONTROL: an unguarded unhandled rejection really does kill the process', () => {
  const r = node(`
    Promise.reject(new Error('boom'));
    setTimeout(() => { console.log('ALIVE'); }, 150);
  `);
  assert.notStrictEqual(r.status, 0, 'unguarded process must exit non-zero');
  assert.ok(!/ALIVE/.test(r.stdout), 'unguarded process must not reach the later tick');
});

run('guarded: an unhandled rejection is logged and the process stays alive', () => {
  const r = node(`
    require('${GUARDS}').installCrashGuards();
    Promise.reject(new Error('boom-rejection'));
    setTimeout(() => { console.log('ALIVE'); }, 150);
  `);
  assert.strictEqual(r.status, 0, 'guarded process must exit cleanly: ' + r.stderr);
  assert.ok(/ALIVE/.test(r.stdout), 'guarded process kept running');
  assert.ok(/crash-guard/.test(r.stderr), 'the failure was logged, not hidden');
  assert.ok(/boom-rejection/.test(r.stderr), 'the original error text survives in the log');
});

run('guarded: an uncaught exception is logged and the process stays alive', () => {
  const r = node(`
    require('${GUARDS}').installCrashGuards();
    setTimeout(() => { throw new Error('boom-exception'); }, 10);
    setTimeout(() => { console.log('ALIVE'); }, 200);
  `);
  assert.strictEqual(r.status, 0, 'guarded process must survive a throw in a timer');
  assert.ok(/ALIVE/.test(r.stdout));
  assert.ok(/boom-exception/.test(r.stderr));
});

run('guarded: the stack is preserved in the log (a guard that hides bugs is worse)', () => {
  const r = node(`
    require('${GUARDS}').installCrashGuards();
    function namedFrameForTheTest() { return Promise.reject(new Error('with-stack')); }
    namedFrameForTheTest();
    setTimeout(() => { console.log('ALIVE'); }, 150);
  `);
  assert.ok(/namedFrameForTheTest/.test(r.stderr), 'stack frames are logged');
});

run('storm: repeated failures exit for a clean restart instead of serving wedged', () => {
  const r = node(`
    require('${GUARDS}').installCrashGuards({ maxInWindow: 3, windowMs: 60000 });
    for (let i = 0; i < 5; i++) Promise.reject(new Error('storm-' + i));
    setTimeout(() => { console.log('ALIVE'); }, 300);
  `);
  assert.notStrictEqual(r.status, 0, 'a storm must exit so systemd restarts');
  assert.ok(/looks wedged/.test(r.stderr), 'the exit reason is explained');
  assert.ok(!/ALIVE/.test(r.stdout), 'it exits rather than continuing');
});

run('storm counter only counts failures INSIDE the window', () => {
  const { installCrashGuards } = require('../server/crash-guards');
  let exited = 0;
  const logs = [];
  const fakeProc = { on: () => {} };
  const h = installCrashGuards({ process: fakeProc, logger: (m) => logs.push(m), exit: () => { exited++; }, maxInWindow: 3, windowMs: 50 });
  h._onRejection(new Error('a'));
  h._onRejection(new Error('b'));
  assert.strictEqual(exited, 0, 'below the threshold, no exit');
  const start = Date.now();
  while (Date.now() - start < 60) { /* let the window lapse */ }
  h._onRejection(new Error('c'));
  assert.strictEqual(exited, 0, 'old failures aged out of the window');
  assert.strictEqual(h.count(), 1, 'only the fresh failure is counted');
});

if (!failed) console.log('\nAll crash-guards tests passed');
else process.exitCode = 1;
