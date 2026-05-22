/**
 * routes-discoverability.test.js — verify robots/sitemap/api-catalog/oauth
 * surfaces advertise the requesting origin, not the production hardcoded
 * `radio.ninja-portal.com`.
 *
 * Spins the routes module up against fake deps and hits each surface with
 * synthetic Host / X-Forwarded-* headers.
 */

const http = require("http");
const assert = require("assert");
const setupRoutes = require("../server/routes");

function noop() {}
function fakeEngine() {
  return {
    state: { trackStartedAt: Date.now(), currentTrackIdx: 0 },
    getNowPlaying: () => ({ title: "Test", album: "Tests", file: "t.mp3" }),
    getSchedule: () => [],
    getPlaylist: () => [],
    getRecentHistory: () => [],
    getCurrentBlock: () => "Test Block",
    advance: noop,
    jumpToTrack: noop,
    skipBy: noop,
  };
}
function fakeFlux() { return { publish: noop, publishMemoryStored: noop, publishDreamCompleted: noop }; }
function fakeNats() { return { connected: false, publish: noop }; }
function fakeLive() { return { isLive: () => false }; }
function fakeVoiceDJ() { return { speak: noop, synthesizeIntro: noop }; }
function fakeFloor() {
  return {
    addReaction: noop,
    countListeners: () => 0,
    snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }),
  };
}
function fakeConfig() {
  return {
    spaPath: __dirname,
    getMusicDir: () => "/tmp/music-test",
    musicDir: "/tmp/music-test",
  };
}

function makeHandler() {
  return setupRoutes({
    djEngine: fakeEngine(),
    perception: { perceive: noop, getHistory: () => [] },
    nats: fakeNats(),
    flux: fakeFlux(),
    live: fakeLive(),
    voiceDJ: fakeVoiceDJ(),
    syncManager: { broadcast: noop },
    voteManager: { snapshot: () => ({}) },
    webrtcSignaling: { handle: noop },
    musicGen: { generate: noop },
    broadcast: noop,
    floor: fakeFloor(),
    config: fakeConfig(),
    gsHub: null,
  });
}

function get(handler, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      http.get({ host: "127.0.0.1", port, path: url, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          server.close();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      }).on("error", (e) => { server.close(); reject(e); });
    });
  });
}

(async () => {
  const handler = makeHandler();

  // sitemap.xml under a non-production Host header
  let r = await get(handler, "/sitemap.xml", { host: "staging.example:7777" });
  assert.strictEqual(r.status, 200, "sitemap status");
  assert.ok(r.body.includes("http://staging.example:7777/"),
    "sitemap should advertise the requesting origin\n" + r.body.slice(0, 400));
  assert.ok(!r.body.includes("radio.ninja-portal.com"),
    "sitemap should NOT hardcode radio.ninja-portal.com\n" + r.body.slice(0, 400));

  // api-catalog under x-forwarded-proto/host (simulates nginx)
  r = await get(handler, "/.well-known/api-catalog", {
    host: "internal.lan:8888",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "edge.example",
  });
  assert.strictEqual(r.status, 200, "api-catalog status");
  assert.ok(r.body.includes("https://edge.example/"),
    "api-catalog should honor x-forwarded-* headers\n" + r.body.slice(0, 400));
  assert.ok(!r.body.includes("radio.ninja-portal.com"),
    "api-catalog should NOT hardcode the production host (excluding the NATS URL)" +
    "\n" + r.body.slice(0, 600));

  // oauth discovery
  r = await get(handler, "/.well-known/oauth-authorization-server", {
    host: "preview.local:3000",
  });
  assert.strictEqual(r.status, 200, "oauth status");
  const oauth = JSON.parse(r.body);
  assert.strictEqual(oauth.issuer, "http://preview.local:3000", "oauth issuer should be request origin");
  assert.ok(oauth.service_documentation.startsWith("http://preview.local:3000/"),
    "oauth service_documentation should be on request origin");

  // RADIO_PUBLIC_URL env override wins
  process.env.RADIO_PUBLIC_URL = "https://override.example";
  const handler2 = makeHandler();
  r = await get(handler2, "/sitemap.xml", { host: "should-be-ignored.test" });
  assert.ok(r.body.includes("https://override.example/"),
    "RADIO_PUBLIC_URL env should override request host");
  assert.ok(!r.body.includes("should-be-ignored.test"),
    "request host should be ignored when env override is set");
  delete process.env.RADIO_PUBLIC_URL;

  console.log("routes-discoverability.test.js: OK (4 surfaces verified)");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
