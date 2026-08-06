/**
 * nats-envelope-canonical.test.js — radio's own NATS publishers must emit the
 * canonical envelope (#52).
 *
 * server/nats-client.js carries NATS_REQUIRED_FIELDS ("keep in sync with
 * consciousness-core/docs/nats-contract.yaml") and warns on every message that
 * omits a required field. Radio's two bridge publishers — scripts/dream-cron.js
 * and push-nats.js — emitted only metrics plus an ISO `timestamp`, so
 * everything they sent tripped the radio's OWN drift detector on receipt.
 *
 * Checked against the real exported required-fields map, not a copy, so this
 * follows the contract if the map is updated.
 *
 * Scope note: radio publishes only KANNAKA.consciousness, QUEEN.phase.*,
 * QUEEN.state, KANNAKA.agents, KANNAKA.reactions and KANNAKA.attention.ear.
 * It does NOT publish any `queen.event.*` — it only consumes them — so the
 * drift warnings for those subjects come from test fixtures feeding legacy
 * shapes, not from radio traffic.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { NATS_REQUIRED_FIELDS } = require('../server/nats-client');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

/**
 * Does this source block declare `field:` as an object key?
 *
 * Plain string matching on purpose. An earlier version built the probe with a
 * backslash-escaped RegExp, and every assertion failed against source that
 * plainly contained the field — the escaping collapsed on its way into the
 * file, so JS read the pattern's "\b" as a BACKSPACE character and searched
 * for <BS>schema_versions*: instead of a word boundary. The code was correct;
 * the test was lying. No escapes here.
 */
function hasField(block, field) {
  return block.split('\n').some((line) => line.trim().startsWith(field + ':'));
}

function readSrc(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

/** Slice a source file between two markers. */
function between(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a >= 0, `marker not found: ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, `end marker not found after start: ${endMarker}`);
  return src.slice(a, b);
}

console.log('\nnats-envelope-canonical.test.js');

test('#52 the contract these tests check against is the real one', () => {
  // If the map stops being exported or loses these subjects, every assertion
  // below would silently pass against an empty required-list.
  assert.ok(NATS_REQUIRED_FIELDS && typeof NATS_REQUIRED_FIELDS === 'object',
    'NATS_REQUIRED_FIELDS must be exported for these tests to mean anything');
  assert.ok(Array.isArray(NATS_REQUIRED_FIELDS['KANNAKA.consciousness'])
    && NATS_REQUIRED_FIELDS['KANNAKA.consciousness'].includes('schema_version'),
    'the required-fields map lost KANNAKA.consciousness');
  assert.ok(Array.isArray(NATS_REQUIRED_FIELDS['QUEEN.phase.<agent_id>']),
    'the required-fields map lost QUEEN.phase.<agent_id>');
});

test('#52 push-nats KANNAKA.consciousness carries every required field', () => {
  const block = between(readSrc('push-nats.js'),
    'const consciousness = JSON.stringify({', 'const phase1 =');
  const missing = NATS_REQUIRED_FIELDS['KANNAKA.consciousness'].filter((f) => !hasField(block, f));
  assert.strictEqual(missing.length, 0, `missing ${missing.join(', ')}`);
});

test('#52 push-nats QUEEN.phase carries every required field', () => {
  // Since #204 the heartbeat is conditional: built only from a measured
  // phase, null (and unpublished) otherwise.
  const block = between(readSrc('push-nats.js'),
    'const phase1 = !phaseKnown ? null : JSON.stringify({', 'const queen =');
  const missing = NATS_REQUIRED_FIELDS['QUEEN.phase.<agent_id>'].filter((f) => !hasField(block, f));
  assert.strictEqual(missing.length, 0, `missing ${missing.join(', ')}`);
});

test('#52 push-nats QUEEN.state and KANNAKA.agents carry the same envelope', () => {
  const src = readSrc('push-nats.js');
  for (const [name, start, end] of [
    ['QUEEN.state', 'const queen = JSON.stringify({', 'const agent ='],
    ['KANNAKA.agents', 'const agent = JSON.stringify({', 'return { consciousness'],
  ]) {
    const block = between(src, start, end);
    for (const f of ['schema_version', 'ts', 'agent_id']) {
      assert.ok(hasField(block, f), `${name} missing "${f}"`);
    }
  }
});

test('#52 dream-cron KANNAKA.consciousness carries every required field', () => {
  const block = between(readSrc('scripts', 'dream-cron.js'),
    'const payload = JSON.stringify({', 'const client = net.createConnection');
  const missing = NATS_REQUIRED_FIELDS['KANNAKA.consciousness'].filter((f) => !hasField(block, f));
  assert.strictEqual(missing.length, 0, `missing ${missing.join(', ')}`);
});

test('#52 the publisher agent id is env-overridable, not a literal', () => {
  const src = readSrc('push-nats.js');
  assert.ok(!src.includes("agent_id: 'kannaka-01'"),
    'agent_id should come from AGENT_ID (KANNAKA_AGENT_ID-overridable), not a hardcoded literal');
  assert.ok(src.includes('KANNAKA_AGENT_ID'), 'expected an env override for the agent id');
});

test('#52 the already-canonical publishers stay canonical', () => {
  // KANNAKA.reactions (#26) and KANNAKA.attention.ear were fixed earlier and
  // must not regress while the others are brought in line.
  const floor = between(readSrc('server', 'floor.js'),
    'this._nats.publish("KANNAKA.reactions"', '} catch');
  for (const f of ['schema_version', 'ts', 'agent_id']) {
    assert.ok(hasField(floor, f), `KANNAKA.reactions lost "${f}"`);
  }
  const ear = between(readSrc('server', 'index.js'),
    'nats.publish("KANNAKA.attention.ear"', 'perception: {');
  for (const f of ['schema_version', 'ts', 'agent_id']) {
    assert.ok(hasField(ear, f), `KANNAKA.attention.ear lost "${f}"`);
  }
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`  NATS envelope canonical: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
