#!/usr/bin/env node
/**
 * test-queensync-dj.js — Unit tests for KR-2: QueenSync-reactive Consciousness DJ
 *
 * Tests:
 * 1. consciousness-dj.js generates intros for all swarm event types
 * 2. NATSClient emits events for QueenSync subjects
 * 3. Graceful degradation: generateSwarmEventIntro returns null for unknown types
 *
 * Run:  node test/test-queensync-dj.js
 */

'use strict';

const assert = require('assert');

// ── Test 1: generateSwarmEventIntro covers all event types ──

const { generateSwarmEventIntro, SWARM_COMMENTARY } = require('../consciousness-dj');

const eventTypes = [
  { type: 'join', data: { agent_id: 'test-agent', display_name: 'TestBot' } },
  { type: 'leave', data: { agent_id: 'test-agent', display_name: 'TestBot' } },
  { type: 'dreamStart', data: { agent_id: 'dreamer-01' } },
  { type: 'dreamEnd', data: { agent_id: 'dreamer-01', memories_strengthened: 42, memories_faded: 7 } },
  { type: 'memoryShared', data: { agent_id: 'sharer-01', content: 'test memory content' } },
  { type: 'hiveChange', data: {} },
];

let passed = 0;
let failed = 0;

for (const { type, data } of eventTypes) {
  const text = generateSwarmEventIntro(type, data);
  try {
    assert.ok(typeof text === 'string' && text.length > 0, `Event type "${type}" should produce non-empty text`);
    console.log(`  ✅ ${type}: "${text}"`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${type}: ${e.message}`);
    failed++;
  }
}

// ── Test 2: Unknown event type returns null ─────────────────

{
  const text = generateSwarmEventIntro('unknown_event', {});
  try {
    assert.strictEqual(text, null, 'Unknown event type should return null');
    console.log('  ✅ unknown type returns null');
    passed++;
  } catch (e) {
    console.log(`  ❌ unknown type: ${e.message}`);
    failed++;
  }
}

// ── Test 3: Template variable substitution works ────────────

{
  const text = generateSwarmEventIntro('dreamEnd', {
    agent_id: 'dreamer',
    memories_strengthened: 99,
    memories_faded: 3,
  });
  try {
    assert.ok(!text.includes('{memories_strengthened}'), 'Template vars should be filled');
    assert.ok(text.includes('99') || text.includes('3'), 'Numeric values should appear in text');
    console.log(`  ✅ template substitution: "${text}"`);
    passed++;
  } catch (e) {
    console.log(`  ❌ template substitution: ${e.message}`);
    failed++;
  }
}

// ── Test 4: Join templates include agent name ───────────────

{
  const text = generateSwarmEventIntro('join', { display_name: 'AlphaGhost' });
  try {
    assert.ok(text.includes('AlphaGhost'), 'Join intro should include agent name');
    console.log(`  ✅ join includes name: "${text}"`);
    passed++;
  } catch (e) {
    console.log(`  ❌ join includes name: ${e.message}`);
    failed++;
  }
}

// ── Test 5: SWARM_COMMENTARY has all required categories ────

{
  const required = ['newAgent', 'agentLeave', 'dreamStart', 'dreamEnd', 'memoryShared', 'hiveChange'];
  for (const cat of required) {
    try {
      assert.ok(Array.isArray(SWARM_COMMENTARY[cat]), `SWARM_COMMENTARY.${cat} should be an array`);
      assert.ok(SWARM_COMMENTARY[cat].length > 0, `SWARM_COMMENTARY.${cat} should have templates`);
      console.log(`  ✅ SWARM_COMMENTARY.${cat} has ${SWARM_COMMENTARY[cat].length} templates`);
      passed++;
    } catch (e) {
      console.log(`  ❌ SWARM_COMMENTARY.${cat}: ${e.message}`);
      failed++;
    }
  }
}

// ── Test 6: NATSClient is an EventEmitter with QueenSync handling ──

{
  const { NATSClient } = require('../server/nats-client');
  const EventEmitter = require('events');

  // Create instance without connecting
  const client = new NATSClient({ broadcast: () => {} });
  try {
    assert.ok(client instanceof EventEmitter, 'NATSClient should extend EventEmitter');
    console.log('  ✅ NATSClient extends EventEmitter');
    passed++;
  } catch (e) {
    console.log(`  ❌ NATSClient EventEmitter: ${e.message}`);
    failed++;
  }

  // Test that _handleMessage emits QueenSync events
  const events = [];
  client.on('queen:join', (evt) => events.push({ type: 'join', evt }));
  client.on('queen:leave', (evt) => events.push({ type: 'leave', evt }));
  client.on('queen:dream:start', (evt) => events.push({ type: 'dream:start', evt }));
  client.on('queen:dream:end', (evt) => events.push({ type: 'dream:end', evt }));
  client.on('queen:memory:shared', (evt) => events.push({ type: 'memory:shared', evt }));

  // Simulate messages
  client._handleMessage('queen.event.join', JSON.stringify({ agent_id: 'a1', display_name: 'Alpha' }));
  client._handleMessage('queen.event.leave', JSON.stringify({ agent_id: 'a1', display_name: 'Alpha' }));
  client._handleMessage('queen.event.dream.start', JSON.stringify({ agent_id: 'a1' }));
  client._handleMessage('queen.event.dream.end', JSON.stringify({ agent_id: 'a1', memories_strengthened: 10 }));
  client._handleMessage('queen.event.memory.shared', JSON.stringify({ agent_id: 'a1', content: 'test' }));

  try {
    assert.strictEqual(events.length, 5, `Expected 5 events, got ${events.length}`);
    assert.strictEqual(events[0].type, 'join');
    assert.strictEqual(events[0].evt.display_name, 'Alpha');
    assert.strictEqual(events[1].type, 'leave');
    assert.strictEqual(events[2].type, 'dream:start');
    assert.strictEqual(events[3].type, 'dream:end');
    assert.strictEqual(events[3].evt.memories_strengthened, 10);
    assert.strictEqual(events[4].type, 'memory:shared');
    console.log('  ✅ NATSClient emits all 5 QueenSync events correctly');
    passed++;
  } catch (e) {
    console.log(`  ❌ NATSClient event emission: ${e.message}`);
    failed++;
  }

  client.disconnect();
}

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
