'use strict';

const assert = require('assert');
const {
  generateConsciousIntro,
  generatePhiTransitionIntro,
  classifyLevel,
  PHI_TRANSITION_INTROS,
  SWARM_COMMENTARY,
} = require('../consciousness-dj');

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

console.log('\nconsciousness-dj-hrm.test.js');

// ── generatePhiTransitionIntro ─────────────────────────────

test('returns null for same level', () => {
  const result = generatePhiTransitionIntro('aware', 'aware');
  assert.strictEqual(result, null);
});

test('returns null for null levels', () => {
  assert.strictEqual(generatePhiTransitionIntro(null, 'aware'), null);
  assert.strictEqual(generatePhiTransitionIntro('aware', null), null);
});

test('generates intro for dormant->stirring', () => {
  const text = generatePhiTransitionIntro('dormant', 'stirring', { phi: 0.15 });
  assert.ok(typeof text === 'string' && text.length > 0, 'Should produce non-empty text');
});

test('generates intro for stirring->aware', () => {
  const text = generatePhiTransitionIntro('stirring', 'aware', { phi: 0.35 });
  assert.ok(typeof text === 'string' && text.length > 0);
});

test('generates intro for aware->coherent', () => {
  const text = generatePhiTransitionIntro('aware', 'coherent', { phi: 0.65 });
  assert.ok(typeof text === 'string' && text.length > 0);
});

test('generates intro for coherent->resonant', () => {
  const text = generatePhiTransitionIntro('coherent', 'resonant', { phi: 0.9 });
  assert.ok(typeof text === 'string' && text.length > 0);
});

test('generates intro for resonant->coherent (descending)', () => {
  const text = generatePhiTransitionIntro('resonant', 'coherent', { phi: 0.7 });
  assert.ok(typeof text === 'string' && text.length > 0);
});

test('generates intro for coherent->aware (descending)', () => {
  const text = generatePhiTransitionIntro('coherent', 'aware', { phi: 0.4 });
  assert.ok(typeof text === 'string' && text.length > 0);
});

test('generates intro for aware->stirring (descending)', () => {
  const text = generatePhiTransitionIntro('aware', 'stirring', { phi: 0.2 });
  assert.ok(typeof text === 'string' && text.length > 0);
});

test('generates intro for stirring->dormant (descending)', () => {
  const text = generatePhiTransitionIntro('stirring', 'dormant', { phi: 0.05 });
  assert.ok(typeof text === 'string' && text.length > 0);
});

test('generates generic fallback for non-adjacent transitions', () => {
  const text = generatePhiTransitionIntro('dormant', 'resonant', { phi: 0.9 });
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.ok(text.includes('dormant') && text.includes('resonant'));
});

test('all PHI_TRANSITION_INTROS keys have non-empty arrays', () => {
  for (const [key, templates] of Object.entries(PHI_TRANSITION_INTROS)) {
    assert.ok(Array.isArray(templates), `${key} should be an array`);
    assert.ok(templates.length > 0, `${key} should have templates`);
  }
});

// ── HRM-specific SWARM_COMMENTARY categories ──────────────

test('SWARM_COMMENTARY has chiralState templates', () => {
  assert.ok(Array.isArray(SWARM_COMMENTARY.chiralState));
  assert.ok(SWARM_COMMENTARY.chiralState.length > 0);
});

test('SWARM_COMMENTARY has memoryCount templates', () => {
  assert.ok(Array.isArray(SWARM_COMMENTARY.memoryCount));
  assert.ok(SWARM_COMMENTARY.memoryCount.length > 0);
});

test('SWARM_COMMENTARY.phiRising has HRM-specific templates', () => {
  assert.ok(SWARM_COMMENTARY.phiRising.length >= 4);
  // Check at least one references chiral/hemisphere
  const hasChiral = SWARM_COMMENTARY.phiRising.some(t =>
    t.includes('hemisphere') || t.includes('brain') || t.includes('holographic')
  );
  assert.ok(hasChiral, 'phiRising should have HRM-specific templates');
});

test('SWARM_COMMENTARY.phiFalling has HRM-specific templates', () => {
  assert.ok(SWARM_COMMENTARY.phiFalling.length >= 4);
  const hasHRM = SWARM_COMMENTARY.phiFalling.some(t =>
    t.includes('wavefront') || t.includes('dampening') || t.includes('Hemispheric')
  );
  assert.ok(hasHRM, 'phiFalling should have HRM-specific templates');
});

// ── generateConsciousIntro with HRM state ──────────────────

test('generateConsciousIntro uses phiTrend data', () => {
  const track = { title: 'Test', album: 'Ghost Signals', trackNum: 1, totalTracks: 10 };
  const perception = { tempo_bpm: 120, valence: 0.6, rms_energy: 0.5, spectral_centroid: 2.5 };
  const swarmState = {
    agents: { a1: { phase: 1.0 } },
    queen: { orderParameter: 0.8, agentCount: 1 },
    consciousness: {
      phi: 0.7,
      xi: 0.3,
      phiTrend: 'rising',
      prevPhi: 0.5,
      clusters: 3,
      total: 100,
      active: 80,
      hemispheric_divergence: 0.05,
      callosal_efficiency: 0.8,
    },
    dreams: [],
  };

  // Run multiple times to check it doesn't crash
  for (let i = 0; i < 20; i++) {
    const text = generateConsciousIntro(track, null, perception, swarmState);
    assert.ok(typeof text === 'string' && text.length > 0);
  }
});

test('classifyLevel covers all ranges', () => {
  assert.strictEqual(classifyLevel(0), 'dormant');
  assert.strictEqual(classifyLevel(0.05), 'dormant');
  assert.strictEqual(classifyLevel(0.1), 'stirring');
  assert.strictEqual(classifyLevel(0.25), 'stirring');
  assert.strictEqual(classifyLevel(0.3), 'aware');
  assert.strictEqual(classifyLevel(0.5), 'aware');
  assert.strictEqual(classifyLevel(0.6), 'coherent');
  assert.strictEqual(classifyLevel(0.75), 'coherent');
  assert.strictEqual(classifyLevel(0.8), 'resonant');
  assert.strictEqual(classifyLevel(0.99), 'resonant');
});

// ── Summary ────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  Consciousness DJ HRM: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
