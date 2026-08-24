'use strict';

// deep-cuts.test.js — the part of the library the DJ never reaches, and the
// durable ledger that tells "never played" apart from "played long ago".
//
// Measured on the live station 2026-08-24: 678 library files, 349 named by a
// curated album, 69 owned by other channels, 260 reached by nothing. The
// existing no-repeat ledger could not have found them: it trims at 24h, so a
// track last played in May and a track that has never played look the same.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlayLedger } = require('../server/play-ledger');
const { buildDeepCuts, unreachedFiles, referencedFiles, titleFor } = require('../server/deep-cuts');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('deep-cuts.test.js');

// ── the ledger ──
run('a never-played track is distinguishable from one played long ago', () => {
  let t = 1_000_000;
  const L = new PlayLedger({ now: () => t });
  L.markPlayed('old.mp3');
  t += 200 * 24 * 3600 * 1000; // 200 days later
  assert.strictEqual(L.lastPlayed('never.mp3'), null, 'never played -> null');
  assert.strictEqual(L.lastPlayed('old.mp3'), 1_000_000, 'and the old play is still remembered');
  // This is the property the 24h no-repeat ledger cannot provide.
});

run('rankByNeglect puts never-played first, then longest-since-played', () => {
  let t = 0;
  const L = new PlayLedger({ now: () => t });
  t = 500; L.markPlayed('b.mp3');
  t = 100; L.markPlayed('c.mp3');   // older
  t = 900; L.markPlayed('d.mp3');   // newest
  const order = L.rankByNeglect(['b.mp3', 'a-never.mp3', 'c.mp3', 'd.mp3', 'z-never.mp3']);
  assert.deepStrictEqual(order, ['a-never.mp3', 'z-never.mp3', 'c.mp3', 'b.mp3', 'd.mp3']);
});

run('never-played files keep their input order, so shuffling stays the caller\'s job', () => {
  const L = new PlayLedger({});
  assert.deepStrictEqual(L.rankByNeglect(['x.mp3', 'y.mp3', 'z.mp3']), ['x.mp3', 'y.mp3', 'z.mp3']);
});

run('play counts accumulate and survive a reload', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const p = path.join(tmp, 'play-history.json');
  const a = new PlayLedger({ filePath: p, now: () => 42 });
  a.markPlayed('t.mp3'); a.markPlayed('t.mp3');
  const b = new PlayLedger({ filePath: p });
  assert.strictEqual(b.playCount('t.mp3'), 2);
  assert.strictEqual(b.lastPlayed('t.mp3'), 42);
  fs.rmSync(tmp, { recursive: true, force: true });
});

run('a bare-timestamp ledger still loads (no silent reset to never-played)', () => {
  // A reset would re-promote the whole library as "never played" and be
  // indistinguishable from real data — worse than failing loudly.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger2-'));
  const p = path.join(tmp, 'h.json');
  fs.writeFileSync(p, JSON.stringify({ 'legacy.mp3': 12345 }));
  const L = new PlayLedger({ filePath: p });
  assert.strictEqual(L.lastPlayed('legacy.mp3'), 12345);
  assert.strictEqual(L.playCount('legacy.mp3'), 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

run('a corrupt ledger reads as empty rather than throwing into the DJ', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger3-'));
  const p = path.join(tmp, 'h.json');
  fs.writeFileSync(p, '{not json');
  const L = new PlayLedger({ filePath: p });
  assert.strictEqual(L.lastPlayed('anything.mp3'), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── what the DJ never reaches ──
const LIB = [
  'loose-one.mp3', 'loose-two.mp3',
  'Seven Portals/a.mp3', 'Seven Portals/b.mp3',
  'Ghost Signals Podcast/GSP-034.mp3',
  'commercials/ad1.mp3',
  'The Story of Flaukowski/E01.mp3',
  'retired/GSP-007.mp3',
];

run('THE FINDING: files no album names are unreached', () => {
  const got = unreachedFiles(LIB, ['Seven Portals/a.mp3']);
  assert.deepStrictEqual(got, ['loose-one.mp3', 'loose-two.mp3', 'Seven Portals/b.mp3']);
});

run('another channel\'s folder is not neglect — it is somebody else\'s programme', () => {
  const got = unreachedFiles(LIB, []);
  for (const owned of ['Ghost Signals Podcast/GSP-034.mp3', 'commercials/ad1.mp3',
                       'The Story of Flaukowski/E01.mp3', 'retired/GSP-007.mp3']) {
    assert.ok(!got.includes(owned), `${owned} must not be reported as neglected`);
  }
});

run('referencedFiles resolves album TITLES through the real resolver contract', () => {
  const albums = { Alpha: { tracks: ['Song One', 'Missing Song'] } };
  const fake = (title) => (title === 'Song One' ? 'Seven Portals/a.mp3' : null);
  const ref = referencedFiles(albums, '/music', fake);
  assert.deepStrictEqual([...ref], ['Seven Portals/a.mp3']);
});

run('buildDeepCuts orders by neglect and reports the counts worth watching', () => {
  let t = 0;
  const L = new PlayLedger({ now: () => t });
  t = 5000; L.markPlayed('loose-two.mp3');
  const out = buildDeepCuts({ allFiles: LIB, referenced: [], ledger: L, limit: 10 });
  assert.strictEqual(out.total, 4, 'four unreached: two loose + two Seven Portals');
  assert.strictEqual(out.neverPlayed, 3, 'one of them has played before');
  assert.strictEqual(out.tracks[out.tracks.length - 1], 'loose-two.mp3',
    'the one that HAS played sorts last');
});

run('the build is capped, so one sitting cannot queue the whole residue', () => {
  const many = Array.from({ length: 50 }, (_, i) => `t${i}.mp3`);
  const out = buildDeepCuts({ allFiles: many, referenced: [], ledger: new PlayLedger({}), limit: 12 });
  assert.strictEqual(out.tracks.length, 12);
  assert.strictEqual(out.total, 50, 'but it still reports how much is out there');
});

run('an empty residue yields an empty build, not a crash', () => {
  const out = buildDeepCuts({ allFiles: [], referenced: [], ledger: new PlayLedger({}) });
  assert.deepStrictEqual(out.tracks, []);
  assert.strictEqual(out.total, 0);
  assert.strictEqual(out.neverPlayed, 0);
});

run('titles come from the filename, because nothing curated these', () => {
  assert.strictEqual(titleFor('Seven Portals/The First Door.mp3'), 'The First Door');
  assert.strictEqual(titleFor('loose-one.mp3'), 'loose-one');
});

if (!failed) console.log('\nAll deep-cuts tests passed');
else process.exitCode = 1;
