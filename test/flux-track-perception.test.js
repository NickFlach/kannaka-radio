'use strict';

// flux-track-perception.test.js — a track-change event must never carry
// another track's perception (#125).
//
// Every caller publishes the flux event BEFORE `perception.hearTrack()` runs,
// so `_getPerception()` still held the PREVIOUS track's snapshot and the
// constellation received it labelled as the new track.
//
// Swapping the call order would not have fixed it. `hearTrack()` seeds
// `current` with a MOCK synchronously and only fills in the real `kannaka hear`
// measurement ~500ms later, so a synchronous read after it returns gets
// fabricated numbers for the right track instead of real numbers for the wrong
// one — the same trap #124 documented for KANNAKA.attention.ear. Publishing
// from the `onRealPerception` callback is not an option either: it is
// documented as firing only on a genuine measurement, so a `kannaka hear`
// failure would mean the now-playing event never fires at all.
//
// So the publisher no longer trusts call order: it accepts the live snapshot
// only when it is a real measurement OF THIS FILE, else the per-file cache
// from a prior airing, else null.

const assert = require('assert');
const { FluxPublisher } = require('../server/flux-publisher');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}

const TRACK_A = { title: 'A', album: 'X', trackNum: 1, totalTracks: 2, file: 'a.mp3', theme: 't' };
const TRACK_B = { title: 'B', album: 'X', trackNum: 2, totalTracks: 2, file: 'b.mp3', theme: 't' };

/** A full, real (kannaka-ear) perception object for `track`. */
function realPerception(track, tempo) {
  return {
    source: 'kannaka-ear',
    status: 'measured',
    track_info: track,
    tempo_bpm: tempo,
    spectral_centroid: 2.5,
    rms_energy: 0.4,
    pitch: 300,
    valence: 0.6,
    mfcc: Array(13).fill(0.5),
    mel_spectrogram: Array(128).fill(0.25),
  };
}

/** The mock placeholder hearTrack() installs synchronously. */
function mockPerception(track, tempo) {
  return { ...realPerception(track, tempo), source: 'mock', status: 'perceiving' };
}

/** Build a publisher whose _send is captured instead of hitting the network. */
function publisherWith({ current, byFile }) {
  const sent = [];
  const flux = new FluxPublisher({
    fluxToken: 'test',
    getCurrentTrack: () => null,
    getPerception: () => current,
    getPerceptionFor: (file) => (byFile && byFile[file]) || null,
    getDJState: () => ({}),
    getListenerCount: () => 0,
    getDJVoiceEnabled: () => false,
    getPendingRequestCount: () => 0,
    isLive: () => false,
  });
  flux._send = (event) => sent.push(event);
  return { flux, sent };
}

const perceptionOf = (sent) => sent[0].payload.properties.perception;

// ── the reported bug ────────────────────────────────────────

run('#125 the previous track\'s perception is never published as this one\'s', () => {
  // Exactly the live situation: still holding A's real measurement, publishing
  // the change to B.
  const { flux, sent } = publisherWith({ current: realPerception(TRACK_A, 128) });
  flux.publishTrackChange(TRACK_B);

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].payload.properties.title, 'B');
  assert.strictEqual(perceptionOf(sent), null,
    'B has never been measured, so its perception must be null — not A\'s numbers');
});

run('#125 a mock snapshot for the right track is still not published as measured', () => {
  // What a naive "swap the call order" fix would have produced.
  const { flux, sent } = publisherWith({ current: mockPerception(TRACK_B, 99) });
  flux.publishTrackChange(TRACK_B);
  assert.strictEqual(perceptionOf(sent), null,
    'fabricated mock numbers must not be published as perception');
});

// ── it must still publish real data when it has it ──────────

run('#125 a real measurement of THIS track is published', () => {
  // The over-correction guard: suppressing everything would also "fix" the bug.
  const { flux, sent } = publisherWith({ current: realPerception(TRACK_B, 140) });
  flux.publishTrackChange(TRACK_B);

  const p = perceptionOf(sent);
  assert.ok(p, 'a real measurement of this track must be published');
  assert.strictEqual(p.tempo_bpm, 140);
  assert.strictEqual(p.mfcc_summary.length, 5);
  assert.strictEqual(p.mel_energy_bands.length, 4);
});

run('#125 falls back to the per-file cache from a prior airing', () => {
  // The cache stores only four scalars — no mfcc, no mel_spectrogram. The old
  // body called .slice() on both unconditionally, so this shape would have
  // thrown inside the publish path.
  const cached = { tempo_bpm: 118, rms_energy: 0.33, spectral_centroid: 1.9, valence: 0.5, ts: 1 };
  const { flux, sent } = publisherWith({
    current: realPerception(TRACK_A, 128),   // still the previous track
    byFile: { 'b.mp3': cached },
  });
  flux.publishTrackChange(TRACK_B);

  const p = perceptionOf(sent);
  assert.ok(p, 'a cached real measurement of this file should be used');
  assert.strictEqual(p.tempo_bpm, 118, 'must be B\'s cached tempo, not A\'s 128');
  assert.strictEqual(p.mfcc_summary, null, 'absent fields are null, not a crash');
  assert.strictEqual(p.mel_energy_bands, null);
});

run('#125 the live snapshot wins over a stale cache for the same file', () => {
  const cached = { tempo_bpm: 100, rms_energy: 0.1, spectral_centroid: 1.0, valence: 0.2, ts: 1 };
  const { flux, sent } = publisherWith({
    current: realPerception(TRACK_B, 140),
    byFile: { 'b.mp3': cached },
  });
  flux.publishTrackChange(TRACK_B);
  assert.strictEqual(perceptionOf(sent).tempo_bpm, 140,
    'a live real measurement of this track beats the cached one');
});

run('#125 publishing still works with no perception source wired at all', () => {
  const { flux, sent } = publisherWith({ current: null });
  flux.publishTrackChange(TRACK_B);
  assert.strictEqual(sent.length, 1, 'the track change must still be announced');
  assert.strictEqual(perceptionOf(sent), null);
});

console.log(failed === 0 ? '\nflux-track-perception: all passed' : `\nflux-track-perception: ${failed} FAILED`);
if (failed > 0) process.exit(1);
