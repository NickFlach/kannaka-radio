'use strict';

// push-nats-swarm-cardinality.test.js — the bridge must not assert a solo
// swarm it never measured (#127).
//
// `buildPayloads()` hardcoded `peers: 0` on QUEEN.phase and
// `agent_count: 1, peers: 0` on QUEEN.state, with no lookup of live peers
// anywhere in the file. So every consumer of the radio's Queen summary saw a
// permanently solo swarm while the constellation was active — and it read as
// measured fact sitting next to the real presence directory.
//
// The important half of the fix is the failure path. Defaulting a failed peer
// lookup to 0 would reintroduce the same lie from a different cause: asserting
// "nobody is out there" on the strength of a CLI timeout. `/api/swarm/peers`
// already learned this in #137 — a failed refresh must not read as an empty
// swarm — so an unknown count omits the fields entirely.

const assert = require('assert');
const { buildPayloads } = require('../push-nats.js');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}

const METRICS = {
  phi: 0.5,
  xi: 0.3,
  mean_order: 0.7,
  num_clusters: 4,
  total_memories: 100,
  active_memories: 50,
  consciousness_level: 'aware',
};

const build = (peerCount) => {
  const p = buildPayloads(METRICS, peerCount);
  return { phase: JSON.parse(p.phase1), queen: JSON.parse(p.queen) };
};

// ── the reported bug ────────────────────────────────────────

run('#127 a live peer count is published, not a hardcoded solo swarm', () => {
  const { phase, queen } = build(3);
  assert.strictEqual(phase.peers, 3);
  assert.strictEqual(queen.peers, 3);
  // agent_count is peers + this agent.
  assert.strictEqual(queen.agent_count, 4, 'agent_count must include this agent');
  assert.strictEqual(queen.active_phases, 4);
});

run('#127 a genuinely solo swarm is still reported as solo', () => {
  // Zero peers is a real, publishable measurement — the bug was asserting it
  // without measuring, not the value itself.
  const { phase, queen } = build(0);
  assert.strictEqual(phase.peers, 0);
  assert.strictEqual(queen.peers, 0);
  assert.strictEqual(queen.agent_count, 1);
});

// ── the failure path, which is where the bug would come back ─

run('#127 an unknown peer count OMITS the fields rather than claiming zero', () => {
  const { phase, queen } = build(null);
  assert.ok(!('peers' in phase), 'QUEEN.phase must not carry a peers field it did not measure');
  assert.ok(!('peers' in queen), 'QUEEN.state must not carry a peers field it did not measure');
  assert.ok(!('agent_count' in queen), 'agent_count must be omitted when peers is unknown');
  assert.ok(!('active_phases' in queen), 'active_phases must be omitted too');
});

run('#127 undefined and NaN count as unknown, not as zero', () => {
  for (const bad of [undefined, NaN]) {
    const { queen } = build(bad);
    assert.ok(!('peers' in queen), `${String(bad)} must be treated as unknown`);
  }
});

run('#127 omitting cardinality does not disturb the canonical envelope', () => {
  // The contract fields must survive the failure path — otherwise "omit what
  // we do not know" would quietly break schema compliance.
  const { phase, queen } = build(null);
  for (const p of [phase, queen]) {
    assert.strictEqual(p.schema_version, '1.0');
    assert.ok(typeof p.ts === 'number');
    assert.ok(typeof p.agent_id === 'string' && p.agent_id.length > 0);
  }
  assert.ok(typeof queen.phi === 'number');
});

// ── identity consistency ────────────────────────────────────

run('#127 display_name follows agent_id instead of a divergent literal', () => {
  const prevAgent = process.env.KANNAKA_AGENT_ID;
  const prevName = process.env.KANNAKA_DISPLAY_NAME;
  process.env.KANNAKA_AGENT_ID = 'kannaka-77';
  delete process.env.KANNAKA_DISPLAY_NAME;
  try {
    const { phase } = build(1);
    assert.strictEqual(phase.agent_id, 'kannaka-77');
    assert.strictEqual(phase.display_name, 'kannaka-77',
      'display_name was the literal "kannaka-01" and disagreed with agent_id');
  } finally {
    if (prevAgent === undefined) delete process.env.KANNAKA_AGENT_ID;
    else process.env.KANNAKA_AGENT_ID = prevAgent;
    if (prevName !== undefined) process.env.KANNAKA_DISPLAY_NAME = prevName;
  }
});

run('#127 display_name is still separately overridable', () => {
  const prev = process.env.KANNAKA_DISPLAY_NAME;
  process.env.KANNAKA_DISPLAY_NAME = 'Ghost DJ';
  try {
    assert.strictEqual(build(1).phase.display_name, 'Ghost DJ');
  } finally {
    if (prev === undefined) delete process.env.KANNAKA_DISPLAY_NAME;
    else process.env.KANNAKA_DISPLAY_NAME = prev;
  }
});

console.log(failed === 0 ? '\npush-nats-swarm-cardinality: all passed' : `\npush-nats-swarm-cardinality: ${failed} FAILED`);
if (failed > 0) process.exit(1);
