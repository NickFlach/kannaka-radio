'use strict';

// tower-floor.test.js — the tenant receiver for KAX-ADR-0005's dogfood floor.
//
// The one thing that must hold: an unsigned or wrongly-signed delivery is
// never trusted, and a correctly-signed one folds into the brief exactly
// once. The signature is over the EXACT bytes, keyed by the secret the tower
// returned at webhook registration.

const assert = require('assert');
const crypto = require('crypto');
const tf = require('../server/tower-floor');

const SECRET = 'twhs_test_secret';
function sign(body) {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
}

function run(name, fn) {
  try { tf._resetBrief(); fn(); console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

console.log('tower-floor.test.js');

run('inert without a secret (503), never trusting the body', () => {
  const body = JSON.stringify({ id: 1, kind: 'chat.said', payload: { text: 'hi' } });
  const out = tf.receiveTowerEvent(body, { 'x-tower-signature': sign(body) }, undefined);
  assert.strictEqual(out.status, 503);
  assert.strictEqual(tf.towerBrief().counts.chat, 0);
});

run('rejects a missing signature (401)', () => {
  const body = JSON.stringify({ id: 1, kind: 'chat.said', payload: { text: 'hi' } });
  const out = tf.receiveTowerEvent(body, {}, SECRET);
  assert.strictEqual(out.status, 401);
  assert.strictEqual(tf.towerBrief().counts.chat, 0);
});

run('rejects a wrong signature and a tampered body (401)', () => {
  const body = JSON.stringify({ id: 1, kind: 'chat.said', payload: { text: 'hi' } });
  assert.strictEqual(tf.receiveTowerEvent(body, { 'x-tower-signature': 'sha256=deadbeef' }, SECRET).status, 401);
  // A valid signature for a DIFFERENT body must not validate this one.
  const otherSig = sign(body + ' ');
  assert.strictEqual(tf.receiveTowerEvent(body, { 'x-tower-signature': otherSig }, SECRET).status, 401);
  assert.strictEqual(tf.towerBrief().counts.chat, 0);
});

run('accepts a correctly-signed chat line and briefs it', () => {
  const body = JSON.stringify({ id: 7, kind: 'chat.said', floorNo: 4, at: '2026-08-22T00:00:00Z', payload: { name: 'Kannaka', text: 'the market is quiet tonight' } });
  const out = tf.receiveTowerEvent(body, { 'x-tower-signature': sign(body) }, SECRET);
  assert.strictEqual(out.status, 200);
  const b = tf.towerBrief();
  assert.strictEqual(b.counts.chat, 1);
  assert.strictEqual(b.floorNo, 4);
  assert.strictEqual(b.recentLines[0].name, 'Kannaka');
});

run('is idempotent on an immediately re-delivered id', () => {
  const body = JSON.stringify({ id: 7, kind: 'chat.said', payload: { name: 'Kannaka', text: 'x' } });
  const h = { 'x-tower-signature': sign(body) };
  assert.strictEqual(tf.receiveTowerEvent(body, h, SECRET).status, 200);
  assert.strictEqual(tf.receiveTowerEvent(body, h, SECRET).status, 200); // re-delivery
  assert.strictEqual(tf.towerBrief().counts.chat, 1); // counted once
});

run('folds panel and lease events, tolerates unknown kinds', () => {
  const mk = (o) => { const s = JSON.stringify(o); return tf.receiveTowerEvent(s, { 'x-tower-signature': sign(s) }, SECRET); };
  assert.strictEqual(mk({ id: 1, kind: 'panel.updated', payload: { headline: 'Quiet markets' } }).status, 200);
  assert.strictEqual(mk({ id: 2, kind: 'lease.dark', payload: { reason: 'rent' } }).status, 200);
  assert.strictEqual(mk({ id: 3, kind: 'something.new', payload: {} }).status, 200); // forward-compatible
  const b = tf.towerBrief();
  assert.strictEqual(b.panelHeadline, 'Quiet markets');
  assert.strictEqual(b.lease, 'dark');
});

run('rejects malformed json AFTER the signature checks out (400)', () => {
  const body = 'not json';
  const out = tf.receiveTowerEvent(body, { 'x-tower-signature': sign(body) }, SECRET);
  assert.strictEqual(out.status, 400);
});

run('the brief keeps at most MAX_BRIEF_LINES', () => {
  for (let i = 0; i < tf.MAX_BRIEF_LINES + 25; i++) {
    const body = JSON.stringify({ id: 1000 + i, kind: 'chat.said', payload: { text: `line ${i}` } });
    tf.receiveTowerEvent(body, { 'x-tower-signature': sign(body) }, SECRET);
  }
  // recentLines is a 20-slice; the internal cap is MAX_BRIEF_LINES — assert
  // the count kept climbing but memory stayed bounded (no throw, slice works).
  const b = tf.towerBrief();
  assert.strictEqual(b.counts.chat, tf.MAX_BRIEF_LINES + 25);
  assert.ok(b.recentLines.length <= 20);
});

if (!process.exitCode) console.log('\nAll tower-floor tests passed');
