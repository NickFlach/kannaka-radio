/**
 * swarm-peers-cache.test.js — /api/swarm/peers must not mistake a failed
 * refresh for an empty swarm (#160).
 *
 * Pre-fix, ANY transient failure of `kannaka swarm peers --json` (binary
 * missing during a redeploy, CLI timeout, malformed output) overwrote the
 * cached peer directory with [] AND stamped it fresh, so the constellation
 * read as an empty swarm for the next 30s off a single blip.
 *
 * These drive the real route handler over HTTP, the same way
 * routes-discoverability.test.js does — no reimplementation of the logic.
 * The failure path is exercised by pointing `config.kannakabin` at a
 * nonexistent binary, which makes execFile error on every platform.
 */

const http = require("http");
const assert = require("assert");
const setupRoutes = require("../server/routes");

let passed = 0;
let failed = 0;

function noop() {}

/** Binary that cannot exist, so execFile always errors (ENOENT). */
const MISSING_BIN = "/nonexistent/kannaka-does-not-exist-160";

function makeHandler() {
  return setupRoutes({
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 0 },
      getNowPlaying: () => ({ title: "T", album: "A", file: "t.mp3" }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => "B", advance: noop, jumpToTrack: noop, skipBy: noop,
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
    config: { spaPath: __dirname, getMusicDir: () => "/tmp/m", musicDir: "/tmp/m", kannakabin: MISSING_BIN },
    gsHub: null,
  });
}

function get(handler, url) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      http.get({ host: "127.0.0.1", port, path: url }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
      }).on("error", (e) => { server.close(); reject(e); });
    });
  });
}

async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

const GOOD_PEERS = [{ id: "oracle-1" }, { id: "oracle-2" }, { id: "witness-01" }];

(async () => {
  console.log("\nswarm-peers-cache.test.js");
  const handler = makeHandler();

  await test("#160 a failed refresh keeps the last good peer directory", async () => {
    // Seed a directory that has gone stale enough to trigger a refresh.
    global._peersCache = { t: Date.now() - 60000, peers: GOOD_PEERS.slice() };
    const r = await get(handler, "/api/swarm/peers");
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.peers.length, 3,
      "one CLI failure must not empty the directory; got " + JSON.stringify(body));
    assert.strictEqual(body.stale, true, "the response must admit it is stale");
  });

  await test("#160 the preserved directory is not re-emptied on a second failure", async () => {
    global._peersCache = { t: Date.now() - 60000, peers: GOOD_PEERS.slice() };
    await get(handler, "/api/swarm/peers");
    // Force another refresh rather than reading the 30s cache.
    global._peersCache.t = Date.now() - 60000;
    const r = await get(handler, "/api/swarm/peers");
    assert.strictEqual(JSON.parse(r.body).peers.length, 3, "repeated failures must not erode the list");
  });

  await test("#160 staleSince records the FIRST failure, not the latest", async () => {
    global._peersCache = { t: Date.now() - 60000, peers: GOOD_PEERS.slice() };
    await get(handler, "/api/swarm/peers");
    const firstStaleSince = global._peersCache.staleSince;
    assert.ok(firstStaleSince, "staleSince should be set on the first failure");
    global._peersCache.t = Date.now() - 60000;
    await get(handler, "/api/swarm/peers");
    assert.strictEqual(global._peersCache.staleSince, firstStaleSince,
      "staleSince must not advance while the outage continues");
  });

  await test("#160 failure with no prior directory returns empty without crashing", async () => {
    delete global._peersCache;
    const r = await get(handler, "/api/swarm/peers");
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.deepStrictEqual(body.peers, [], "nothing known yet -> empty is honest");
    assert.strictEqual(body.stale, true, "but still flagged, since we could not ask");
  });

  await test("#160 a fresh cache is served untouched and is not marked stale", async () => {
    global._peersCache = { t: Date.now(), peers: GOOD_PEERS.slice() };
    const r = await get(handler, "/api/swarm/peers");
    const body = JSON.parse(r.body);
    assert.strictEqual(body.peers.length, 3);
    assert.strictEqual(body.stale, undefined,
      "a good cache within the 30s window must not carry a stale flag");
  });

  await test("#160 a genuinely empty swarm is still reported as empty", async () => {
    // A successful refresh that legitimately returns no peers must win over
    // the retained list — otherwise this fix would mask a real empty swarm.
    global._peersCache = { t: Date.now(), peers: [] };
    const r = await get(handler, "/api/swarm/peers");
    const body = JSON.parse(r.body);
    assert.deepStrictEqual(body.peers, []);
    assert.strictEqual(body.stale, undefined, "real emptiness is not staleness");
  });

  await test("#160 refresh throttling still applies during an outage", async () => {
    // `t` must advance on failure, or a hard-down binary gets re-spawned on
    // every single request.
    delete global._peersCache;
    await get(handler, "/api/swarm/peers");
    const t1 = global._peersCache.t;
    assert.ok(typeof t1 === "number" && Date.now() - t1 < 30000,
      "failed refresh should still stamp the cache to throttle respawns");
  });

  // ── #137: the public endpoint must not leak operator identity ──
  //
  // /api/swarm/peers is advertised as public in /.well-known/api-catalog and
  // used to return `kannaka swarm peers --json` records verbatim — including
  // the operator's identity.email / identity.user_id. Verified against the
  // real CLI: the local "Kannaka" peer record does carry an identity object.
  await test("#137 identity is stripped from the public peer directory", async () => {
    global._peersCache = { t: Date.now(), peers: [{
      agent_id: "Kannaka",
      display_name: "Kannaka",
      identity: { email: "operator@example.invalid", user_id: "00000000-dead-beef-0000-000000000000" },
      memory_count: 42,
    }] };
    const r = await get(handler, "/api/swarm/peers");
    assert.ok(!r.body.includes("operator@example.invalid"), "email reached the wire: " + r.body);
    assert.ok(!r.body.includes("dead-beef"), "user_id reached the wire: " + r.body);
    assert.ok(!r.body.includes("identity"), "identity object was serialised: " + r.body);
  });

  await test("#137 the useful public fields survive redaction", async () => {
    global._peersCache = { t: Date.now(), peers: [{
      agent_id: "gossipghost-01",
      display_name: "GossipGhost",
      capabilities: { ask: true, dream: true },
      joined_at: "2026-07-28T15:19:24Z",
      last_seen: "2026-07-28T15:19:24Z",
      kannaka_version: "0.11.1",
      memory_count: 25,
      identity: { email: "nope@example.invalid" },
    }] };
    const body = JSON.parse((await get(handler, "/api/swarm/peers")).body);
    const p = body.peers[0];
    assert.strictEqual(p.agent_id, "gossipghost-01");
    assert.strictEqual(p.display_name, "GossipGhost");
    assert.strictEqual(p.memory_count, 25);
    assert.strictEqual(p.kannaka_version, "0.11.1");
    assert.deepStrictEqual(p.capabilities, { ask: true, dream: true });
    assert.strictEqual(p.identity, undefined, "redaction must apply to every record");
  });

  await test("#137 an unknown future field is withheld by default (allowlist, not denylist)", async () => {
    global._peersCache = { t: Date.now(), peers: [{
      agent_id: "future-01",
      some_new_secret_field: "should-not-be-published",
    }] };
    const r = await get(handler, "/api/swarm/peers");
    assert.ok(!r.body.includes("should-not-be-published"),
      "a field the CLI adds later must stay withheld until allowlisted: " + r.body);
    assert.ok(r.body.includes("future-01"), "known fields still pass through");
  });

  delete global._peersCache;

  console.log(`\n${"─".repeat(50)}`);
  console.log(`  Swarm peers cache: ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(50)}`);
  if (failed > 0) process.exit(1);
})();
