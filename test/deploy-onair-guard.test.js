/**
 * deploy-onair-guard.test.js
 *
 * A `systemctl restart` during a scheduled show ends it, and the slot does
 * NOT resume — the show triggers only fire at minute :00. On 2026-08-24 a
 * deploy at 09:01 killed the 9 AM drama 70 seconds into the episode.
 *
 * Two halves, because either one alone is useless:
 *   1. /api/on-air must tell the truth about what's playing.
 *   2. deploy-oracle.sh must actually consult it, BEFORE it restarts.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

let failures = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
  });
}

// ── 1. /api/on-air tells the truth ───────────────────────────────────

/** Boot routes.js with stub deps and GET one path. */
function withServer(deps, pathname) {
  const base = {
    djEngine: {
      state: { channel: "dj", playlist: [], playlistMeta: [], history: [],
               currentAlbum: "REEF", currentTrackIdx: 0 },
      getState: () => ({}),
    },
    config: { getMusicDir: () => __dirname, getListenerCount: () => 0 },
    broadcast: () => {}, nats: null, perception: null, flux: null,
    live: { state: {} }, voiceDJ: {}, syncManager: null, voteManager: null,
    webrtcSignaling: null, musicGen: null, floor: null, gsHub: null,
    adStore: null, adPayments: null, adBridge: null, gsa: null,
  };
  const merged = Object.assign(base, deps);
  const handler = require("../server/routes")(merged);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler).listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${srv.address().port}${pathname}`);
        const body = await r.json();
        srv.close(() => resolve({ status: r.status, body }));
      } catch (e) { srv.close(() => reject(e)); }
    });
  });
}

const idle = { getStatus: () => ({ podcastPlaying: false }) };
const airing = { getStatus: () => ({ podcastPlaying: true }) };

check("a clear station reports onAir:false", async () => {
  const { status, body } = await withServer(
    { podcastScheduler: idle, tsofScheduler: idle }, "/api/on-air");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.onAir, false);
});

check("a live drama episode reports onAir with the show's name", async () => {
  const djEngine = {
    state: { channel: "dj", currentAlbum: "The Story of Flaukowski", currentTrackIdx: 0,
             playlist: [], history: [],
             playlistMeta: [{ title: "[PODCAST] TSOF-E05-Yamibane", isPodcastScheduled: true }] },
    getState: () => ({}),
  };
  const { body } = await withServer(
    { djEngine, podcastScheduler: idle, tsofScheduler: airing }, "/api/on-air");
  assert.strictEqual(body.onAir, true);
  assert.strictEqual(body.kind, "show");
  assert.strictEqual(body.label, "The Story of Flaukowski");
  assert.strictEqual(body.nowPlaying, "[PODCAST] TSOF-E05-Yamibane");
});

check("the podcast is named too, not just the drama", async () => {
  const { body } = await withServer(
    { podcastScheduler: airing, tsofScheduler: idle }, "/api/on-air");
  assert.strictEqual(body.onAir, true);
  assert.strictEqual(body.label, "Ghost Signals Podcast");
});

check("a locked album showcase counts as on air", async () => {
  const until = Date.now() + 20 * 60 * 1000;
  const { body } = await withServer({
    podcastScheduler: idle, tsofScheduler: idle,
    programming: { getStatus: () => ({ override: { album: "SEVEN PORTALS", until } }) },
  }, "/api/on-air");
  assert.strictEqual(body.onAir, true);
  assert.strictEqual(body.kind, "showcase");
  assert.strictEqual(body.label, "SEVEN PORTALS");
  assert.strictEqual(body.until, new Date(until).toISOString());
});

check("an EXPIRED showcase override does not block", async () => {
  const { body } = await withServer({
    podcastScheduler: idle, tsofScheduler: idle,
    programming: { getStatus: () => ({ override: { album: "SEVEN PORTALS", until: Date.now() - 1000 } }) },
  }, "/api/on-air");
  assert.strictEqual(body.onAir, false);
});

check("a scheduler that throws is not read as 'on air'", async () => {
  // A broken scheduler must not wedge deploys forever.
  const { body } = await withServer({
    podcastScheduler: { getStatus: () => { throw new Error("boom"); } },
    tsofScheduler: idle,
  }, "/api/on-air");
  assert.strictEqual(body.onAir, false);
});

// ── 2. the deploy script actually consults it, before restarting ─────

const SCRIPT = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "deploy-oracle.sh"), "utf8");

check("the on-air check runs BEFORE the restart and before moving HEAD", () => {
  const guard = SCRIPT.indexOf("/api/on-air");
  const ff = SCRIPT.indexOf("git merge --ff-only");
  const restart = SCRIPT.indexOf('systemctl restart "$RADIO_UNIT"');
  assert.notStrictEqual(guard, -1, "the deploy never queries /api/on-air");
  assert.notStrictEqual(ff, -1, "no fast-forward step found");
  assert.notStrictEqual(restart, -1, "no restart step found");
  assert.ok(guard < ff,
    "the on-air check must precede the fast-forward, or a refused deploy leaves the checkout ahead of the running service");
  assert.ok(guard < restart, "the on-air check must precede the restart");
});

check("an on-air station refuses the deploy with a non-zero exit", () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("on-air check"), SCRIPT.indexOf("Record the rollback point"));
  assert.ok(/onAir":true/.test(block), "nothing matches the on-air response");
  assert.ok(/exit 3/.test(block), "refusal does not exit non-zero");
  assert.ok(/--force/.test(block), "the refusal never mentions the escape hatch");
});

check("--force is parsed and reaches the remote shell", () => {
  assert.ok(/--force\)\s*FORCE=1/.test(SCRIPT), "--force is not parsed");
  assert.ok(/FORCE='\$FORCE'/.test(SCRIPT), "FORCE is not passed into the remote env");
  assert.ok(/if \[ "\$FORCE" = "1" \]/.test(SCRIPT), "the remote block never honours FORCE");
});

check("a build without /api/on-air still can't be deployed over a live show", () => {
  // The fallback is the whole reason this guard isn't self-defeating on its
  // own first deploy: the running service predates the endpoint.
  const block = SCRIPT.slice(SCRIPT.indexOf("on-air check"), SCRIPT.indexOf("Record the rollback point"));
  assert.ok(/now-playing/.test(block), "no fallback for builds predating /api/on-air");
  assert.ok(/PODCAST/.test(block), "the fallback doesn't look for the scheduler's track marker");
  const fallbackRefusal = block.slice(block.indexOf("now-playing"));
  assert.ok(/exit 3/.test(fallbackRefusal), "the fallback detects a show but doesn't refuse");
});

check("the script is syntactically valid bash", () => {
  const { execFileSync } = require("child_process");
  execFileSync("bash", ["-n", path.join(__dirname, "..", "scripts", "deploy-oracle.sh")]);
});

// ── 3. RUN the guard, don't just read it ─────────────────────────────
//
// Everything above this line about the shell is a source-pattern check,
// and a source-pattern check passes for any script that merely contains
// the right words in the right order. These run the real extracted block
// against a stub `curl` and assert on its exit code.

const { execFileSync, spawnSync } = require("child_process");
const os = require("os");

/** The real on-air block, lifted verbatim out of deploy-oracle.sh. */
function guardBlock() {
  const start = SCRIPT.indexOf('if [ "$FORCE" = "1" ]; then');
  const end = SCRIPT.indexOf("# ── Record the rollback point");
  assert.ok(start !== -1 && end > start, "could not locate the on-air block");
  return SCRIPT.slice(start, end).trim();
}

/**
 * Run the guard with `curl` stubbed to return `responses[url-substring]`.
 * An empty string models an unreachable endpoint (curl's `|| true`).
 */
function runGuard(force, responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onair-"));
  const cases = Object.entries(responses)
    .map(([frag, body]) => `  *${frag}*) printf '%s' ${JSON.stringify(body)}; [ -n ${JSON.stringify(body)} ] || exit 7 ;;`)
    .join("\n");
  fs.writeFileSync(path.join(dir, "curl"),
    `#!/usr/bin/env bash\nurl="\${@: -1}"\ncase "$url" in\n${cases}\n  *) exit 7 ;;\nesac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "run.sh"),
    `set -euo pipefail\nFORCE='${force}'\n` + guardBlock() + "\n");
  const r = spawnSync("bash", [path.join(dir, "run.sh")], {
    env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

check("RUN: a live show makes the guard exit 3", () => {
  const r = runGuard(0, {
    "on-air": '{"onAir":true,"kind":"show","label":"The Story of Flaukowski"}',
    "now-playing": '{"title":"[PODCAST] TSOF-E05-Yamibane"}',
  });
  assert.strictEqual(r.code, 3, `expected refusal (3), got ${r.code}\n${r.out}`);
  assert.ok(/refused/i.test(r.out), `refusal not explained:\n${r.out}`);
});

check("RUN: a clear station lets the deploy through", () => {
  const r = runGuard(0, {
    "on-air": '{"onAir":false}',
    "now-playing": '{"title":"Smoke Bomb Bloom","album":"SEVEN PORTALS"}',
  });
  assert.strictEqual(r.code, 0, `expected pass (0), got ${r.code}\n${r.out}`);
});

check("RUN: --force deploys over a live show", () => {
  const r = runGuard(1, {
    "on-air": '{"onAir":true,"kind":"show","label":"The Story of Flaukowski"}',
    "now-playing": '{"title":"[PODCAST] TSOF-E05-Yamibane"}',
  });
  assert.strictEqual(r.code, 0, `--force should override the guard, got ${r.code}\n${r.out}`);
});

check("RUN: an old build mid-episode is caught by the fallback", () => {
  // /api/on-air 404s (the running service predates it) but a show IS on.
  const r = runGuard(0, {
    "on-air": "",
    "now-playing": '{"title":"[PODCAST] TSOF-E05-Yamibane"}',
  });
  assert.strictEqual(r.code, 3, `fallback failed to refuse, got ${r.code}\n${r.out}`);
});

check("RUN: an old build with music playing still deploys", () => {
  const r = runGuard(0, {
    "on-air": "",
    "now-playing": '{"title":"Smoke Bomb Bloom","album":"SEVEN PORTALS"}',
  });
  assert.strictEqual(r.code, 0, `expected pass (0), got ${r.code}\n${r.out}`);
});

check("RUN: a dead service deploys (a restart is the remedy, not the hazard)", () => {
  const r = runGuard(0, { "on-air": "", "now-playing": "" });
  assert.strictEqual(r.code, 0, `expected pass (0), got ${r.code}\n${r.out}`);
  assert.ok(/not answering/i.test(r.out), `the reason wasn't stated:\n${r.out}`);
});

(async () => {
  for (const run of queue) await run();
  if (failures) {
    console.error(`\n${failures} of ${queue.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\nall ${queue.length} checks passed`);
})();
