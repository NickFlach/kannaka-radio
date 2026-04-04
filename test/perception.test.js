'use strict';

const assert = require('assert');
const { PerceptionEngine } = require('../server/perception');

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

console.log('\nperception.test.js');

// ── Mock perception generation ──────────────────────────────

const engine = new PerceptionEngine({
  getCurrentTrack: () => ({ title: 'Ghost Signals', album: 'Ghost Signals', trackNum: 1, file: 'ghost.mp3' }),
  broadcast: () => {},
  kannakabin: '/nonexistent',
  getMusicDir: () => '/tmp',
});

const mockTrack = { title: 'Test Track', album: 'Ghost Signals', trackNum: 1, file: 'test.mp3' };

test('generateMockPerception returns valid structure', () => {
  const p = engine.generateMockPerception(mockTrack);
  assert.strictEqual(p.mel_spectrogram.length, 128);
  assert.strictEqual(p.mfcc.length, 13);
  assert.strictEqual(typeof p.tempo_bpm, 'number');
  assert.strictEqual(typeof p.spectral_centroid, 'number');
  assert.strictEqual(typeof p.rms_energy, 'number');
  assert.strictEqual(typeof p.pitch, 'number');
  assert.strictEqual(typeof p.valence, 'number');
  assert.strictEqual(p.status, 'perceiving');
  assert.deepStrictEqual(p.track_info, mockTrack);
});

test('mel_spectrogram values are in [0,1]', () => {
  const p = engine.generateMockPerception(mockTrack);
  p.mel_spectrogram.forEach((v, i) => {
    assert.ok(v >= 0 && v <= 1, `mel[${i}] = ${v} out of range`);
  });
});

test('mfcc values are in [0,1]', () => {
  const p = engine.generateMockPerception(mockTrack);
  p.mfcc.forEach((v, i) => {
    assert.ok(v >= 0 && v <= 1, `mfcc[${i}] = ${v} out of range`);
  });
});

test('valence is clamped to [0,1]', () => {
  const p = engine.generateMockPerception(mockTrack);
  assert.ok(p.valence >= 0 && p.valence <= 1);
});

test('different tracks produce different perceptions', () => {
  const p1 = engine.generateMockPerception({ title: 'Track A', album: 'Ghost Signals', trackNum: 1, file: 'a.mp3' });
  const p2 = engine.generateMockPerception({ title: 'Track B', album: 'Emergence', trackNum: 2, file: 'b.mp3' });
  // They should differ in at least tempo or valence
  const differs = p1.tempo_bpm !== p2.tempo_bpm || p1.valence !== p2.valence;
  assert.ok(differs, 'Different tracks should produce different perception values');
});

// ── _parsePerceptionOutput ──────────────────────────────────

test('_parsePerceptionOutput parses valid kannaka-ear output', () => {
  const output = [
    'Heard: abc-123-uuid',
    'Duration: 3.5s',
    'Tempo: 128 BPM',
    'RMS: 0.234',
    'Centroid: 3.20 kHz',
    'Tags: 128bpm, bright, energetic',
  ].join('\n');
  const result = engine._parsePerceptionOutput(output, mockTrack);
  assert.strictEqual(result.tempo_bpm, 128);
  assert.strictEqual(result.rms_energy, 0.234);
  assert.strictEqual(result.spectral_centroid, 3.2);
  assert.strictEqual(result.source, 'kannaka-ear');
  assert.strictEqual(result.status, 'perceiving');
  assert.ok(result.tags.includes('bright'));
  assert.ok(result.mel_spectrogram.length === 128);
  assert.ok(result.duration_secs === 3.5);
});

test('_parsePerceptionOutput falls back to mock on bad input', () => {
  const result = engine._parsePerceptionOutput('garbage output', mockTrack);
  assert.strictEqual(result.status, 'perceiving');
  // Should fall back to mock (no "source" field = mock)
  assert.ok(!result.source || result.source !== 'kannaka-ear');
});

test('_parsePerceptionOutput handles partial output (missing tempo)', () => {
  const output = 'RMS: 0.5\nCentroid: 2.0 kHz';
  const result = engine._parsePerceptionOutput(output, mockTrack);
  // No tempo → falls back to mock
  assert.strictEqual(result.status, 'perceiving');
});

test('_parsePerceptionOutput derives correct mel shape from real data', () => {
  const output = 'Tempo: 120 BPM\nRMS: 0.3\nCentroid: 4.0 kHz';
  const result = engine._parsePerceptionOutput(output, mockTrack);
  assert.strictEqual(result.mel_spectrogram.length, 128);
  assert.strictEqual(result.mfcc.length, 13);
  // High centroid (4 kHz = 0.8 brightness) → peak should be shifted right
  const peakIdx = result.mel_spectrogram.indexOf(Math.max(...result.mel_spectrogram));
  assert.ok(peakIdx > 60, `Peak at ${peakIdx} should be >60 for high centroid`);
});

// ── Initial state ───────────────────────────────────────────

test('initial perception state is no_perception', () => {
  const fresh = new PerceptionEngine({
    getCurrentTrack: () => null,
    broadcast: () => {},
    kannakabin: '/nonexistent',
    getMusicDir: () => '/tmp',
  });
  assert.strictEqual(fresh.getCurrentPerception().status, 'no_perception');
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  Perception: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
