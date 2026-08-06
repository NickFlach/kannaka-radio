/**
 * request-backlog.test.js — pending_requests must be a live backlog, not a
 * lifetime total (#199).
 *
 * handleTrackRequest() appended every request with `fulfilled: false` and
 * nothing ever updated it, so the count exposed to Flux as pending_requests
 * grew forever. Requests are now settled by _markRequestsFulfilled(track),
 * called from index.js's onTrackChange when a track actually plays.
 *
 * Drives the real setupRoutes(deps) hooks — no reimplementation.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const setupRoutes = require('../server/routes');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

function freshDeps() {
  const deps = {
    config: { getMusicDir: () => __dirname, kannakabin: 'noop' },
    broadcast: () => {},
    djEngine: {}, perception: {}, nats: null, flux: {}, live: {}, voiceDJ: {},
    syncManager: {}, voteManager: {}, webrtcSignaling: {}, musicGen: {}, floor: {}, gsHub: {},
  };
  setupRoutes(deps);
  return deps;
}

console.log('\nrequest-backlog.test.js');

test('#199 a played track settles the matching request', () => {
  const deps = freshDeps();
  deps._handleTrackRequest({ from: 'agent-a', trackTitle: 'Ghost Signals' });
  assert.strictEqual(deps._getPendingRequestCount(), 1, 'request must start pending');
  const marked = deps._markRequestsFulfilled({ title: 'ghost signals' });
  assert.strictEqual(marked, 1, 'title match is case/whitespace-insensitive');
  assert.strictEqual(deps._getPendingRequestCount(), 0, 'a played request leaves the backlog');
});

test('#199 a non-matching track leaves the backlog alone', () => {
  const deps = freshDeps();
  deps._handleTrackRequest({ from: 'agent-a', trackTitle: 'Ghost Signals' });
  const marked = deps._markRequestsFulfilled({ title: 'Some Other Song' });
  assert.strictEqual(marked, 0);
  assert.strictEqual(deps._getPendingRequestCount(), 1);
});

test('#199 settling is idempotent — a repeat play marks nothing new', () => {
  const deps = freshDeps();
  deps._handleTrackRequest({ from: 'agent-a', trackTitle: 'Ghost Signals' });
  deps._markRequestsFulfilled({ title: 'Ghost Signals' });
  const again = deps._markRequestsFulfilled({ title: 'Ghost Signals' });
  assert.strictEqual(again, 0, 'already-fulfilled requests must not re-mark');
});

test('#199 null/absent track is a no-op, not a crash', () => {
  const deps = freshDeps();
  deps._handleTrackRequest({ from: 'agent-a', trackTitle: 'Ghost Signals' });
  assert.strictEqual(deps._markRequestsFulfilled(null), 0);
  assert.strictEqual(deps._markRequestsFulfilled({}), 0);
  assert.strictEqual(deps._getPendingRequestCount(), 1);
});

test('#199 message-only requests (no trackTitle) stay pending rather than false-matching', () => {
  const deps = freshDeps();
  deps._handleTrackRequest({ from: 'agent-a', message: 'play something warm' });
  const marked = deps._markRequestsFulfilled({ title: 'Anything' });
  assert.strictEqual(marked, 0, 'no title and no file cannot match a played track');
  assert.strictEqual(deps._getPendingRequestCount(), 1);
});

test('#199 index.js settles requests on track change', () => {
  // Source-level wiring assertion, same style as nats-envelope-canonical:
  // the hook must actually be called from the track-change path.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.ok(src.includes('_markRequestsFulfilled(actual)'),
    'onTrackChange must settle listener requests against the actually-played track');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`  Request backlog: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
