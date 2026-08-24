'use strict';

// queensync-dashboard.test.js — QueenSync lifecycle events must reach the
// dashboard, live and on reload (#135).
//
// Two independent gaps, which is why both halves are asserted here:
//
//  1. `server/nats-client.js` broadcast five websocket types — queen_join,
//     queen_leave, queen_dream_start, queen_dream_end, queen_memory_shared —
//     and `workspace/index.html` handled none of them. Nothing appeared in the
//     activity feed until a reload.
//
//  2. `queen.event.memory.shared` was the only queen.event.* handler that
//     broadcast without ALSO storing, so it never entered /api/swarm history.
//     Combined with the dashboard calling loadSwarmData() once on
//     DOMContentLoaded, a memory share was invisible even after a reload —
//     permanently.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { NATSClient } = require('../server/nats-client');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}

const QUEEN_WS_TYPES = [
  'queen_join',
  'queen_leave',
  'queen_dream_start',
  'queen_dream_end',
  'queen_memory_shared',
];

// ── server: every lifecycle event lands in history ──────────

/** Feed one subject through the client and capture what it broadcast. */
function deliver(subject, data) {
  const sent = [];
  const client = new NATSClient({ broadcast: (m) => sent.push(m) });
  // #468: fixtures ride the canonical envelope, as the real announce_event
  // publisher does (kannaka-memory src/nats.rs applies add_envelope to every
  // queen.event.*). memory_id is required on memory.shared per the contract.
  const enveloped = { schema_version: '1.0', ts: Date.now(), memory_id: 'm-test', ...data };
  client._handleMessage(subject, JSON.stringify(enveloped));
  return { client, sent };
}

run('#135 a shared memory is recorded in swarm history, not just broadcast', () => {
  const { client, sent } = deliver('queen.event.memory.shared', {
    agent_id: 'kannaka-77',
    content: 'a thought worth keeping',
  });

  assert.ok(sent.some((m) => m.type === 'queen_memory_shared'), 'it should still broadcast');
  // The actual bug: nothing survived the broadcast.
  const stored = client.swarmState.agentEvents;
  assert.strictEqual(stored.length, 1,
    'a memory share must enter agentEvents or it is gone from /api/swarm forever');
  assert.strictEqual(stored[0].agent_id, 'kannaka-77');
  assert.strictEqual(stored[0].content, 'a thought worth keeping');
});

run('#135 the shared-memory history is bounded like the other event history', () => {
  const client = new NATSClient({ broadcast: () => {} });
  for (let i = 0; i < 60; i++) {
    client._handleMessage('queen.event.memory.shared',
      JSON.stringify({ schema_version: '1.0', ts: Date.now(), memory_id: 'm-' + i, agent_id: 'a' + i, content: 'm' + i }));
  }
  assert.ok(client.swarmState.agentEvents.length <= 50,
    'unbounded growth would be a leak in a long-running server');
  // Newest-first, same as join/leave.
  assert.strictEqual(client.swarmState.agentEvents[0].agent_id, 'a59');
});

run('#135 lifecycle events carry a display label for the feed', () => {
  // renderActivityFeed() reads `evt.action || evt.type || 'sync'`, so without
  // this every queen event rendered as the word "sync".
  const shared = deliver('queen.event.memory.shared', { agent_id: 'x' });
  assert.strictEqual(shared.client.swarmState.agentEvents[0].action, 'shared a memory');

  const joined = deliver('queen.event.join', { agent_id: 'y', display_name: 'y' });
  assert.strictEqual(joined.client.swarmState.agentEvents[0].action, 'joined the swarm');
});

run('#135 a wire event cannot relabel its own action', () => {
  // `action` is placed after the `...data` spread precisely so an inbound
  // payload cannot claim to be a different kind of event in the feed.
  const { client } = deliver('queen.event.memory.shared', {
    agent_id: 'z',
    action: 'joined the swarm',
  });
  assert.strictEqual(client.swarmState.agentEvents[0].action, 'shared a memory');
});

// ── client: the dashboard actually listens ──────────────────

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'workspace', 'index.html'), 'utf8');
// Strip comment lines so prose describing the fix cannot satisfy its own test.
const CODE = INDEX.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

run('#135 the dashboard handles every QueenSync websocket type', () => {
  for (const t of QUEEN_WS_TYPES) {
    assert.ok(CODE.includes("'" + t + "'"),
      `dashboard has no handler for ${t} — the server broadcasts it to nobody`);
  }
});

run('#135 lifecycle events are routed into the existing feed', () => {
  assert.ok(/queen_join[\s\S]{0,400}addAgentActivity/.test(CODE),
    'join/leave/memory-share should feed the activity list');
  // Dream start/end used to render into the Depths dream timeline. That
  // section was removed from the player, so they land in the same activity
  // feed as the rest of the lifecycle — the invariant is that they reach
  // *some* live surface, not which one.
  assert.ok(/queen_dream_start[\s\S]{0,1500}addAgentActivity/.test(CODE),
    'dream start/end should reach the activity feed');
});

run('#135 the server still broadcasts every type the dashboard now expects', () => {
  // Guards the pairing from the other side: renaming a broadcast type without
  // updating the dashboard would silently reopen this exact bug.
  const NATS_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'nats-client.js'), 'utf8');
  for (const t of QUEEN_WS_TYPES) {
    assert.ok(NATS_SRC.includes("type: '" + t + "'"), `server no longer broadcasts ${t}`);
  }
});

console.log(failed === 0 ? '\nqueensync-dashboard: all passed' : `\nqueensync-dashboard: ${failed} FAILED`);
if (failed > 0) process.exit(1);
