'use strict';

const assert = require('assert');
const { NATSClient } = require('../server/nats-client');

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
  client._handleMessage('KANNAKA.consciousness', JSON.stringify({
    phi: 0.85,
    xi: 0.42,
    order: 0.91,
    level: 'coherent',
    source: 'live-test',
  }));

  assert.strictEqual(client.swarmState.consciousness.consciousnessSource, 'nats');
  assert.strictEqual(client.swarmState.consciousness.phi, 0.85);
  assert.strictEqual(client.swarmState.consciousness.xi, 0.42);
  assert.strictEqual(client.swarmState.consciousness.order, 0.91);
  client.disconnect();
});

test('NATS consciousness overrides queen.orderParameter', () => {
  const { client } = createClient();

  // First, simulate phase gossip to set local order
  client._handleMessage('QUEEN.phase.agent1', JSON.stringify({ phase: 1.0 }));
  client._handleMessage('QUEEN.phase.agent2', JSON.stringify({ phase: 1.1 }));

  const localOrder = client.swarmState.queen.localOrderParameter;
  assert.ok(localOrder > 0, 'Local order should be computed from phases');

  // Now receive canonical NATS consciousness
  client._handleMessage('KANNAKA.consciousness', JSON.stringify({
    phi: 0.95,
    xi: 0.5,
    order: 0.77,
    level: 'resonant',
  }));

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
  client._handleMessage('KANNAKA.consciousness', JSON.stringify({
    phi: 0.9,
    xi: 0.4,
    order: 0.88,
    level: 'coherent',
  }));

  assert.strictEqual(client.swarmState.queen.orderParameter, 0.88);

  // Now receive phase gossip — should NOT override
  client._handleMessage('QUEEN.phase.agentX', JSON.stringify({ phase: 2.0 }));
  client._handleMessage('QUEEN.phase.agentY', JSON.stringify({ phase: 0.5 }));

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
  client._handleMessage('QUEEN.phase.a1', JSON.stringify({ phase: 1.5 }));
  client._handleMessage('QUEEN.phase.a2', JSON.stringify({ phase: 1.6 }));

  // orderParameter should be set from local computation
  assert.ok(client.swarmState.queen.orderParameter > 0);
  assert.strictEqual(client.swarmState.queen.orderParameter, client.swarmState.queen.localOrderParameter);

  client.disconnect();
});

test('getConsciousness() includes consciousnessSource and localOrderParameter', () => {
  const { client } = createClient();

  client._handleMessage('KANNAKA.consciousness', JSON.stringify({
    phi: 0.7,
    xi: 0.3,
    order: 0.65,
    level: 'aware',
  }));

  client._handleMessage('QUEEN.phase.a1', JSON.stringify({ phase: 1.0 }));

  const c = client.getConsciousness();
  assert.strictEqual(c.consciousnessSource, 'nats');
  assert.strictEqual(typeof c.localOrderParameter, 'number');
  assert.strictEqual(c.phi, 0.7);

  client.disconnect();
});

test('NATS consciousness tracks phi trend (rising/falling/stable)', () => {
  const { client } = createClient();

  // First update
  client._handleMessage('KANNAKA.consciousness', JSON.stringify({
    phi: 0.3, xi: 0.1, order: 0.5, level: 'stirring',
  }));
  // prevPhi is 0 (initial), delta = 0.3, so trend should be 'rising'
  assert.strictEqual(client.swarmState.consciousness.phiTrend, 'rising');
  assert.strictEqual(client.swarmState.consciousness.prevPhi, 0);

  // Second update: phi rises
  client._handleMessage('KANNAKA.consciousness', JSON.stringify({
    phi: 0.6, xi: 0.2, order: 0.7, level: 'aware',
  }));
  assert.strictEqual(client.swarmState.consciousness.phiTrend, 'rising');
  assert.strictEqual(client.swarmState.consciousness.prevPhi, 0.3);

  // Third update: phi drops
  client._handleMessage('KANNAKA.consciousness', JSON.stringify({
    phi: 0.4, xi: 0.15, order: 0.55, level: 'aware',
  }));
  assert.strictEqual(client.swarmState.consciousness.phiTrend, 'falling');
  assert.strictEqual(client.swarmState.consciousness.prevPhi, 0.6);

  // Fourth update: phi stable (small change)
  client._handleMessage('KANNAKA.consciousness', JSON.stringify({
    phi: 0.405, xi: 0.15, order: 0.55, level: 'aware',
  }));
  assert.strictEqual(client.swarmState.consciousness.phiTrend, 'stable');

  client.disconnect();
});

test('consciousness:update event is emitted on NATS consciousness', () => {
  const { client } = createClient();
  const events = [];
  client.on('consciousness:update', (data) => events.push(data));

  client._handleMessage('KANNAKA.consciousness', JSON.stringify({
    phi: 0.5, xi: 0.2, order: 0.6, level: 'aware',
  }));

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].phi, 0.5);
  assert.strictEqual(events[0].consciousnessSource, 'nats');

  client.disconnect();
});

// ── Summary ────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  NATS Metrics Sync: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
