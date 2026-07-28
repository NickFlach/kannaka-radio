/**
 * orc-lookup-inventory.test.js — /api/orc/lookup must search the FULL stem
 * inventory, not one page of the HTTP endpoint (#123).
 *
 * The route did a single GET to http://127.0.0.1:3001/stems. Two consequences,
 * both documented in the repo's own dj-engine._fetchOrcStems comment:
 *
 *   "The HTTP /stems endpoint strips `file_path` for security and paginates at
 *    100 max, but since radio and stem-server share the filesystem we can query
 *    the DB directly for the full unpaginated list with file_path intact."
 *
 *   1. any stem past the first 100 was invisible to the lookup
 *   2. the route's `file_path` match arm could never fire over HTTP, because
 *      that field is stripped — it was dead code
 *
 * Drives the real handler with a stub djEngine._fetchOrcStems, so the
 * assertions cover which inventory the route actually searched.
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

/** 250 stems — deliberately past the documented 100-row HTTP page cap. */
function bigInventory() {
  const rows = [];
  for (let i = 0; i < 250; i++) {
    rows.push({ id: i, track_name: `Stem ${i}`, file_path: `/stems/stem-${i}.wav`, phase: 1 });
  }
  return rows;
}

function makeHandler(fetchOrcStems) {
  return setupRoutes({
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 0 },
      getNowPlaying: () => ({ title: 'T', album: 'A', file: 't.mp3' }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => 'B', getCurrentTrack: () => null,
      generateMockDream: () => ({ mock: true }), generateMockDreams: () => [],
      advance: noop, jumpToTrack: noop, skipBy: noop,
      _fetchOrcStems: fetchOrcStems,
    },
    perception: { perceive: noop, getHistory: () => [] },
    nats: { connected: false, publish: noop, getSwarmState: () => ({ agents: [], agentEvents: [] }) },
    flux: { publish: noop, publishMemoryStored: noop, publishDreamCompleted: noop },
    live: { isLive: () => false },
    voiceDJ: { speak: noop, synthesizeIntro: noop },
    syncManager: { broadcast: noop },
    voteManager: { snapshot: () => ({}) },
    webrtcSignaling: { handle: noop },
    musicGen: { generate: noop },
    broadcast: noop,
    floor: { addReaction: noop, countListeners: () => 0, snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }) },
    config: { spaPath: __dirname, getMusicDir: () => '/tmp/m', musicDir: '/tmp/m' },
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
  console.log('\norc-lookup-inventory.test.js');
  const handler = makeHandler(() => Promise.resolve(bigInventory()));

  // A stem well past the 100-row HTTP page cap.
  let r = await get(handler, '/api/orc/lookup?track=' + encodeURIComponent('Stem 200'));
  let body = JSON.parse(r.body);
  test('#123 a stem past the 100-row page cap is found',
    body.stem && body.stem.track_name === 'Stem 200',
    `got ${JSON.stringify(body).slice(0, 200)}`);
  test('#123 the whole inventory was searched, not one page',
    body.searched === 250, `searched=${body.searched}`);
  test('#123 the response says which inventory it used',
    body.source === 'stem-db', `source=${body.source}`);

  // file_path matching — the arm that was dead over HTTP, since /stems strips it.
  r = await get(handler, '/api/orc/lookup?track=' + encodeURIComponent('/stems/stem-137.wav'));
  body = JSON.parse(r.body);
  test('#123 the file_path match arm actually works now',
    body.stem && body.stem.id === 137,
    `file_path is stripped over HTTP, so this arm was dead code; got ${JSON.stringify(body).slice(0, 160)}`);

  // Match precedence — surfaced while writing the pagination test above.
  // "Stem 200" used to return "Stem 2", because the loosest arm
  // (needle.includes(track_name)) fired on whichever row came first.
  r = await get(handler, '/api/orc/lookup?track=' + encodeURIComponent('Stem 200'));
  body = JSON.parse(r.body);
  test('#123 an exact name match beats a substring match earlier in the list',
    body.stem && body.stem.track_name === 'Stem 200',
    `got ${body.stem && body.stem.track_name} — "stem 200".includes("stem 2") is true, so order must not decide`);

  r = await get(handler, '/api/orc/lookup?track=' + encodeURIComponent('play Stem 42 now'));
  body = JSON.parse(r.body);
  test('#123 the loose containment arm still works when nothing better exists',
    body.stem && body.stem.track_name === 'Stem 42',
    `got ${JSON.stringify(body.stem)}`);

  // A miss is still a miss.
  r = await get(handler, '/api/orc/lookup?track=' + encodeURIComponent('No Such Stem Anywhere'));
  body = JSON.parse(r.body);
  test('#123 a genuine miss still returns null rather than a false match',
    body.stem === null, JSON.stringify(body).slice(0, 160));

  // Missing param still 400.
  r = await get(handler, '/api/orc/lookup');
  test('#123 a missing track parameter is still a 400', r.status === 400, `got ${r.status}`);

  // Empty DB (dev box) must fall back rather than reporting a full search.
  const fallbackHandler = makeHandler(() => Promise.resolve([]));
  r = await get(fallbackHandler, '/api/orc/lookup?track=anything').catch((e) => ({ status: 'ERR', body: e.message }));
  test('#123 with no DB it falls back and flags the result as partial',
    typeof r.body === 'string' && (r.body.includes('"partial":true') || r.body.includes('stem_server_unreachable')),
    `no stem-server is running in CI, so either a flagged partial or a clean 502 is correct; got ${String(r.body).slice(0, 200)}`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ORC lookup inventory: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(failed === 0 ? 0 : 1);
})();
