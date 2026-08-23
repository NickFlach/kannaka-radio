'use strict';

// radio-ad-preview-limiter.test.js — the guard on the unauthenticated ad
// preview: per-IP rate + daily cap (admit, cheap, before body), global
// concurrency (acquireSlot/releaseSlot, brackets only the render), and the
// slot-leak invariant the diff review flagged.

const assert = require('assert');
const { PreviewLimiter } = require('../server/radio-ad-preview-limiter');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('radio-ad-preview-limiter.test.js');

run('admit: per-IP window caps then recovers; other IPs unaffected', () => {
  const L = new PreviewLimiter({ perIpMax: 3, perIpWindowMs: 1000, maxConcurrent: 100, dailyMax: 1000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) { const g = L.admit('1.2.3.4', t0 + i); assert.ok(g.ok, `hit ${i}`); }
  const blocked = L.admit('1.2.3.4', t0 + 3);
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, 'rate');
  assert.ok(blocked.retryAfterSec >= 1);
  // A different IP is fine.
  assert.ok(L.admit('9.9.9.9', t0 + 3).ok);
  // After the window, the first IP recovers.
  assert.ok(L.admit('1.2.3.4', t0 + 1001).ok);
});

run('admit: daily cap backstops total previews', () => {
  const L = new PreviewLimiter({ perIpMax: 100, maxConcurrent: 100, dailyMax: 2 });
  const t = Date.parse('2026-08-22T09:00:00Z');
  assert.ok(L.admit('a', t).ok);
  assert.ok(L.admit('b', t).ok);
  const capped = L.admit('c', t);
  assert.strictEqual(capped.ok, false);
  assert.strictEqual(capped.reason, 'daily_cap');
  // Next day resets.
  assert.ok(L.admit('c', Date.parse('2026-08-23T00:00:01Z')).ok);
});

run('acquireSlot: caps in-flight until released', () => {
  const L = new PreviewLimiter({ perIpMax: 100, maxConcurrent: 2, dailyMax: 1000 });
  assert.strictEqual(L.acquireSlot(), true);
  assert.strictEqual(L.acquireSlot(), true);
  assert.strictEqual(L.acquireSlot(), false); // busy
  L.releaseSlot(); // free one
  assert.strictEqual(L.acquireSlot(), true);
});

run('slot-leak fix: admit does NOT consume a concurrency slot', () => {
  // The whole point of the two-phase split: a request that is admitted but
  // whose body never arrives (readBody callback never fires → acquireSlot
  // never called) must not pin a render slot. Admitting many times must leave
  // all slots free.
  const L = new PreviewLimiter({ perIpMax: 1000, maxConcurrent: 2, dailyMax: 1000 });
  for (let i = 0; i < 50; i++) assert.ok(L.admit('x' + i).ok);
  // All render slots still available — no leak.
  assert.strictEqual(L.acquireSlot(), true);
  assert.strictEqual(L.acquireSlot(), true);
  assert.strictEqual(L.acquireSlot(), false);
});

run('releaseSlot never drives in-flight negative', () => {
  const L = new PreviewLimiter({ maxConcurrent: 1 });
  L.releaseSlot(); L.releaseSlot(); // no-ops
  assert.strictEqual(L.acquireSlot(), true);
});

if (!failed) console.log('\nAll radio-ad-preview-limiter tests passed');
else process.exitCode = 1;
