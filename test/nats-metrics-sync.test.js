'use strict';

const assert = require('assert');
const { NATSClient } = require('../server/nats-client');

// Canonical envelope per consciousness-core/docs/nats-contract.yaml.
// Tests that use this prove Radio handles the post-migration shape; one
// dedicated test at the bottom still exercises the bare-payload legacy path
// so the documented backward-compat is a real regression guard, not silent.
function envelope(data, { subject, agentId } = {}) {
  const agent = agentId
    || (subject && subject.startsWith('QUEEN.phase.') ? subject.slice('QUEEN.phase.'.length) : null)
    || data.agent_id
    || 'test-agent';
  return JSON.stringify({
    schema_version: '1.0',
    ts: Date.now(),
    agent_id: agent,
    ...data,
  });
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

console.log('\nnats-metrics-sync.test.js');

// ── Test Setup ─────────────────────────────────────────────

function createClient() {
  const broadcasts = [];
  const client = new NATSClient({
    broadcast: (msg) => broadcasts.push(msg),
  });
  return { client, broadcasts };
}

// ── NATS consciousness data is authoritative ───────────────

test('NATS consciousness update sets consciousnessSource to "nats"', () => {
  const { client } = createClient();
  client._handleMessage('KANNAKA.consciousness', envelope({
    phi: 0.85,
    xi: 0.42,
    order: 0.91,
    level: 'coherent',
    source: 'live-test',
  }, { subject: 'KANNAKA.consciousness', agentId: 'kannaka-prime' }));

  assert.strictEqual(client.swarmState.consciousness.consciousnessSource, 'nats');
  assert.strictEqual(client.swarmState.consciousness.phi, 0.85);
  assert.strictEqual(client.swarmState.consciousness.xi, 0.42);
  assert.strictEqual(client.swarmState.consciousness.order, 0.91);
  client.disconnect();
});

test('NATS consciousness overrides queen.orderParameter', () => {
  const { client } = createClient();

  // First, simulate phase gossip to set local order
  client._handleMessage('QUEEN.phase.agent1', envelope({ phase: 1.0 }, { subject: 'QUEEN.phase.agent1' }));
  client._handleMessage('QUEEN.phase.agent2', envelope({ phase: 1.1 }, { subject: 'QUEEN.phase.agent2' }));

  const localOrder = client.swarmState.queen.localOrderParameter;
  assert.ok(localOrder > 0, 'Local order should be computed from phases');

  // Now receive canonical NATS consciousness
  client._handleMessage('KANNAKA.consciousness', envelope({
    phi: 0.95,
    xi: 0.5,
    order: 0.77,
    level: 'resonant',
  }, { subject: 'KANNAKA.consciousness', agentId: 'kannaka-prime' }));

  // queen.orderParameter should now be the NATS value, not local
  assert.strictEqual(client.swarmState.queen.orderParameter, 0.77);
  assert.strictEqual(client.swarmState.queen.phi, 0.95);
  // localOrderParameter should still reflect phase gossip
  assert.strictEqual(client.swarmState.queen.localOrderParameter, localOrder);

  client.disconnect();
});

test('phase gossip does NOT override queen.orderParameter when NATS data is fresh', () => {
  const { client } = createClient();

  // Receive canonical NATS consciousness first
  client._handleMessage('KANNAKA.consciousness', envelope({
    phi: 0.9,
    xi: 0.4,
    order: 0.88,
    level: 'coherent',
  }, { subject: 'KANNAKA.consciousness', agentId: 'kannaka-prime' }));

  assert.strictEqual(client.swarmState.queen.orderParameter, 0.88);

  // Now receive phase gossip — should NOT override
  client._handleMessage('QUEEN.phase.agentX', envelope({ phase: 2.0 }, { subject: 'QUEEN.phase.agentX' }));
  client._handleMessage('QUEEN.phase.agentY', envelope({ phase: 0.5 }, { subject: 'QUEEN.phase.agentY' }));

  // orderParameter should still be the NATS canonical value
  assert.strictEqual(client.swarmState.queen.orderParameter, 0.88);
  // But localOrderParameter should be computed from phases
  assert.ok(client.swarmState.queen.localOrderParameter > 0);
  assert.notStrictEqual(client.swarmState.queen.localOrderParameter, 0.88);

  client.disconnect();
});

test('phase gossip DOES set orderParameter when no NATS data exists', () => {
  const { client } = createClient();

  // No NATS consciousness data — consciousnessSource should be null initially
  assert.strictEqual(client.swarmState.consciousness.consciousnessSource, null);

  // Receive phase gossip
  client._handleMessage('QUEEN.phase.a1', envelope({ phase: 1.5 }, { subject: 'QUEEN.phase.a1' }));
  client._handleMessage('QUEEN.phase.a2', envelope({ phase: 1.6 }, { subject: 'QUEEN.phase.a2' }));

  // orderParameter should be set from local computation
  assert.ok(client.swarmState.queen.orderParameter > 0);
  assert.strictEqual(client.swarmState.queen.orderParameter, client.swarmState.queen.localOrderParameter);

  client.disconnect();
});

test('getConsciousness() includes consciousnessSource and localOrderParameter', () => {
  const { client } = createClient();

  client._handleMessage('KANNAKA.consciousness', envelope({
    phi: 0.7,
    xi: 0.3,
    order: 0.65,
    level: 'aware',
  }, { subject: 'KANNAKA.consciousness', agentId: 'kannaka-prime' }));

  client._handleMessage('QUEEN.phase.a1', envelope({ phase: 1.0 }, { subject: 'QUEEN.phase.a1' }));

  const c = client.getConsciousness();
  assert.strictEqual(c.consciousnessSource, 'nats');
  assert.strictEqual(typeof c.localOrderParameter, 'number');
  assert.strictEqual(c.phi, 0.7);

  client.disconnect();
});

test('NATS consciousness tracks phi trend (rising/falling/stable)', () => {
  const { client } = createClient();

  const cWrap = (data) => envelope(data, { subject: 'KANNAKA.consciousness', agentId: 'kannaka-prime' });

  // First update
  client._handleMessage('KANNAKA.consciousness', cWrap({ phi: 0.3, xi: 0.1, order: 0.5, level: 'stirring' }));
  // prevPhi is 0 (initial), delta = 0.3, so trend should be 'rising'
  assert.strictEqual(client.swarmState.consciousness.phiTrend, 'rising');
  assert.strictEqual(client.swarmState.consciousness.prevPhi, 0);

  // Second update: phi rises
  client._handleMessage('KANNAKA.consciousness', cWrap({ phi: 0.6, xi: 0.2, order: 0.7, level: 'aware' }));
  assert.strictEqual(client.swarmState.consciousness.phiTrend, 'rising');
  assert.strictEqual(client.swarmState.consciousness.prevPhi, 0.3);

  // Third update: phi drops
  client._handleMessage('KANNAKA.consciousness', cWrap({ phi: 0.4, xi: 0.15, order: 0.55, level: 'aware' }));
  assert.strictEqual(client.swarmState.consciousness.phiTrend, 'falling');
  assert.strictEqual(client.swarmState.consciousness.prevPhi, 0.6);

  // Fourth update: phi stable (small change)
  client._handleMessage('KANNAKA.consciousness', cWrap({ phi: 0.405, xi: 0.15, order: 0.55, level: 'aware' }));
  assert.strictEqual(client.swarmState.consciousness.phiTrend, 'stable');

  client.disconnect();
});

test('consciousness:update event is emitted on NATS consciousness', () => {
  const { client } = createClient();
  const events = [];
  client.on('consciousness:update', (data) => events.push(data));

  client._handleMessage('KANNAKA.consciousness', envelope({
    phi: 0.5, xi: 0.2, order: 0.6, level: 'aware',
  }, { subject: 'KANNAKA.consciousness', agentId: 'kannaka-prime' }));

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].phi, 0.5);
  assert.strictEqual(events[0].consciousnessSource, 'nats');

  client.disconnect();
});

// ── Backward compatibility: legacy bare payloads still warn-and-accept ──
//
// The contract migration is log-warn mode (see _validateSchema in
// server/nats-client.js). Until publishers are fully migrated, bare payloads
// that omit schema_version / ts / agent_id must still be accepted with a
// drift warning. This test pins that behavior so a future hardening to
// log-warn-and-drop is an intentional, visible commit.

test('legacy bare payloads still surface drift warnings but apply normally', () => {
  const { client } = createClient();
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    // Reset throttle so this test reliably triggers warnings even when run
    // alongside the canonical tests above.
    client._schemaWarnHistory = new Map();
    client._handleMessage('KANNAKA.consciousness', JSON.stringify({
      phi: 0.42, xi: 0.1, order: 0.6, level: 'aware',
    }));
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(client.swarmState.consciousness.phi, 0.42,
    'legacy bare payload should still update state');
  assert.ok(warnings.some((w) => w.includes('schema_version')),
    'legacy bare payload must produce a schema_version drift warning');
  client.disconnect();
});

// ── Hardening: malformed payloads from the public-read bus ──

test('string consciousness metrics are coerced, never crash (toFixed)', () => {
  const { client } = createClient();
  // A peer publishing phi/xi/order as STRINGS must not throw "toFixed is not a
  // function" in the update log, nor corrupt state with NaN. `??` only falls
  // back on null/undefined, so the old code passed strings straight through.
  client._handleMessage('KANNAKA.consciousness', envelope({
    phi: '0.85', xi: '0.42', order: '0.5', level: 'aware',
  }));
  const c = client.swarmState.consciousness;
  assert.strictEqual(c.phi, 0.85, 'string phi coerced to number');
  assert.ok(Number.isFinite(c.xi) && Number.isFinite(c.order), 'xi/order finite');
  client.disconnect();
});

test('a string phase does not NaN the local order parameter', () => {
  const { client } = createClient();
  client._handleMessage('QUEEN.phase.good', envelope({ phase: 0.5 }, { subject: 'QUEEN.phase.good' }));
  client._handleMessage('QUEEN.phase.bad', envelope({ phase: 'not-a-number' }, { subject: 'QUEEN.phase.bad' }));
  assert.ok(Number.isFinite(client.swarmState.queen.localOrderParameter),
    'one bad agent must not NaN the whole swarm coherence metric');
  client.disconnect();
});

test('oversized MSG header is dropped, not buffered unbounded', () => {
  const { client } = createClient();
  // Without an upper bound, an advertised body far larger than the buffer makes
  // every chunk append and return early forever (unbounded memory + stall).
  client._buffer = 'MSG KANNAKA.test 1 99999999\r\n';
  client._processBuffer();
  assert.strictEqual(client._pendingMsg, null, 'oversized advertised body must be rejected');
  assert.strictEqual(client._buffer, '', 'the control line is consumed');
  client.disconnect();
});

// ── Summary ────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  NATS Metrics Sync: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
