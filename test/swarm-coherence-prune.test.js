/**
 * swarm-coherence-prune.test.js — pruning stale agents must also drop their
 * coherence (#126).
 *
 * The 60s prune loop deleted stale agents and updated queen.agentCount, but
 * localOrderParameter / meanPhase were only ever recomputed inside the
 * QUEEN.phase.* gossip handler. So once the agents stopped publishing — which
 * is exactly why they got pruned — nothing recomputed coherence, and
 * /api/swarm reported the order parameter of a swarm that no longer existed:
 * agentCount 0 alongside coherence 0.87.
 *
 * Drives the real NATSClient. No sockets: the prune body and the gossip
 * handler both go through _recomputeCoherence(), which is pure over swarmState.
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

function client() {
  return new NATSClient({ broadcast: () => {} });
}

console.log('\nswarm-coherence-prune.test.js');

test('#126 a fully pruned swarm reports zero coherence, not the departed value', () => {
  const c = client();
  const now = Date.now();
  c.swarmState.agents = { a: { phase: 1.0, lastSeen: now }, b: { phase: 1.0, lastSeen: now } };
  c._recomputeCoherence();
  assert.ok(c.swarmState.queen.localOrderParameter > 0.99, 'phase-locked pair should read ~1');

  // What the prune loop does when everyone has gone stale.
  c.swarmState.agents = {};
  c._recomputeCoherence();
  assert.strictEqual(c.swarmState.queen.localOrderParameter, 0,
    'an empty swarm is not a coherent one');
  assert.strictEqual(c.swarmState.queen.meanPhase, 0);
});

test('#126 coherence tracks the agents that remain', () => {
  const c = client();
  const now = Date.now();
  // Two anti-phase agents cancel out (order ~0); dropping one leaves order 1.
  c.swarmState.agents = { a: { phase: 0, lastSeen: now }, b: { phase: Math.PI, lastSeen: now } };
  c._recomputeCoherence();
  assert.ok(c.swarmState.queen.localOrderParameter < 0.01,
    `anti-phase pair should cancel, got ${c.swarmState.queen.localOrderParameter}`);

  delete c.swarmState.agents.b;
  c._recomputeCoherence();
  assert.ok(c.swarmState.queen.localOrderParameter > 0.99,
    'a lone agent is trivially phase-locked with itself');
});

test('#126 one non-numeric phase does not NaN the whole metric', () => {
  const c = client();
  const now = Date.now();
  c.swarmState.agents = { bad: { phase: 'not-a-number', lastSeen: now }, ok: { phase: 0, lastSeen: now } };
  c._recomputeCoherence();
  assert.ok(Number.isFinite(c.swarmState.queen.localOrderParameter),
    `got ${c.swarmState.queen.localOrderParameter}`);
});

test('#126 meanPhase stays in [0, 2pi)', () => {
  const c = client();
  const now = Date.now();
  c.swarmState.agents = { a: { phase: -0.5, lastSeen: now } };
  c._recomputeCoherence();
  const m = c.swarmState.queen.meanPhase;
  assert.ok(m >= 0 && m < 2 * Math.PI, `meanPhase out of range: ${m}`);
});

test('#126 pruneStaleAgents() itself clears departed-swarm coherence', () => {
  // The real prune body, driven directly — this is the assertion that fails if
  // the recompute is ever removed from it again.
  const c = client();
  const stale = Date.now() - 600000;
  c.swarmState.agents = { a: { phase: 1.0, lastSeen: stale }, b: { phase: 1.0, lastSeen: stale } };
  c._recomputeCoherence();
  assert.ok(c.swarmState.queen.localOrderParameter > 0.99, 'they were coherent while alive');

  const dropped = c.pruneStaleAgents();
  assert.strictEqual(dropped, 2, 'both stale agents should be dropped');
  assert.strictEqual(c.swarmState.queen.agentCount, 0);
  assert.strictEqual(c.swarmState.queen.localOrderParameter, 0,
    'ghost coherence: agentCount 0 must not sit next to a non-zero order parameter');
});

test('#126 a live agent survives the prune and keeps its coherence', () => {
  const c = client();
  const now = Date.now();
  c.swarmState.agents = { live: { phase: 0.5, lastSeen: now }, gone: { phase: 0.5, lastSeen: now - 600000 } };
  const dropped = c.pruneStaleAgents();
  assert.strictEqual(dropped, 1, 'only the stale one goes');
  assert.strictEqual(c.swarmState.queen.agentCount, 1);
  assert.ok(c.swarmState.queen.localOrderParameter > 0.99,
    'the survivor is still trivially phase-locked; prune must not zero a live swarm');
});

test('#126 the prune loop and the gossip handler share one implementation', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server', 'nats-client.js'), 'utf8');
  const calls = (src.match(/this\._recomputeCoherence\(\)/g) || []).length;
  assert.ok(calls >= 2,
    `both paths must call the shared helper, found ${calls} call site(s) — ` +
    'a second copy of the Kuramoto formula will drift');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`  Swarm coherence prune: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
