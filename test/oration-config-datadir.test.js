/**
 * oration-config-datadir.test.js — composeViaAnthropicDirect resolves its
 * config.toml from KANNAKA_DATA_DIR, not just ~/.kannaka (#284).
 *
 * The twice-daily peace oration (and the news/gossip fallback path) composes
 * through this helper. Pre-fix it read only os.homedir()/.kannaka/config.toml,
 * so a relocated install with KANNAKA_DATA_DIR set found no api_key and
 * silently returned null — the scheduler ran and the oration never spoke.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const EventEmitter = require("events");

const { composeViaAnthropicDirect } = require("../server/lib/scheduler-helpers");

// ── Stubs ────────────────────────────────────────────────────────────────
// The helper calls os.homedir() and https.request() at call time on the
// shared module objects, so patching those objects redirects it.

const realHomedir = os.homedir;
const realRequest = https.request;

/** Replace https.request with a recorder that answers 200 + fixed text. */
function stubHttps(captured) {
  https.request = (options, cb) => {
    const req = new EventEmitter();
    let body = "";
    req.setTimeout = () => req;
    req.write = (chunk) => { body += chunk; };
    req.end = () => {
      captured.push({ options, body });
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", JSON.stringify({ content: [{ text: "oration text" }] }));
        res.emit("end");
      });
    };
    req.destroy = () => {};
    return req;
  };
}

function writeConfig(dir, apiKey, model) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    `[llm]\napi_key = "${apiKey}"\nmodel = "${model}"\n`,
  );
}

const SAVED_ENV = {};
for (const k of ["ANTHROPIC_API_KEY", "KANNAKA_LLM_API_KEY", "KANNAKA_DATA_DIR"]) {
  SAVED_ENV[k] = process.env[k];
  delete process.env[k];
}

function restoreAll() {
  os.homedir = realHomedir;
  https.request = realRequest;
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let passed = 0;
async function test(name, fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kr-oration-cfg-"));
  const captured = [];
  stubHttps(captured);
  try {
    await fn(scratch, captured);
    passed++;
    console.log(`  ✅ ${name}`);
  } finally {
    os.homedir = realHomedir;
    delete process.env.KANNAKA_DATA_DIR;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

(async () => {
  // The #284 repro: config lives ONLY under KANNAKA_DATA_DIR; the (fake) home
  // has none. Pre-fix this returned null without ever attempting the request.
  await test("#284 config under KANNAKA_DATA_DIR alone is found and used", async (scratch, captured) => {
    const dataDir = path.join(scratch, "data");
    const fakeHome = path.join(scratch, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
    writeConfig(dataDir, "sk-datadir-key", "claude-datadir-model");
    process.env.KANNAKA_DATA_DIR = dataDir;
    os.homedir = () => fakeHome;

    const out = await composeViaAnthropicDirect("say something peaceful", { label: "test" });
    assert.strictEqual(out, "oration text", "compose must succeed from data-dir config");
    assert.strictEqual(captured.length, 1, "exactly one HTTPS attempt expected");
    assert.strictEqual(captured[0].options.headers["x-api-key"], "sk-datadir-key",
      "api_key must come from the KANNAKA_DATA_DIR config");
    assert.strictEqual(JSON.parse(captured[0].body).model, "claude-datadir-model",
      "model must come from the KANNAKA_DATA_DIR config");
  });

  // Precedence: when both configs exist, the data-dir one wins — otherwise a
  // relocated install would silently keep composing with the stale home key.
  await test("KANNAKA_DATA_DIR config wins over ~/.kannaka when both exist", async (scratch, captured) => {
    const dataDir = path.join(scratch, "data");
    const fakeHome = path.join(scratch, "home");
    writeConfig(dataDir, "sk-datadir-key", "claude-datadir-model");
    writeConfig(path.join(fakeHome, ".kannaka"), "sk-home-key", "claude-home-model");
    process.env.KANNAKA_DATA_DIR = dataDir;
    os.homedir = () => fakeHome;

    const out = await composeViaAnthropicDirect("say something peaceful", { label: "test" });
    assert.strictEqual(out, "oration text");
    assert.strictEqual(captured[0].options.headers["x-api-key"], "sk-datadir-key",
      "the data-dir key must win over the home key");
  });

  // No override → the historical ~/.kannaka default still works.
  await test("without KANNAKA_DATA_DIR the ~/.kannaka config is still read", async (scratch, captured) => {
    const fakeHome = path.join(scratch, "home");
    writeConfig(path.join(fakeHome, ".kannaka"), "sk-home-key", "claude-home-model");
    os.homedir = () => fakeHome;

    const out = await composeViaAnthropicDirect("say something peaceful", { label: "test" });
    assert.strictEqual(out, "oration text");
    assert.strictEqual(captured[0].options.headers["x-api-key"], "sk-home-key",
      "the home-dir fallback must survive the data-dir fix");
  });

  // No config anywhere → null, and no request is attempted (key never guessed).
  await test("no config anywhere composes nothing and calls nothing", async (scratch, captured) => {
    const fakeHome = path.join(scratch, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.KANNAKA_DATA_DIR = path.join(scratch, "empty-data");
    os.homedir = () => fakeHome;

    const out = await composeViaAnthropicDirect("say something peaceful", { label: "test" });
    assert.strictEqual(out, null);
    assert.strictEqual(captured.length, 0, "no api_key must mean no HTTPS attempt");
  });

  restoreAll();
  console.log(`\noration-config-datadir: ${passed}/4 passed`);
})().catch((e) => {
  restoreAll();
  console.error(e);
  process.exit(1);
});
