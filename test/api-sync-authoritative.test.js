/**
 * api-sync-authoritative.test.js — /api/sync must agree with SyncManager (#51).
 *
 * SyncManager is the authoritative source of {file, position, timestamp}, and
 * that exact shape is what WS clients get on connect and on every heartbeat
 * (server/index.js: `ws.send({type:"sync", data: syncManager.getSyncState()})`).
 *
 * /api/sync never consulted it. It returned a DJ/perception snapshot with no
 * `position` at all and a `file` the caller had to infer from `track` — so the
 * two transports gave different answers to the same question, and an HTTP
 * client could not sync playback position.
 *
 * Drives the real handler over HTTP with a stub SyncManager.
 */

'use strict';

const assert = require('assert');
const http = require('http');
const setupRoutes = require('../server/routes');

let passed = 0;
let failed = 0;

function test(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

const noop = () => {};
const SYNC = { file: 'ghost-signals-04.mp3', position: 87.5 };

function makeHandler(syncManager) {
  return setupRoutes({
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 3, currentAlbum: 'GHOST SIGNALS', playlist: ['a', 'b', 'c', 'd'] },
      getNowPlaying: () => ({ title: 'T', album: 'A', file: 't.mp3' }),
      getCurrentTrack: () => ({ title: 'Track 4', album: 'GHOST SIGNALS', file: 'ghost-signals-04.mp3' }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => 'B', generateMockDream: () => ({}), generateMockDreams: () => [],
      advance: noop, jumpToTrack: noop, skipBy: noop,
    },
    perception: { perceive: noop, getHistory: () => [], getCurrentPerception: () => ({ tempo_bpm: 120, valence: 0.5, rms_energy: 0.3 }) },
    nats: { connected: false, publish: noop, getSwarmState: () => ({ agents: [], agentEvents: [] }) },
    flux: { publish: noop, publishMemoryStored: noop, publishDreamCompleted: noop },
    live: { isLive: () => false, state: { active: false } },
    voiceDJ: { speak: noop, synthesizeIntro: noop, isEnabled: () => true },
    syncManager,
    voteManager: { snapshot: () => ({}) },
    webrtcSignaling: { handle: noop },
    musicGen: { generate: noop },
    broadcast: noop,
    floor: { addReaction: noop, countListeners: () => 0, snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }) },
    config: { spaPath: __dirname, getMusicDir: () => '/tmp/m', musicDir: '/tmp/m', getListenerCount: () => 7 },
    gsHub: null,
  });
}

function get(handler, url) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const req = http.get({ host: '127.0.0.1', port, path: url, timeout: 8000 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: d }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.on('timeout', () => { req.destroy(); server.close(); reject(new Error('timeout')); });
    });
  });
}

(async () => {
  console.log('\napi-sync-authoritative.test.js');

  const handler = makeHandler({
    getSyncState: () => ({ ...SYNC, timestamp: Date.now() }),
    trackChanged: noop,
  });

  let r = await get(handler, '/api/sync');
  let body = JSON.parse(r.body);

  test('#51 /api/sync reports the playback position',
    body.position === SYNC.position,
    `position=${body.position} — an HTTP client cannot sync without it`);
  test('#51 /api/sync reports the authoritative file',
    body.file === SYNC.file, `file=${body.file}`);
  test('#51 the file matches SyncManager, not an inference from track',
    body.file === SYNC.file && body.track && body.track.file === SYNC.file,
    `sync.file=${body.file} track.file=${body.track && body.track.file}`);

  // Backwards compatibility — every field that existed before must survive.
  for (const [field, expected] of [
    ['album', 'GHOST SIGNALS'],
    ['trackIdx', 3],
    ['totalTracks', 4],
    ['listeners', 7],
    ['djVoice', true],
    ['isLive', false],
  ]) {
    test(`#51 existing field \`${field}\` is preserved`,
      body[field] === expected, `${field}=${JSON.stringify(body[field])}, expected ${JSON.stringify(expected)}`);
  }
  test('#51 the perception block is preserved',
    body.perception && body.perception.tempo_bpm === 120, JSON.stringify(body.perception));
  test('#51 timestamp is still present and numeric',
    typeof body.timestamp === 'number', `timestamp=${body.timestamp}`);

  // A missing//partial SyncManager must not break the endpoint.
  const degraded = makeHandler({ trackChanged: noop });
  r = await get(degraded, '/api/sync');
  test('#51 a SyncManager without getSyncState degrades instead of 500ing',
    r.status === 200, `got ${r.status} ${r.body.slice(0, 140)}`);
  body = JSON.parse(r.body);
  test('#51 the degraded response still carries the DJ snapshot',
    body.album === 'GHOST SIGNALS' && body.position === undefined,
    JSON.stringify(body).slice(0, 180));

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  API sync authoritative: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(failed === 0 ? 0 : 1);
})();
