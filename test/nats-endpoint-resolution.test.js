/**
 * nats-endpoint-resolution.test.js — the radio must honour the
 * constellation-wide KANNAKA_NATS_URL (#99).
 *
 * Pre-fix, connect() read only NATS_HOST/NATS_PORT. A box configured the
 * constellation way — KANNAKA_NATS_URL pointing at the shared broker, which is
 * what kannaka-memory (ask.rs / identity.rs) and kannaka-eye's attention bridge
 * both resolve — silently connected to 127.0.0.1:4222 instead. Nothing errored;
 * the radio just sat alone on a swarm nobody else was on.
 *
 * resolveNatsEndpoint is pure, so this needs no broker and no sockets.
 */

'use strict';

const assert = require('assert');
const { resolveNatsEndpoint } = require('../server/nats-client');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

console.log('\nnats-endpoint-resolution.test.js');

test('#99 KANNAKA_NATS_URL is honoured', () => {
  const r = resolveNatsEndpoint({ KANNAKA_NATS_URL: 'nats://swarm.ninja-portal.com:4222' });
  assert.strictEqual(r.host, 'swarm.ninja-portal.com');
  assert.strictEqual(r.port, 4222);
  assert.strictEqual(r.source, 'KANNAKA_NATS_URL');
});

test('#99 KANNAKA_NATS_URL outranks the generic NATS_HOST/NATS_PORT', () => {
  const r = resolveNatsEndpoint({
    KANNAKA_NATS_URL: 'nats://specific:5222',
    NATS_HOST: 'generic', NATS_PORT: '6222',
  });
  assert.strictEqual(r.host, 'specific', 'the constellation-specific name must win');
  assert.strictEqual(r.port, 5222);
});

test('#99 credentials in the URL do not leak into the host', () => {
  // Auth is handled separately via NATS_USER/NATS_PASSWORD; the URL should
  // contribute host/port only.
  const r = resolveNatsEndpoint({ KANNAKA_NATS_URL: 'nats://user:pass@broker:4333' });
  assert.strictEqual(r.host, 'broker');
  assert.strictEqual(r.port, 4333);
});

test('#99 a URL without a port defaults to 4222', () => {
  assert.strictEqual(resolveNatsEndpoint({ KANNAKA_NATS_URL: 'nats://broker' }).port, 4222);
});

test('#99 NATS_HOST/NATS_PORT still work (no regression)', () => {
  const r = resolveNatsEndpoint({ NATS_HOST: 'oracle.internal', NATS_PORT: '4999' });
  assert.strictEqual(r.host, 'oracle.internal');
  assert.strictEqual(r.port, 4999);
});

test('#99 default remains 127.0.0.1:4222 when nothing is set', () => {
  const r = resolveNatsEndpoint({});
  assert.strictEqual(r.host, '127.0.0.1');
  assert.strictEqual(r.port, 4222);
});

test('#99 a malformed URL falls back instead of connecting somewhere unintended', () => {
  const r = resolveNatsEndpoint({ KANNAKA_NATS_URL: 'not-a-url', NATS_HOST: 'fallback' });
  assert.strictEqual(r.host, 'fallback');
});

test('#99 a blank KANNAKA_NATS_URL does not shadow NATS_HOST', () => {
  const r = resolveNatsEndpoint({ KANNAKA_NATS_URL: '   ', NATS_HOST: 'h2' });
  assert.strictEqual(r.host, 'h2', 'an empty env var is not a configured broker');
});

test('#99 an out-of-range port in the URL is rejected rather than used', () => {
  const r = resolveNatsEndpoint({ KANNAKA_NATS_URL: 'nats://broker:99999', NATS_HOST: 'fb' });
  assert.strictEqual(r.host, 'fb');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`  NATS endpoint resolution: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
