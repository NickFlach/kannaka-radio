/**
 * queen-leave-presence.test.js — QueenSync lifecycle events must move the
 * roster in both directions: a graceful leave clears presence (#134) and a
 * join establishes it (#223).
 *
 * The `queen.event.leave` handler recorded the event and broadcast it, but
 * never removed the agent from swarmState. So for up to five minutes after a
 * clean shutdown — until the stale prune noticed it had gone quiet —
 * /api/swarm still counted the departed agent and its phase still contributed
 * to swarm coherence. An agent that TOLD us it was leaving should not have to
 * be timed out.
 *
 * `queen.event.join` had the mirror-image gap: it only appended to the event
 * feed, so between a join and the first QUEEN.phase.* heartbeat /api/swarm
 * contradicted itself — announcing that an agent had joined while omitting it
 * from `agents` and leaving agentCount unchanged.
 *
 * Drives the real _handleMessage() dispatch. No sockets.
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

function clientWithAgents(agents) {
  const c = new NATSClient({ broadcast: () => {} });
  c.swarmState.agents = agents;
  c.swarmState.queen.agentCount = Object.keys(agents).length;
  c._recomputeCoherence();
  return c;
}

const leave = (c, id) =>
  c._handleMessage('queen.event.leave', JSON.stringify({ agent_id: id, display_name: id }));

const join = (c, id, extra = {}) =>
  c._handleMessage('queen.event.join', JSON.stringify({ agent_id: id, display_name: id, ...extra }));

const phase = (c, id, p) =>
  c._handleMessage(`QUEEN.phase.${id}`, JSON.stringify({ agent_id: id, phase: p }));

console.log('\nqueen-leave-presence.test.js');

test('#134 a graceful leave removes the agent immediately', () => {
  const now = Date.now();
  const c = clientWithAgents({
    stays: { phase: 0.5, lastSeen: now },
    goes: { phase: 0.5, lastSeen: now },
  });
  assert.strictEqual(c.swarmState.queen.agentCount, 2);

  leave(c, 'goes');

  assert.ok(!('goes' in c.swarmState.agents), 'departed agent must be gone from swarmState');
  assert.ok('stays' in c.swarmState.agents, 'the others must be untouched');
  assert.strictEqual(c.swarmState.queen.agentCount, 1, 'agentCount must follow');
});

test('#134 the departed agent stops contributing to coherence', () => {
  const now = Date.now();
  // Anti-phase pair cancels to ~0. Once one leaves, the survivor reads ~1.
  const c = clientWithAgents({
    a: { phase: 0, lastSeen: now },
    b: { phase: Math.PI, lastSeen: now },
  });
  assert.ok(c.swarmState.queen.localOrderParameter < 0.01,
    `anti-phase pair should cancel, got ${c.swarmState.queen.localOrderParameter}`);

  leave(c, 'b');

  assert.ok(c.swarmState.queen.localOrderParameter > 0.99,
    `coherence must be recomputed without the departed agent, got ${c.swarmState.queen.localOrderParameter}`);
});

test('#134 the last agent leaving empties the swarm', () => {
  const c = clientWithAgents({ only: { phase: 1.0, lastSeen: Date.now() } });
  leave(c, 'only');
  assert.strictEqual(c.swarmState.queen.agentCount, 0);
  assert.strictEqual(c.swarmState.queen.localOrderParameter, 0,
    'an empty swarm must not retain the departed coherence');
});

test('#134 a clean leave re-arms the join announcement', () => {
  const now = Date.now();
  const c = clientWithAgents({ x: { phase: 0, lastSeen: now } });
  c.swarmState.joinAnnouncedAt.x = now; // it was announced when it joined
  leave(c, 'x');
  assert.strictEqual(c.swarmState.joinAnnouncedAt.x, undefined,
    'a rejoin after a clean leave is real news, not a duplicate within the 6h dedup window');
});

test('#134 leaving is still recorded and broadcast', () => {
  const seen = [];
  const c = new NATSClient({ broadcast: (m) => seen.push(m) });
  c.swarmState.agents = { z: { phase: 0, lastSeen: Date.now() } };
  let emitted = null;
  c.on('queen:leave', (e) => { emitted = e; });

  leave(c, 'z');

  assert.ok(seen.some((m) => m && m.type === 'queen_leave'), 'WS broadcast must still fire');
  assert.ok(emitted && emitted.agent_id === 'z', 'queen:leave must still be emitted');
  assert.ok(c.swarmState.agentEvents.some((e) => e.agent_id === 'z'),
    'the event must still land in the agentEvents feed');
});

test('#134 a leave for an unknown agent is harmless', () => {
  const c = clientWithAgents({ live: { phase: 0, lastSeen: Date.now() } });
  leave(c, 'never-seen');
  assert.strictEqual(c.swarmState.queen.agentCount, 1, 'must not disturb existing presence');
  assert.ok('live' in c.swarmState.agents);
});

test('#223 a join puts the agent on the roster before any phase heartbeat', () => {
  const c = new NATSClient({ broadcast: () => {} });
  join(c, 'late-phase');
  assert.ok('late-phase' in c.swarmState.agents,
    '/api/swarm must not announce a join while omitting the agent from `agents`');
  assert.strictEqual(c.swarmState.queen.agentCount, 1, 'agentCount must follow');
  assert.strictEqual(c.swarmState.agents['late-phase'].displayName, 'late-phase');
  assert.ok(c.swarmState.agents['late-phase'].lastSeen > 0, 'lastSeen must be set');
});

test('#223 join and leave agree — the roster returns to empty', () => {
  const c = new NATSClient({ broadcast: () => {} });
  join(c, 'ephemeral');
  assert.strictEqual(c.swarmState.queen.agentCount, 1);
  leave(c, 'ephemeral');
  assert.strictEqual(c.swarmState.queen.agentCount, 0, 'the lifecycle must round-trip');
  assert.ok(!('ephemeral' in c.swarmState.agents));
});

test('#223 a join does not clobber a phase already on file', () => {
  const c = new NATSClient({ broadcast: () => {} });
  phase(c, 'chatty', 1.25);
  join(c, 'chatty');
  assert.strictEqual(c.swarmState.agents.chatty.phase, 1.25,
    'a re-announced join must not erase live gossip');
});

test('#223 a re-join still refreshes presence even when the announcement is deduped', () => {
  // The 6h dedup gate suppresses the repeated *announcement* from the witness
  // loop. Presence is a different concern and must still refresh.
  const c = new NATSClient({ broadcast: () => {} });
  join(c, 'witness');
  const firstSeen = c.swarmState.agents.witness.lastSeen;
  c.swarmState.agents.witness.lastSeen = firstSeen - 60000; // pretend time passed
  const eventsBefore = c.swarmState.agentEvents.length;

  join(c, 'witness');

  assert.strictEqual(c.swarmState.agentEvents.length, eventsBefore,
    'the repeat announcement must still be deduped');
  assert.ok(c.swarmState.agents.witness.lastSeen > firstSeen - 60000,
    'presence must refresh even when the announcement is suppressed');
});

test('#223 a join with no agent_id does not mint a phantom "unknown" peer', () => {
  const c = new NATSClient({ broadcast: () => {} });
  c._handleMessage('queen.event.join', JSON.stringify({ display_name: 'Nameless' }));
  assert.strictEqual(c.swarmState.queen.agentCount, 0,
    'a malformed join must not create a peer nobody can address');
  assert.ok(!('unknown' in c.swarmState.agents));
});

test('#223 a phase-less joiner does not drag swarm coherence toward zero', () => {
  const c = new NATSClient({ broadcast: () => {} });
  phase(c, 'a', Math.PI);
  phase(c, 'b', Math.PI);
  assert.ok(c.swarmState.queen.localOrderParameter > 0.99, 'the pair is phase-locked');

  join(c, 'quiet'); // on the roster, no phase yet

  assert.strictEqual(c.swarmState.queen.agentCount, 3);
  assert.ok(c.swarmState.queen.localOrderParameter > 0.99,
    `a joiner that has not gossiped is not a reading of phase 0, got ${c.swarmState.queen.localOrderParameter}`);
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`  Queen leave presence: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
