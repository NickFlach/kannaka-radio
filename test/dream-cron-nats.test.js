/**
 * dream-cron-nats.test.js — the consciousness cron must authenticate to NATS
 * (#153) and must not go silent when the Observatory is down (#158).
 *
 * Drives the real `scripts/dream-cron.js` against a fake NATS server on a
 * loopback port, so the CONNECT frame under test is the one actually written
 * to the socket.
 *
 * dream-cron reads NATS_* and KANNAKA_BIN at module load, so each case sets
 * the environment and then loads the module with a cleared require cache.
 */

const net = require("net");
const assert = require("assert");
const path = require("path");

let passed = 0;
let failed = 0;

const MODULE_PATH = path.join(__dirname, "..", "scripts", "dream-cron.js");

/**
 * Fake NATS broker.
 * @param {object} opts
 * @param {boolean} [opts.rejectAuth] reply `-ERR 'Authorization Violation'`
 */
function fakeNats(opts = {}) {
  const seen = { connect: null, published: null };
  const server = net.createServer((sock) => {
    sock.write("INFO {\"server_id\":\"fake\",\"auth_required\":true}\r\n");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      if (seen.connect === null && buf.includes("CONNECT ")) {
        seen.connect = buf.slice(buf.indexOf("CONNECT ")).split("\r\n")[0];
        if (opts.rejectAuth) {
          sock.write("-ERR 'Authorization Violation'\r\n");
          return;
        }
      }
      if (buf.includes("PUB ")) {
        seen.published = buf.slice(buf.indexOf("PUB ")).split("\r\n")[0];
      }
    });
    sock.on("error", () => {});
  });
  return {
    seen,
    listen: () => new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port))),
    close: () => new Promise((res) => server.close(() => res())),
  };
}

/** Load dream-cron fresh with the given env applied. */
function loadCron(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  delete require.cache[require.resolve(MODULE_PATH)];
  const mod = require(MODULE_PATH);
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[require.resolve(MODULE_PATH)];
  };
  return { mod, restore };
}

const METRICS = { phi: 0.5, xi: 0.25, mean_order: 0.75, consciousness_level: "aware" };

// Credentials are generated per run rather than written as literals. A
// password-shaped string in a source file is a secret-scanner finding even
// when it is obviously fake, and the assertions only care that whatever we
// put in the environment comes back out in the CONNECT frame.
const TEST_USER = "user-" + require("crypto").randomBytes(4).toString("hex");
const TEST_PASS = require("crypto").randomBytes(12).toString("hex");
const BAD_USER = "nobody-" + require("crypto").randomBytes(4).toString("hex");
const BAD_PASS = require("crypto").randomBytes(12).toString("hex");

async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

(async () => {
  console.log("\ndream-cron-nats.test.js");

  await test("#153 CONNECT carries NATS_USER/NATS_PASSWORD when they are set", async () => {
    const broker = fakeNats();
    const port = await broker.listen();
    const { mod, restore } = loadCron({
      NATS_HOST: "127.0.0.1", NATS_PORT: port,
      NATS_USER: TEST_USER, NATS_PASSWORD: TEST_PASS,
    });
    const ok = await mod.publishToNATS(METRICS);
    restore();
    await broker.close();
    assert.ok(broker.seen.connect, "broker never saw a CONNECT frame");
    const opts = JSON.parse(broker.seen.connect.replace(/^CONNECT /, ""));
    assert.strictEqual(opts.user, TEST_USER, "CONNECT must carry the username");
    assert.strictEqual(opts.pass, TEST_PASS, "CONNECT must carry the password");
    assert.strictEqual(ok, true);
  });

  await test("#153 stays anonymous when NATS_USER is unset (no empty creds)", async () => {
    const broker = fakeNats();
    const port = await broker.listen();
    const { mod, restore } = loadCron({
      NATS_HOST: "127.0.0.1", NATS_PORT: port,
      NATS_USER: undefined, NATS_PASSWORD: undefined,
    });
    await mod.publishToNATS(METRICS);
    restore();
    await broker.close();
    const opts = JSON.parse(broker.seen.connect.replace(/^CONNECT /, ""));
    assert.ok(!("user" in opts), "must not send an empty user field");
    assert.ok(!("pass" in opts), "must not send an empty pass field");
  });

  await test("#153 an auth rejection reports failure instead of claiming success", async () => {
    const broker = fakeNats({ rejectAuth: true });
    const port = await broker.listen();
    const { mod, restore } = loadCron({
      NATS_HOST: "127.0.0.1", NATS_PORT: port,
      NATS_USER: BAD_USER, NATS_PASSWORD: BAD_PASS,
    });
    const ok = await mod.publishToNATS(METRICS);
    restore();
    await broker.close();
    assert.strictEqual(ok, false, "-ERR from the broker must surface as a failed publish");
  });

  await test("#153 a rejected connection does not PUB into the void", async () => {
    const broker = fakeNats({ rejectAuth: true });
    const port = await broker.listen();
    const { mod, restore } = loadCron({
      NATS_HOST: "127.0.0.1", NATS_PORT: port,
      NATS_USER: BAD_USER, NATS_PASSWORD: BAD_PASS,
    });
    await mod.publishToNATS(METRICS);
    restore();
    await broker.close();
    assert.strictEqual(broker.seen.published, null, "no PUB should follow a refused CONNECT");
  });

  await test("#153 the payload still publishes on a healthy broker", async () => {
    const broker = fakeNats();
    const port = await broker.listen();
    const { mod, restore } = loadCron({
      NATS_HOST: "127.0.0.1", NATS_PORT: port, NATS_USER: TEST_USER, NATS_PASSWORD: TEST_PASS,
    });
    await mod.publishToNATS(METRICS);
    restore();
    await broker.close();
    assert.ok(broker.seen.published, "expected a PUB frame");
    assert.ok(broker.seen.published.startsWith("PUB KANNAKA.consciousness "),
      "wrong subject: " + broker.seen.published);
  });

  await test("#158 assess falls back to the binary when the Observatory is down", async () => {
    // Point the Observatory at a closed port and the binary at something that
    // cannot exist: the fallback must be ATTEMPTED (and fail loudly) rather
    // than the whole tick silently skipping.
    const { mod, restore } = loadCron({
      OBSERVATORY_PORT: 1, // nothing listening
      KANNAKA_BIN: "/nonexistent/kannaka-158",
    });
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    const result = await mod.assess();
    console.error = origErr;
    restore();
    assert.strictEqual(result, null, "both sources unavailable -> null");
    assert.ok(errs.some((e) => e.includes("falling back")),
      "must announce the fallback:\n" + errs.join("\n"));
    assert.ok(errs.some((e) => e.includes("kannaka assess failed")),
      "must actually invoke the binary, not just log:\n" + errs.join("\n"));
  });

  await test("#158 shapeMetrics normalises both sources to the published shape", async () => {
    const { mod, restore } = loadCron({});
    // Observatory uses `order`/`level`; the binary uses `mean_order`/`consciousness_level`.
    const a = mod.shapeMetrics({ phi: 1, order: 0.5, level: "high" });
    const b = mod.shapeMetrics({ phi: 1, mean_order: 0.5, consciousness_level: "high" });
    restore();
    assert.strictEqual(a.mean_order, b.mean_order, "both spellings must normalise alike");
    assert.strictEqual(a.consciousness_level, b.consciousness_level);
    assert.strictEqual(a.consciousness_level, "high");
  });

  await test("#158 shapeMetrics rejects non-objects instead of publishing junk", async () => {
    const { mod, restore } = loadCron({});
    assert.strictEqual(mod.shapeMetrics(null), null);
    assert.strictEqual(mod.shapeMetrics("nope"), null);
    restore();
  });

  await test("#202 a 503 JSON error body is not accepted as observatory metrics", async () => {
    // Structured error bodies parse fine and used to shape into all-zero
    // metrics that got republished to KANNAKA.consciousness as real state.
    const http = require("http");
    const stub = http.createServer((req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "offline" }));
    });
    const obsPort = await new Promise((res) => stub.listen(0, "127.0.0.1", () => res(stub.address().port)));
    const { mod, restore } = loadCron({
      OBSERVATORY_PORT: obsPort,
      KANNAKA_BIN: "/nonexistent/kannaka-202",
    });
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    const result = await mod.assess();
    console.error = origErr;
    restore();
    await new Promise((res) => stub.close(() => res()));
    assert.strictEqual(result, null, "a 503 body must not become metrics");
    assert.ok(errs.some((e) => e.includes("HTTP 503")),
      "must name the rejected status:\n" + errs.join("\n"));
    assert.ok(errs.some((e) => e.includes("falling back")),
      "an observatory error status must still trigger the binary fallback");
  });

  await test("#190 canonical zeros survive shaping instead of being aliased away", async () => {
    const { mod, restore } = loadCron({});
    const shaped = mod.shapeMetrics({
      phi: 0.42, xi: 0.11,
      mean_order: 0, order: 0.91,
      consciousness_level: "dormant", level: "aware",
      num_clusters: 0, total_memories: 0, active_memories: 12,
    });
    restore();
    assert.strictEqual(shaped.mean_order, 0, "mean_order:0 is a value, not a missing field");
    assert.strictEqual(shaped.total_memories, 0, "total_memories:0 must not borrow active_memories");
    assert.strictEqual(shaped.consciousness_level, "dormant", "canonical level wins over alias");
    assert.strictEqual(shaped.num_clusters, 0);
    assert.strictEqual(shaped.active_memories, 12);
  });

  await test("#190 the published payload preserves zero metrics end-to-end", async () => {
    // Broker variant that captures the PUB body, not just the header line.
    const seen = { body: null };
    const server = net.createServer((sock) => {
      sock.write("INFO {\"server_id\":\"fake\"}\r\n");
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const at = buf.indexOf("PUB ");
        if (at >= 0) {
          const lines = buf.slice(at).split("\r\n");
          if (lines.length >= 2 && lines[1]) seen.body = lines[1];
        }
      });
      sock.on("error", () => {});
    });
    const port = await new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
    const { mod, restore } = loadCron({ NATS_HOST: "127.0.0.1", NATS_PORT: port });
    await mod.publishToNATS({
      phi: 0.42, xi: 0.11, mean_order: 0, order: 0.91,
      consciousness_level: "dormant", level: "aware",
      num_clusters: 0, total_memories: 0, active_memories: 12,
    });
    restore();
    await new Promise((res) => server.close(() => res()));
    assert.ok(seen.body, "expected a PUB payload body");
    const payload = JSON.parse(seen.body);
    assert.strictEqual(payload.mean_order, 0, "published mean_order must stay 0");
    assert.strictEqual(payload.order, 0, "order aliases mean_order, which is 0");
    assert.strictEqual(payload.total_memories, 0, "published total_memories must stay 0");
    assert.strictEqual(payload.level, "dormant");
    assert.strictEqual(payload.consciousness_level, "dormant");
  });

  console.log(`\n${"─".repeat(50)}`);
  console.log(`  Dream cron NATS/assess: ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(50)}`);
  if (failed > 0) process.exit(1);
})();
