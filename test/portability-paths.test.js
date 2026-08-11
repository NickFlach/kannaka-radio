/**
 * portability-paths.test.js — GhostSignalsHub resolves its SQLite path from
 * the canonical Kannaka data dir instead of a hardcoded /home/opc root, so
 * Windows hosts without $HOME don't write to a bogus `\home\opc` path (#47).
 */

const assert = require("assert");
const os = require("os");
const path = require("path");
const { GhostSignalsHub } = require("../server/ghostsignals-hub");
const { DJEngine, resolveOrcStemSource } = require("../server/dj-engine");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✅ ${name}`);
}

// Default: under ~/.kannaka via os.homedir(), never a bare /home/opc leak.
check("default dbPath lives under the user home .kannaka dir", () => {
  const saved = process.env.KANNAKA_DATA_DIR;
  delete process.env.KANNAKA_DATA_DIR;
  try {
    const hub = new GhostSignalsHub();
    assert.strictEqual(
      hub.dbPath,
      path.join(os.homedir(), ".kannaka", "ghostsignals.db"),
      "default should be <home>/.kannaka/ghostsignals.db"
    );
    // The old bug produced `\home\opc\...` on Windows; guard against regressing.
    assert.ok(
      hub.dbPath.startsWith(os.homedir()),
      "dbPath must be rooted at the resolved home dir, not a hardcoded /home/opc"
    );
  } finally {
    if (saved === undefined) delete process.env.KANNAKA_DATA_DIR;
    else process.env.KANNAKA_DATA_DIR = saved;
  }
});

// KANNAKA_DATA_DIR wins so state lands in the constellation's canonical dir.
check("KANNAKA_DATA_DIR overrides the default data dir", () => {
  const saved = process.env.KANNAKA_DATA_DIR;
  const dir = path.join(os.tmpdir(), "kr-kannaka-data-test");
  process.env.KANNAKA_DATA_DIR = dir;
  try {
    const hub = new GhostSignalsHub();
    assert.strictEqual(hub.dbPath, path.join(dir, "ghostsignals.db"));
  } finally {
    if (saved === undefined) delete process.env.KANNAKA_DATA_DIR;
    else process.env.KANNAKA_DATA_DIR = saved;
  }
});

// Explicit opts.dbPath always wins (embedding / test usage).
check("explicit opts.dbPath wins over env and defaults", () => {
  const hub = new GhostSignalsHub({ dbPath: "/custom/location/gs.db" });
  assert.strictEqual(hub.dbPath, "/custom/location/gs.db");
});

// ── ORC stem catalog — same anti-pattern, second offender (#228) ─────────
//
// The ORC channel resolved its SQLite catalog from a hardcoded
// /home/opc/open-resonance-collective/... path, so it could only ever find
// stems on one box. The sibling-checkout default has to be provably identical
// on Oracle, or this "portability fix" would be a silent production outage.

check("ORC catalog defaults to a sibling stem-server checkout, not /home/opc", () => {
  const r = resolveOrcStemSource({}, path.join(os.homedir(), "Source", "kannaka-radio"));
  assert.strictEqual(
    r.dbPath,
    path.join(os.homedir(), "Source", "open-resonance-collective",
      "packages", "stem-server", "data", "stems.db"),
    "catalog should sit beside the radio checkout"
  );
  assert.strictEqual(r.source, "sibling-checkout");
  assert.ok(!r.dbPath.includes(path.join("home", "opc")),
    "the Oracle-absolute root must not survive as a default");
});

check("the sibling default reproduces the old Oracle path exactly", () => {
  // The radio runs from /home/opc/kannaka-radio there
  // (ops/oracle/run-radio.sh.example), so the sibling default resolves to the
  // very string it replaces. If this ever stops holding, the live station
  // loses its stem catalog silently — the channel just goes quiet.
  const r = resolveOrcStemSource({}, "/home/opc/kannaka-radio");
  const posix = (p) => path.resolve(p).split(path.sep).join("/");
  assert.ok(
    posix(r.dbPath).endsWith(
      "/home/opc/open-resonance-collective/packages/stem-server/data/stems.db"),
    `Oracle layout must resolve to the historical path, got ${r.dbPath}`
  );
  assert.ok(
    posix(r.sqlite3Path).endsWith(
      "/home/opc/open-resonance-collective/packages/stem-server/node_modules/sqlite3"),
    `sqlite3 module path drifted: ${r.sqlite3Path}`
  );
});

check("ORC_STEM_SERVER_ROOT retargets both the catalog and the sqlite3 build", () => {
  const r = resolveOrcStemSource({ ORC_STEM_SERVER_ROOT: "/srv/orc" });
  assert.strictEqual(r.dbPath, path.join("/srv/orc", "data", "stems.db"));
  assert.strictEqual(r.sqlite3Path, path.join("/srv/orc", "node_modules", "sqlite3"));
  assert.strictEqual(r.source, "env");
});

check("the specific ORC_STEM_DB / ORC_SQLITE3_PATH knobs still win", () => {
  // Back-compat: these already existed (#70) and may be set on the box.
  const r = resolveOrcStemSource({
    ORC_STEM_SERVER_ROOT: "/srv/orc",
    ORC_STEM_DB: "/explicit/stems.db",
    ORC_SQLITE3_PATH: "/explicit/sqlite3",
  });
  assert.strictEqual(r.dbPath, "/explicit/stems.db", "the file knob outranks the root");
  assert.strictEqual(r.sqlite3Path, "/explicit/sqlite3");
});

check("a blank ORC env var does not shadow the default", () => {
  const r = resolveOrcStemSource({ ORC_STEM_SERVER_ROOT: "   ", ORC_STEM_DB: "" },
    path.join(os.homedir(), "Source", "kannaka-radio"));
  assert.strictEqual(r.source, "sibling-checkout", "an empty env var is not configuration");
  assert.ok(r.dbPath.endsWith(path.join("stem-server", "data", "stems.db")));
});

// The last check is asynchronous, and `check` above is not — it would count a
// pass the moment the promise was CREATED. Awaited explicitly instead, behind
// a pessimistic exit code so a runner that never reaches the summary fails
// rather than exiting 0 with the assertions unobserved.
process.exitCode = 1;

(async () => {
  // ORC is one channel of many; an absent stem-server must not take the
  // engine down, and _buildOrcChannel only ever sees a resolved promise.
  const saved = process.env.ORC_STEM_DB;
  process.env.ORC_STEM_DB = path.join(os.tmpdir(), "definitely-absent-stems.db");
  try {
    const dj = new DJEngine({ getMusicDir: () => path.join(os.tmpdir(), "no-music") });
    const p = dj._fetchOrcStems();
    assert.ok(p && typeof p.then === "function", "_fetchOrcStems must return a promise");
    const rows = await p;
    assert.deepStrictEqual(rows, [], "a missing catalog yields an empty stem list");
    passed++;
    console.log("  ✅ a missing catalog is a resolved skip, never a throw or a hang");
  } finally {
    if (saved === undefined) delete process.env.ORC_STEM_DB;
    else process.env.ORC_STEM_DB = saved;
  }

  console.log(`portability-paths.test.js: OK (${passed} checks)`);
  process.exitCode = 0;
})();
