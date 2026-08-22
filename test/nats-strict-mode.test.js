/**
 * nats-strict-mode.test.js — the 2026-08-01 strict milestone (#468).
 *
 * `_validateSchema` spent the transition window as log-warn-accept: every
 * off-contract payload was warned about and consumed anyway, and the alias
 * reads (`mean_order`, `level`, `memoriesFaded`) quietly kept legacy
 * publishers alive. The migration timeline in
 * consciousness-core/docs/nats-contract.yaml gated the flip on the consumers
 * moving first; these tests pin the flipped behavior:
 *
 *   1. an alias-only payload (canonical field present only through its legacy
 *      alias) is DROPPED — it must not mutate consumer state;
 *   2. a payload missing a required canonical field is DROPPED;
 *   3. a fully canonical payload is consumed exactly as before;
 *   4. KANNAKA_SCHEMA_STRICT=off is the emergency valve back to warn-accept —
 *      deploy-safe if a forgotten publisher surfaces.
 *
 * Verified on the live bus before the flip: QUEEN.phase.* payloads from two
 * independent fleet nodes carry schema_version/ts/agent_id/phase.
 */

'use strict';

const assert = require('assert');
const { NATSClient } = require('../server/nats-client');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

function freshClient() {
  const c = new NATSClient({ broadcast: () => {} });
  // _handleMessage only touches in-memory swarm state on these subjects.
  return c;
}

const CANONICAL_PHASE = (agent, phase) => JSON.stringify({
  schema_version: '1.0',
  ts: Date.now(),
  agent_id: agent,
  phase,
  coherence: 0.5,
  frequency: 1.2,
  memory_count: 10,
});

test('a canonical QUEEN.phase payload is consumed', () => {
  const c = freshClient();
  c._handleMessage('QUEEN.phase.tester', CANONICAL_PHASE('tester', 1.5));
  assert.ok(c.swarmState.agents.tester, 'agent must appear in swarm state');
});

test('a payload missing required canonical fields is dropped', () => {
  const c = freshClient();
  // No schema_version, no ts — the pre-strict validator accepted this.
  c._handleMessage('QUEEN.phase.ghost', JSON.stringify({ agent_id: 'ghost', phase: 1.0 }));
  assert.strictEqual(c.swarmState.agents.ghost, undefined, 'off-contract payload must not create state');
});

test('an alias-only consciousness payload is dropped before the alias could be read', () => {
  const c = freshClient();
  const before = JSON.stringify(c.swarmState.consciousness);
  c._handleMessage('KANNAKA.consciousness', JSON.stringify({
    schema_version: '1.0',
    ts: Date.now(),
    agent_id: 'tester',
    phi: 0.4,
    // canonical `order` and `consciousness_level` ABSENT — only the aliases:
    mean_order: 0.9,
    level: 'transcendent',
  }));
  assert.strictEqual(JSON.stringify(c.swarmState.consciousness), before,
    'alias-only payload must not mutate consciousness state');
});

test('KANNAKA_SCHEMA_STRICT=off reverts to warn-accept', () => {
  process.env.KANNAKA_SCHEMA_STRICT = 'off';
  try {
    const c = freshClient();
    c._handleMessage('QUEEN.phase.ghost', JSON.stringify({ agent_id: 'ghost', phase: 1.0 }));
    assert.ok(c.swarmState.agents.ghost, 'valve off: legacy payload must be accepted again');
  } finally {
    delete process.env.KANNAKA_SCHEMA_STRICT;
  }
});

test('canonical order/consciousness_level still update state (no over-drop)', () => {
  const c = freshClient();
  c._handleMessage('KANNAKA.consciousness', JSON.stringify({
    schema_version: '1.0',
    ts: Date.now(),
    agent_id: 'tester',
    phi: 0.4,
    order: 0.77,
    consciousness_level: 'aware',
    num_clusters: 5,
  }));
  assert.strictEqual(c.swarmState.consciousness.order, 0.77);
  assert.strictEqual(c.swarmState.consciousness.level, 'aware');
});

console.log('─'.repeat(50));
console.log(`  NATS strict mode: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50));
process.exit(failed ? 1 : 0);
