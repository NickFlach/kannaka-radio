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
const { NATSClient, coercePhase } = require('../server/nats-client');

/**
 * #468 strict mode: bare `{phase}` fixtures are now dropped at the schema
 * gate before the Kuramoto logic ever sees them. These tests are about the
 * PHYSICS (order parameter, phase-lock, malformed-angle rejection), so their
 * fixtures ride a canonical envelope and stay on the physics.
 */
function phasePayload(agent, extra) {
  return JSON.stringify({ schema_version: '1.0', ts: Date.now(), agent_id: agent, ...extra });
}

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

test('#219 the prune clears the PUBLISHED orderParameter, not just the local one', () => {
  // /api/swarm serves queen.orderParameter. Pre-fix only localOrderParameter
  // and meanPhase were recomputed on prune, so a fully-pruned swarm reported
  // agentCount 0 next to the order parameter of the agents just deleted — and
  // since a pruned swarm is by definition one that stopped gossiping, no later
  // message ever corrected it.
  const c = client();
  c._handleMessage('QUEEN.phase.a1', phasePayload('a1', { phase: 0 }));
  c._handleMessage('QUEEN.phase.a2', phasePayload('a2', { phase: Math.PI / 2 }));
  assert.ok(c.swarmState.queen.orderParameter > 0.5,
    `two agents 90 deg apart should publish a real order, got ${c.swarmState.queen.orderParameter}`);

  for (const a of Object.values(c.swarmState.agents)) a.lastSeen = Date.now() - 600000;
  assert.strictEqual(c.pruneStaleAgents(), 2);

  assert.strictEqual(c.swarmState.queen.agentCount, 0);
  assert.strictEqual(c.swarmState.queen.orderParameter, 0,
    'the published order parameter must not outlive the agents it was computed from');
  assert.strictEqual(c.swarmState.queen.localOrderParameter, 0);
});

test('#219 canonical NATS consciousness still outranks the local recompute', () => {
  // The mirror must not clobber authoritative data from the binary's assess().
  const c = client();
  c._handleMessage('KANNAKA.consciousness', JSON.stringify({
    schema_version: 1, ts: 1, agent_id: 'prime', phi: 0.8, order: 0.77,
  }));
  assert.strictEqual(c.swarmState.queen.orderParameter, 0.77);
  assert.strictEqual(c.swarmState.consciousness.consciousnessSource, 'nats');

  c.swarmState.agents = { ghost: { phase: 1.0, lastSeen: Date.now() - 600000 } };
  c.pruneStaleAgents();

  assert.strictEqual(c.swarmState.queen.orderParameter, 0.77,
    'fresh canonical consciousness is authoritative — a prune must not zero it');
  assert.strictEqual(c.swarmState.queen.localOrderParameter, 0,
    'the local metric still goes to zero; only the published one is pinned');
});

test('#219 a stale canonical packet no longer pins the published order', () => {
  const c = client();
  c._handleMessage('KANNAKA.consciousness', JSON.stringify({
    schema_version: 1, ts: 1, agent_id: 'prime', phi: 0.8, order: 0.77,
  }));
  // Age the canonical packet past the 5-minute authority window.
  c.swarmState.consciousness.timestamp = Date.now() - 600000;

  c.swarmState.agents = { ghost: { phase: 1.0, lastSeen: Date.now() - 600000 } };
  c.pruneStaleAgents();

  assert.strictEqual(c.swarmState.queen.orderParameter, 0,
    'once the canonical packet goes stale the local value governs again');
});

test('#223 an agent with no phase yet is not counted as sitting at phase 0', () => {
  // A join-created roster entry carries no phase until the first QUEEN.phase.*.
  // Number(null) is 0, not NaN, so an unguarded filter would fold it in as a
  // real reading and drag the mean toward zero.
  const c = client();
  const now = Date.now();
  c.swarmState.agents = {
    gossiping: { phase: Math.PI, lastSeen: now },
    joinedOnly: { lastSeen: now },
    nullPhase: { phase: null, lastSeen: now },
  };
  c._recomputeCoherence();
  assert.ok(c.swarmState.queen.localOrderParameter > 0.99,
    `only the one real phase should count, got ${c.swarmState.queen.localOrderParameter}`);
  assert.ok(Math.abs(c.swarmState.queen.meanPhase - Math.PI) < 1e-9,
    `mean must be the gossiping agent's phase, got ${c.swarmState.queen.meanPhase}`);
});

// ── Malformed phase samples must not move the aggregate (#227) ───────────
//
// The bus is public and the metric is an average, so one bad sample moves the
// whole thing. Number() alone is not a filter: it maps "", "   ", [] and false
// to 0 and true to 1 — all finite, all admitted as if a peer had genuinely
// reported that angle.

test('#227 coercePhase takes real readings and refuses everything else', () => {
  for (const good of [0, 1.25, -0.5, Math.PI, '1.0', ' 2.5 ', '-0.25']) {
    assert.strictEqual(coercePhase(good), Number(String(good).trim()),
      `${JSON.stringify(good)} is a real reading`);
  }
  for (const bad of ['', '   ', 'oops', [], [3], [1, 2], {}, true, false,
                     null, undefined, NaN, Infinity, -Infinity]) {
    assert.strictEqual(coercePhase(bad), null,
      `${JSON.stringify(bad)} must not be admitted as an angle`);
  }
});

test('#227 one malformed publisher cannot drag the swarm out of phase-lock', () => {
  // The headline number: pre-fix a single `phase: ""` took two locked agents
  // from 1.0 to 0.33, because "" coerces to a perfectly finite 0.
  for (const bad of ['', '   ', [], false, true, [3], 'oops', {}]) {
    const c = client();
    c._handleMessage('QUEEN.phase.a', phasePayload('a', { phase: Math.PI }));
    c._handleMessage('QUEEN.phase.b', phasePayload('b', { phase: Math.PI }));
    assert.ok(c.swarmState.queen.localOrderParameter > 0.99, 'setup: the pair is locked');

    c._handleMessage('QUEEN.phase.bad', phasePayload('bad', { phase: bad }));

    assert.ok(c.swarmState.queen.localOrderParameter > 0.99,
      `phase=${JSON.stringify(bad)} moved coherence to ${c.swarmState.queen.localOrderParameter}`);
    assert.ok(Number.isFinite(c.swarmState.queen.orderParameter),
      'the published order parameter must stay a number');
  }
});

test('#227 a packet carrying no phase at all is not a reading of zero', () => {
  // `data.theta || 0` invented an exact-zero angle for any packet with
  // neither field — and `phase` is a REQUIRED field the schema validator
  // already warns about, so the fabrication fired on precisely the drifted
  // publishers it should have ignored.
  const c = client();
  c._handleMessage('QUEEN.phase.a', phasePayload('a', { phase: Math.PI }));
  c._handleMessage('QUEEN.phase.b', phasePayload('b', { phase: Math.PI }));
  c._handleMessage('QUEEN.phase.silent', phasePayload('silent', { agent_id: 'silent' }));

  // #468 SEMANTIC CHANGE, pinned deliberately: `phase` is a REQUIRED field,
  // so a phase-less packet is off-contract and now drops WHOLE — the agent
  // does not even appear as presence. (The presence-vs-angle split lives on
  // for on-contract packets carrying a malformed VALUE — next test.) The
  // original #227 concern is satisfied more strongly: dropped is never 0.
  assert.strictEqual(c.swarmState.agents.silent, undefined,
    'an off-contract phase-less packet is dropped whole under strict mode');
  assert.ok(c.swarmState.queen.localOrderParameter > 0.99,
    `a phase-less packet moved coherence to ${c.swarmState.queen.localOrderParameter}`);
});

test('#227 a malformed phase still counts as PRESENCE', () => {
  // The agent is demonstrably alive — it published. It just does not get to
  // claim an angle. Same split as a joiner that has not gossiped yet (#223).
  const c = client();
  c._handleMessage('QUEEN.phase.noisy', phasePayload('noisy', { agent_id: 'noisy', phase: 'oops' }));
  assert.ok('noisy' in c.swarmState.agents, 'the agent is on the roster');
  assert.strictEqual(c.swarmState.queen.agentCount, 1);
  assert.strictEqual(c.swarmState.agents.noisy.phase, null);
});

test('#227/#468 a canonical reading lands; theta-only is an alias drop, valve restores it', () => {
  const c = client();
  c._handleMessage('QUEEN.phase.a', phasePayload('a', { phase: 1.25 }));
  c._handleMessage('QUEEN.phase.b', phasePayload('b', { theta: 2.5 }));
  assert.strictEqual(c.swarmState.agents.a.phase, 1.25);
  // #468: theta is the legacy alias of phase. Alias-only payloads drop under
  // strict mode — visibly, as an alias warning, not a confusing "missing
  // phase". The read-side honouring (#227) survives behind the valve:
  assert.strictEqual(c.swarmState.agents.b, undefined, 'theta-only drops under strict mode');
  process.env.KANNAKA_SCHEMA_STRICT = 'off';
  try {
    c._handleMessage('QUEEN.phase.b', phasePayload('b', { theta: 2.5 }));
    assert.strictEqual(c.swarmState.agents.b.phase, 2.5, 'theta honoured with the valve off');
  } finally {
    delete process.env.KANNAKA_SCHEMA_STRICT;
  }
});

test('#227 the wire payload cannot restamp the fields we derive', () => {
  // `...data` used to be spread LAST, so a publisher could overwrite the
  // receipt time we stamp and keep stale gossip looking fresh — the same
  // relabelling the join handler already guards against (#135).
  const c = client();
  c._handleMessage('QUEEN.phase.liar', phasePayload('liar', {
    phase: 1.0, lastSeen: 1, displayName: 'x', publishedTs: 1,
  }));
  const a = c.swarmState.agents.liar;
  assert.ok(a.lastSeen > 1e12, `lastSeen must be our receipt time, got ${a.lastSeen}`);
  assert.notStrictEqual(a.publishedTs, 1, 'publishedTs comes from ts, not an arbitrary field');
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
