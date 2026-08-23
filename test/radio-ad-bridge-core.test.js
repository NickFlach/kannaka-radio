'use strict';

// radio-ad-bridge-core.test.js — the pure bridge crypto/logic: direction-bound
// HMAC (two secrets), enact validation, and retry backoff.

const assert = require('assert');
const { signBridge, verifyBridge, parseEnact, raiseBackoffMs } = require('../server/radio-ad-bridge-core');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('radio-ad-bridge-core.test.js');

const RAISE = 'raise_secret_A';
const ENACT = 'enact_secret_B';
const NOW = 1_800_000_000;

run('sign/verify round-trips within tolerance', () => {
  const body = '{"adId":"ad_1","decision":"approve"}';
  const h = signBridge(body, ENACT, NOW);
  assert.strictEqual(verifyBridge(body, h, ENACT, NOW), true);
});

run('DIRECTION ISOLATION: a raise-signed body does NOT verify with the enact secret', () => {
  const body = '{"adId":"ad_1"}';
  const raiseHeader = signBridge(body, RAISE, NOW);
  // A captured raise replayed against the enact endpoint (which checks ENACT) fails.
  assert.strictEqual(verifyBridge(body, raiseHeader, ENACT, NOW), false);
  // And vice-versa.
  const enactHeader = signBridge(body, ENACT, NOW);
  assert.strictEqual(verifyBridge(body, enactHeader, RAISE, NOW), false);
});

run('tampered body fails', () => {
  const h = signBridge('{"adId":"ad_1","decision":"approve"}', ENACT, NOW);
  assert.strictEqual(verifyBridge('{"adId":"ad_1","decision":"reject"}', h, ENACT, NOW), false);
});

run('stale timestamp (replay) outside tolerance fails', () => {
  const body = '{"adId":"ad_1"}';
  const h = signBridge(body, ENACT, NOW - 3600);
  assert.strictEqual(verifyBridge(body, h, ENACT, NOW), false);
  assert.strictEqual(verifyBridge(body, signBridge(body, ENACT, NOW - 60), ENACT, NOW), true);
});

run('malformed / missing header or secret fails safely', () => {
  const body = '{"a":1}';
  assert.strictEqual(verifyBridge(body, '', ENACT, NOW), false);
  assert.strictEqual(verifyBridge(body, 'garbage', ENACT, NOW), false);
  assert.strictEqual(verifyBridge(body, `t=${NOW}`, ENACT, NOW), false);
  assert.strictEqual(verifyBridge(body, signBridge(body, ENACT, NOW), '', NOW), false);
});

run('parseEnact validates adId + decision', () => {
  assert.deepStrictEqual(parseEnact({ adId: 'ad_1', decision: 'approve' }), { ok: true, adId: 'ad_1', decision: 'approve' });
  assert.deepStrictEqual(parseEnact({ adId: 'ad_2', decision: 'reject' }), { ok: true, adId: 'ad_2', decision: 'reject' });
  assert.strictEqual(parseEnact({ decision: 'approve' }).ok, false);
  assert.strictEqual(parseEnact({ adId: 'ad_1', decision: 'maybe' }).ok, false);
  assert.strictEqual(parseEnact(null).ok, false);
});

run('raiseBackoffMs is monotonic then capped (retry forever, no terminal state)', () => {
  const b0 = raiseBackoffMs(0);
  const b1 = raiseBackoffMs(1);
  const b5 = raiseBackoffMs(5);
  assert.ok(b1 > b0, 'grows');
  assert.ok(raiseBackoffMs(100) <= 60 * 60_000, 'capped at 1h');
  assert.ok(b5 <= 60 * 60_000);
});

if (!failed) console.log('\nAll radio-ad-bridge-core tests passed');
else process.exitCode = 1;
