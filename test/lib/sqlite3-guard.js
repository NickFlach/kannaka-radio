'use strict';

// sqlite3-guard.js — "not applicable here" must stay distinguishable from
// "silently not tested" (#277).
//
// `sqlite3` is an optionalDependency and CI runs a bare `npm install`, so a
// native build failure is skipped with a zero exit. A test that merely skips
// when the module is missing would therefore also skip ON CI, turning the
// GhostSignals money-path guards off while the suite stays green. So:
//
//   - locally without sqlite3: print SKIP and exit 0 (developer convenience),
//   - under CI without sqlite3: print what did not run and exit 1,
//   - with sqlite3 present: return true and do nothing.
//
// Every GhostSignals suite that opens a database calls this first, naming
// itself, so the CI failure says exactly which guards were not exercised.

const Module = require('module');

function haveSqlite3() {
  // Mirror ghostsignals-hub.js loadSqlite3(): the shared stem-server install
  // first, then the radio's own. Resolve via the hub's directory so the check
  // finds the same module the code under test will.
  const hubFile = require('path').join(__dirname, '..', '..', 'server', 'ghostsignals-hub.js');
  const hubRequire = Module.createRequire(hubFile);
  const tries = ['/home/opc/open-resonance-collective/packages/stem-server/node_modules/sqlite3', 'sqlite3'];
  for (const p of tries) {
    try { hubRequire(p); return true; } catch (_) { /* next */ }
  }
  return false;
}

/**
 * @param {string} testName  the suite calling, for the CI failure message
 * @param {object} [io]      injectable for the guard's own test
 * @returns {boolean} true when sqlite3 is available (the caller proceeds)
 */
function requireSqlite3OrSkip(testName, io = {}) {
  const have = io.haveSqlite3 ? io.haveSqlite3() : haveSqlite3();
  if (have) return true;
  const env = io.env || process.env;
  const exit = io.exit || ((code) => process.exit(code));
  const log = io.log || ((s) => console.log(s));
  const error = io.error || ((s) => console.error(s));
  if (env.CI) {
    error(`FAIL ${testName}: sqlite3 is unavailable on CI — the guards in test/${testName}.test.js did not run (#277)`);
    exit(1);
  } else {
    log(`SKIP ${testName} — sqlite3 not available locally (would FAIL under CI=1, see #277)`);
    exit(0);
  }
  return false;
}

module.exports = requireSqlite3OrSkip;
module.exports.haveSqlite3 = haveSqlite3;
