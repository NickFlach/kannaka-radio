'use strict';

/**
 * unreached-endpoint.test.js — GET /api/audio/unreached, over HTTP.
 *
 * The endpoint shipped referencing a `MUSIC_DIR` constant that does not exist
 * in routes.js scope (it is `config.getMusicDir()`). Node only evaluates that
 * identifier when a request arrives, so nothing failed at boot, `node --check`
 * was happy, the module's own unit tests passed, and the route returned
 * 500 {"error":"audit failed"} the first time anybody called it in production.
 *
 * A test of the audit MODULE could not have caught that — the bug was in the
 * wiring. So this one goes over the wire, through the real routes module.
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const setupRoutes = require('../server/routes');

function noop() {}

// A library with: a file a curated album names, files nothing names, and a
// folder another channel owns.
const MUSIC = fs.mkdtempSync(path.join(os.tmpdir(), 'unreached-'));
const { ALBUMS } = require('../server/dj-engine');
const known = Object.keys(ALBUMS).find((k) => (ALBUMS[k].tracks || []).length);
fs.writeFileSync(path.join(MUSIC, `${ALBUMS[known].tracks[0]}.mp3`), 'x');
// Deliberately unmatchable names. findAudioFile's third pass is a 70% word
// overlap, and against a 4-file fixture that will happily bind a real album
// title to a plausible-looking decoy — so the decoys get names no title can
// overlap with.
fs.writeFileSync(path.join(MUSIC, 'zzqx7f3k9w.mp3'), 'x');
fs.writeFileSync(path.join(MUSIC, 'vv82mhtp5r.mp3'), 'x');
fs.mkdirSync(path.join(MUSIC, 'commercials'));
fs.writeFileSync(path.join(MUSIC, 'commercials', 'ad.mp3'), 'x');
require('../server/utils').invalidateCache();

const { PlayLedger } = require('../server/play-ledger');
const ledger = new PlayLedger({});

function handler() {
  return setupRoutes({
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 0 },
      _playLedger: ledger,
      getNowPlaying: () => ({ title: 'T', album: 'A', file: 't.mp3' }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => 'B', advance: noop, jumpToTrack: noop, skipBy: noop,
    },
    perception: { perceive: noop, getHistory: () => [] },
    nats: { connected: false, publish: noop },
    flux: { publish: noop, publishMemoryStored: noop, publishDreamCompleted: noop },
    live: { isLive: () => false },
    voiceDJ: { speak: noop, synthesizeIntro: noop },
    syncManager: { broadcast: noop },
    voteManager: { snapshot: () => ({}) },
    webrtcSignaling: { handle: noop },
    musicGen: { generate: noop },
    broadcast: noop,
    floor: { addReaction: noop, countListeners: () => 0, snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }) },
    config: { spaPath: __dirname, baseDir: path.join(__dirname, '..'), getMusicDir: () => MUSIC, musicDir: MUSIC },
    gsHub: null,
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler());
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      http.get({ host: '127.0.0.1', port, path: url }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }); });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

let failed = 0;
async function run(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

(async () => {
  console.log('unreached-endpoint.test.js');

  await run('THE REGRESSION: the endpoint answers 200, not 500', async () => {
    const r = await get('/api/audio/unreached');
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}: ${r.body.slice(0, 160)}`);
    assert.ok(!r.body.includes('audit failed'), 'no audit-failed body');
  });

  await run('it reports the unreached files, and excludes what another channel owns', async () => {
    const d = JSON.parse((await get('/api/audio/unreached')).body);
    assert.strictEqual(d.unreached.total, 2, 'the two files nothing names');
    const folders = d.unreached.byFolder.map((f) => f.folder);
    assert.ok(!folders.includes('commercials'), 'the ad pool is not neglect');
    assert.strictEqual(d.libraryFiles, 4);
    assert.ok(d.namedByAnAlbum >= 1, 'the curated track is counted as named');
  });

  await run('it reports the invisible-folder condition separately', async () => {
    // The two failures are different and must not be collapsed: "no album
    // names it" vs "the resolver cannot even see the folder" (what silenced
    // the TSOF season). Reporting one as the other is the mistake this
    // endpoint was rewritten to stop making.
    const d = JSON.parse((await get('/api/audio/unreached')).body);
    assert.ok(Array.isArray(d.invisibleFolders.folders), 'invisible folders reported');
    assert.ok('neverPlayed' in d.unreached, 'and the never-played count is present');
  });

  try { fs.rmSync(MUSIC, { recursive: true, force: true }); } catch { /* best effort */ }
  if (!failed) console.log('\nAll unreached-endpoint tests passed');
  else process.exitCode = 1;
  setTimeout(() => process.exit(failed ? 1 : 0), 30);
})();
