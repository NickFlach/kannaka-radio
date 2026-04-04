'use strict';

const assert = require('assert');
const { ALBUMS, DJEngine } = require('../server/dj-engine');

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

console.log('\ndj-engine.test.js');

// ── ALBUMS constant ─────────────────────────────────────────

test('ALBUMS has expected album count', () => {
  const names = Object.keys(ALBUMS);
  assert.ok(names.length >= 5, `Expected at least 5 albums, got ${names.length}`);
});

test('every album has theme and tracks array', () => {
  for (const [name, album] of Object.entries(ALBUMS)) {
    assert.ok(typeof album.theme === 'string', `${name} missing theme`);
    assert.ok(Array.isArray(album.tracks), `${name} missing tracks array`);
    assert.ok(album.tracks.length > 0, `${name} has no tracks`);
  }
});

test('Ghost Signals is the first album', () => {
  const first = Object.keys(ALBUMS)[0];
  assert.strictEqual(first, 'Ghost Signals');
});

// ── DJEngine construction ───────────────────────────────────

// Use a non-existent music dir so findAudioFile returns null — we test logic, not files
const dj = new DJEngine({
  getMusicDir: () => '/nonexistent-music-dir',
  onTrackChange: () => {},
});

test('initial state is empty', () => {
  assert.strictEqual(dj.state.currentAlbum, null);
  assert.strictEqual(dj.state.currentTrackIdx, 0);
  assert.deepStrictEqual(dj.state.playlist, []);
  assert.deepStrictEqual(dj.userQueue, []);
});

test('buildPlaylist returns false for unknown album', () => {
  assert.strictEqual(dj.buildPlaylist('Nonexistent Album'), false);
});

test('getState returns correct structure', () => {
  const state = dj.getState();
  assert.ok('currentAlbum' in state);
  assert.ok('currentTrackIdx' in state);
  assert.ok('totalTracks' in state);
  assert.ok('current' in state);
  assert.ok('playlist' in state);
  assert.ok(Array.isArray(state.albums));
  assert.ok(state.albums.includes('Dream Tracks'));
});

test('getCurrentTrack returns null when empty', () => {
  assert.strictEqual(dj.getCurrentTrack(), null);
});

// ── Queue management ────────────────────────────────────────

test('addToQueue adds items', () => {
  dj.userQueue = [];
  dj.addToQueue('test-track.mp3');
  assert.strictEqual(dj.userQueue.length, 1);
});

test('removeFromQueue removes correct index', () => {
  dj.userQueue = [];
  dj.addToQueue('a.mp3');
  dj.addToQueue('b.mp3');
  dj.addToQueue('c.mp3');
  assert.strictEqual(dj.userQueue.length, 3);
  dj.removeFromQueue(1);
  assert.strictEqual(dj.userQueue.length, 2);
});

test('removeFromQueue returns false for invalid index', () => {
  assert.strictEqual(dj.removeFromQueue(999), false);
  assert.strictEqual(dj.removeFromQueue(-1), false);
});

test('shuffleQueue changes order (probabilistic)', () => {
  dj.userQueue = [];
  for (let i = 0; i < 20; i++) dj.addToQueue(`track-${i}.mp3`);
  const before = dj.userQueue.map(q => q.filename).join(',');
  dj.shuffleQueue();
  const after = dj.userQueue.map(q => q.filename).join(',');
  // With 20 items, probability of same order is 1/20! ≈ 0
  assert.notStrictEqual(before, after, 'Shuffle should change order');
});

// ── Mock dreams ─────────────────────────────────────────────

test('generateMockDream returns valid structure', () => {
  // Need at least one track in playlistMeta for dream generation
  dj.state.playlistMeta = [{ title: 'Test', album: 'Ghost Signals', trackNum: 1, file: 'test.mp3' }];
  const dream = dj.generateMockDream();
  assert.ok(dream.id);
  assert.ok(dream.content);
  assert.strictEqual(dream.type, 'hallucination');
});

test('generateMockDreams returns array', () => {
  dj.state.history = [{ title: 'A', album: 'Ghost Signals' }, { title: 'B', album: 'Emergence' }];
  const result = dj.generateMockDreams();
  assert.ok(Array.isArray(result.dreams));
  assert.ok(result.dreams.length >= 2);
});

// ── Track clusters ──────────────────────────────────────────

test('generateTrackClusters returns cluster per album', () => {
  // Populate playlist with some tracks
  dj.state.playlistMeta = [
    { title: 'A', album: 'Ghost Signals', trackNum: 1 },
    { title: 'B', album: 'Ghost Signals', trackNum: 2 },
    { title: 'C', album: 'Emergence', trackNum: 1 },
  ];
  const result = dj.generateTrackClusters();
  assert.ok(Array.isArray(result.clusters));
  assert.ok(result.clusters.length >= 2);
  const names = result.clusters.map(c => c.name);
  assert.ok(names.includes('Ghost Signals'));
  assert.ok(names.includes('Emergence'));
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  DJ Engine: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
