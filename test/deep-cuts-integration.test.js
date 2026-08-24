'use strict';

// deep-cuts-integration.test.js — the whole chain against a real directory:
// loadAlbum("Deep Cuts") -> buildPlaylist -> playable state, and the durable
// ledger demoting a track once it has actually aired.
//
// The unit tests cover the selection rule. This covers the wiring, which is
// where the equivalent feature failed before: the TSOF season was on disk,
// correctly encoded, and unreachable because nothing named it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DJEngine, ALBUMS } = require('../server/dj-engine');
const { invalidateCache } = require('../server/utils');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; } }

console.log('deep-cuts-integration.test.js');

// A library with: one file a curated album names, several nothing names, and
// folders other channels own.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-lib-'));
const known = Object.keys(ALBUMS).find((k) => (ALBUMS[k].tracks || []).length);
const knownTitle = ALBUMS[known].tracks[0];
fs.writeFileSync(path.join(tmp, `${knownTitle}.mp3`), 'x');
for (const f of ['orphan-a.mp3', 'orphan-b.mp3', 'orphan-c.mp3']) fs.writeFileSync(path.join(tmp, f), 'x');
fs.mkdirSync(path.join(tmp, 'Ghost Signals Podcast'));
fs.writeFileSync(path.join(tmp, 'Ghost Signals Podcast', 'GSP-034.mp3'), 'x');
fs.mkdirSync(path.join(tmp, 'commercials'));
fs.writeFileSync(path.join(tmp, 'commercials', 'ad.mp3'), 'x');
invalidateCache();

function engine() {
  const e = new DJEngine({ musicDir: tmp });
  e._getMusicDir = () => tmp;
  e._playLedger.filePath = null; // keep the test off the repo's real ledger
  return e;
}

run('Deep Cuts is offered to clients as a selectable album', () => {
  assert.ok(engine().getState().albums.includes('Deep Cuts'));
});

run('THE WIRING: loadAlbum("Deep Cuts") yields a playable track', () => {
  const e = engine();
  const track = e.loadAlbum('Deep Cuts');
  assert.ok(track, 'loadAlbum must return a track, not null');
  assert.strictEqual(e.state.currentAlbum, 'Deep Cuts');
  assert.ok(e.state.playlist.length > 0, 'playlist is populated');
});

run('it plays ONLY what nothing else names', () => {
  const e = engine();
  e.loadAlbum('Deep Cuts');
  const files = e.state.playlistMeta.map((m) => m.file);
  assert.deepStrictEqual(files.slice().sort(), ['orphan-a.mp3', 'orphan-b.mp3', 'orphan-c.mp3']);
  assert.ok(!files.some((f) => f.includes('Ghost Signals Podcast')), 'never another channel\'s programme');
  assert.ok(!files.some((f) => f.includes('commercials')), 'never the ad pool');
  assert.ok(!files.includes(`${knownTitle}.mp3`), 'never a track a curated album already names');
});

run('a track that has aired sinks below the ones that never have', () => {
  const e = engine();
  let t = 1000;
  e._playLedger._now = () => t;
  e._playLedger.markPlayed('orphan-b.mp3');
  t = 2000;
  e.loadAlbum('Deep Cuts');
  const files = e.state.playlistMeta.map((m) => m.file);
  assert.strictEqual(files[files.length - 1], 'orphan-b.mp3',
    'the one with a play history sorts last; the never-played come first');
});

run('an exhausted residue aborts the load instead of stranding the listener', () => {
  // Same contract as every other album: return false, preserve state, let
  // programming.js pick something else rather than serving dead air.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-empty-'));
  invalidateCache();
  const e = new DJEngine({ musicDir: empty });
  e._getMusicDir = () => empty;
  e._playLedger.filePath = null;
  e.state.currentAlbum = 'Something Playing';
  assert.strictEqual(e.loadAlbum('Deep Cuts'), null);
  assert.strictEqual(e.state.currentAlbum, 'Something Playing', 'previous album preserved');
  fs.rmSync(empty, { recursive: true, force: true });
  invalidateCache();
});

run('every rotation block can reach Deep Cuts', () => {
  const { TIME_BLOCKS, BLOCKS, default: def } = (() => {
    try { return require('../server/programming'); } catch { return {}; }
  })();
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'programming.js'), 'utf8');
  const blocks = (src.match(/albums: \[/g) || []).length;
  const withDeep = (src.match(/'Deep Cuts'/g) || []).length;
  assert.ok(blocks > 0, 'found the rotation blocks');
  assert.strictEqual(withDeep, blocks, `all ${blocks} blocks list Deep Cuts (found ${withDeep})`);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
if (!failed) console.log('\nAll deep-cuts-integration tests passed');
else process.exitCode = 1;
