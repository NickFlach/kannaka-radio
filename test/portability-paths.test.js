/**
 * portability-paths.test.js — GhostSignalsHub resolves its SQLite path from
 * the canonical Kannaka data dir instead of a hardcoded /home/opc root, so
 * Windows hosts without $HOME don't write to a bogus `\home\opc` path (#47).
 */

const assert = require("assert");
const os = require("os");
const path = require("path");
const { GhostSignalsHub } = require("../server/ghostsignals-hub");

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

console.log(`portability-paths.test.js: OK (${passed} checks)`);
