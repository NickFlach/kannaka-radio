'use strict';

// radio-ad-preview-limiter.test.js — the guard on the unauthenticated ad
// preview: per-IP rate, global concurrency, daily cap, and slot release.

const assert = require('assert');
const { PreviewLimiter } = require('../server/radio-ad-preview-limiter');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('radio-ad-preview-limiter.test.js');

run('per-IP window caps then recovers; other IPs unaffected', () => {
  const L = new PreviewLimiter({ perIpMax: 3, perIpWindowMs: 1000, maxConcurrent: 100, dailyMax: 1000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) { const g = L.tryAcquire('1.2.3.4', t0 + i); assert.ok(g.ok, `hit ${i}`); L.release(); }
  const blocked = L.tryAcquire('1.2.3.4', t0 + 3);
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, 'rate');
  assert.ok(blocked.retryAfterSec >= 1);
  // A different IP is fine.
  const other = L.tryAcquire('9.9.9.9', t0 + 3); assert.ok(other.ok); L.release();
  // After the window, the first IP recovers.
  const later = L.tryAcquire('1.2.3.4', t0 + 1001); assert.ok(later.ok); L.release();
});

run('global concurrency caps in-flight until released', () => {
  const L = new PreviewLimiter({ perIpMax: 100, maxConcurrent: 2, dailyMax: 1000 });
  assert.ok(L.tryAcquire('a').ok);
  assert.ok(L.tryAcquire('b').ok);
  const busy = L.tryAcquire('c');
  assert.strictEqual(busy.ok, false);
  assert.strictEqual(busy.reason, 'busy');
  L.release(); // free one slot
  assert.ok(L.tryAcquire('c').ok);
});

run('daily cap backstops total previews', () => {
  const L = new PreviewLimiter({ perIpMax: 100, maxConcurrent: 100, dailyMax: 2 });
  const t = Date.parse('2026-08-22T09:00:00Z');
  assert.ok(L.tryAcquire('a', t).ok); L.release();
  assert.ok(L.tryAcquire('b', t).ok); L.release();
  const capped = L.tryAcquire('c', t);
  assert.strictEqual(capped.ok, false);
  assert.strictEqual(capped.reason, 'daily_cap');
  // Next day resets.
  const nextDay = Date.parse('2026-08-23T00:00:01Z');
  assert.ok(L.tryAcquire('c', nextDay).ok); L.release();
});

run('release never drives in-flight negative', () => {
  const L = new PreviewLimiter({ maxConcurrent: 1 });
  L.release(); L.release(); // no-ops
  assert.ok(L.tryAcquire('a').ok);
});

if (!failed) console.log('\nAll radio-ad-preview-limiter tests passed');
else process.exitCode = 1;
