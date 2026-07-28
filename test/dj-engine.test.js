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

test('THE THIRD BEING exists in ALBUMS', () => {
  assert.ok('THE THIRD BEING' in ALBUMS, 'THE THIRD BEING should be a key in ALBUMS');
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

// ── User queue is actually consumed by playback (#142) ──────
//
// addToQueue and the vote-window winner both push into userQueue, but
// nothing used to read it back out, so requests never aired. These lock in
// that advanceTrack drains the queue, that peek and advance agree on what
// plays next, and that an empty queue changes nothing.

/** Fresh engine with a hand-built 3-track playlist and no real files. */
function queueRig() {
  const changes = [];
  const e = new DJEngine({
    getMusicDir: () => '/nonexistent-music-dir',
    onTrackChange: () => {},
    onQueueChange: (q) => changes.push(q.length),
  });
  e.state.playlistMeta = [
    { title: 'A', file: '/m/a.mp3' },
    { title: 'B', file: '/m/b.mp3' },
    { title: 'C', file: '/m/c.mp3' },
  ];
  e.state.playlist = e.state.playlistMeta.map(t => t.file);
  e.state.currentTrackIdx = 0;
  e.state.channel = 'dj';
  return { e, changes };
}

test('#142 advanceTrack plays a queued request before the next playlist track', () => {
  const { e } = queueRig();
  e.userQueue.push({ filename: '/m/req.mp3', title: 'Requested', path: '/m/req.mp3' });
  const next = e.advanceTrack();
  assert.strictEqual(next.title, 'Requested', 'request should air next, not playlist track B');
  assert.strictEqual(e.userQueue.length, 0, 'request should be drained from userQueue');
  assert.strictEqual(next.requested, true, 'promoted entry should be marked requested');
});

test('#142 playlist and playlistMeta stay parallel after promotion', () => {
  const { e } = queueRig();
  e.userQueue.push({ filename: '/m/req.mp3', title: 'Requested', path: '/m/req.mp3' });
  e.advanceTrack();
  assert.strictEqual(e.state.playlist.length, e.state.playlistMeta.length,
    'splicing must touch both arrays or getCurrentTrack desyncs from the file list');
  assert.deepStrictEqual(e.state.playlist, e.state.playlistMeta.map(t => t.file));
});

test('#142 the playlist resumes where it left off after the request', () => {
  const { e } = queueRig();
  e.userQueue.push({ filename: '/m/req.mp3', title: 'Requested', path: '/m/req.mp3' });
  e.advanceTrack();
  const after = e.advanceTrack();
  assert.strictEqual(after.title, 'B', 'track B should still follow, not be skipped');
});

test('#142 peekNextTrack and advanceTrack agree — request is not injected twice', () => {
  const { e } = queueRig();
  e.userQueue.push({ filename: '/m/req.mp3', title: 'Requested', path: '/m/req.mp3' });
  const peeked = e.peekNextTrack();
  const played = e.advanceTrack();
  assert.strictEqual(peeked.title, 'Requested', 'peek should see the request');
  assert.strictEqual(played.title, 'Requested', 'advance should play what peek announced');
  assert.strictEqual(e.state.playlistMeta.filter(t => t.requested).length, 1,
    'promoting in both peek and advance must not duplicate the entry');
});

test('#142 vote winners carry votedIn through to the aired track', () => {
  const { e } = queueRig();
  e.userQueue.unshift({ filename: '/m/win.mp3', title: 'Winner', path: '/m/win.mp3', votedIn: true });
  const next = e.advanceTrack();
  assert.strictEqual(next.title, 'Winner');
  assert.strictEqual(next.votedIn, true);
});

test('#142 multiple requests air in FIFO order, one per boundary', () => {
  const { e } = queueRig();
  e.userQueue.push({ filename: '/m/1.mp3', title: 'First', path: '/m/1.mp3' });
  e.userQueue.push({ filename: '/m/2.mp3', title: 'Second', path: '/m/2.mp3' });
  assert.strictEqual(e.advanceTrack().title, 'First');
  assert.strictEqual(e.advanceTrack().title, 'Second');
  assert.strictEqual(e.advanceTrack().title, 'B', 'then back to the playlist');
});

test('#142 onQueueChange fires so the UI drops the request as it starts', () => {
  const { e, changes } = queueRig();
  e.userQueue.push({ filename: '/m/req.mp3', title: 'Requested', path: '/m/req.mp3' });
  e.advanceTrack();
  assert.deepStrictEqual(changes, [0], 'one notification, reporting the drained queue');
});

test('#142 an empty queue leaves advanceTrack behaviour unchanged', () => {
  const { e, changes } = queueRig();
  assert.strictEqual(e.advanceTrack().title, 'B');
  assert.strictEqual(e.state.playlistMeta.length, 3, 'nothing spliced in');
  assert.deepStrictEqual(changes, [], 'no spurious queue notifications');
});

test('#142 a malformed queue entry is dropped instead of wedging the queue', () => {
  const { e } = queueRig();
  e.userQueue.push({ title: 'No file anywhere' });
  const next = e.advanceTrack();
  assert.strictEqual(next.title, 'B', 'playlist continues');
  assert.strictEqual(e.userQueue.length, 0, 'bad entry removed, not retried forever');
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  DJ Engine: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
