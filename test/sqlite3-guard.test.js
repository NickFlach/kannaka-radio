'use strict';

// sqlite3-guard.test.js — #277: a sqlite3 skip guard must FAIL under CI.
//
// `sqlite3` is an optionalDependency and CI runs a bare `npm install`, so a
// failed native build is skipped silently with exit 0. A test that skips when
// the module is missing therefore also skips on CI, and the GhostSignals
// money-path guards stop running while the suite stays green. The helper in
// test/lib/sqlite3-guard.js skips LOCALLY and fails UNDER CI; this test proves
// both branches by running real hub suites in a child process whose module
// loader refuses `sqlite3`.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const guard = require('./lib/sqlite3-guard');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }
console.log('sqlite3-guard.test.js');

// Run a test file with every require of sqlite3 (by any path) made to throw.
function withoutSqlite3(testFile, env) {
  const preload = `
    const Module = require('module');
    const orig = Module._load;
    Module._load = function (request, parent, isMain) {
      if (/(^|[\/])sqlite3$/.test(String(request))) { const e = new Error("Cannot find module '" + request + "' (simulated: optional dep build failed)"); e.code = 'MODULE_NOT_FOUND'; throw e; }
      return orig.apply(this, arguments);
    };
    require(${JSON.stringify(path.join(ROOT, testFile))});
  `;
  const clean = { ...process.env };
  delete clean.CI;
  return spawnSync(process.execPath, ['-e', preload], { cwd: ROOT, env: { ...clean, ...env }, encoding: 'utf8', timeout: 60000 });
}

run('the decision itself: CI → exit 1 naming the suite; local → exit 0 with SKIP; present → proceed', () => {
  const calls = [];
  const io = (haveSqlite3, env) => ({
    haveSqlite3: () => haveSqlite3, env,
    exit: (c) => calls.push(['exit', c]), log: (s) => calls.push(['log', s]), error: (s) => calls.push(['error', s]),
  });
  assert.strictEqual(guard('some-suite', io(true, { CI: '1' })), true);
  assert.deepStrictEqual(calls, [], 'sqlite3 present: no output, no exit');
  guard('some-suite', io(false, { CI: 'true' }));
  assert.deepStrictEqual(calls.map((c) => c[0]), ['error', 'exit']);
  assert.strictEqual(calls[1][1], 1, 'CI without sqlite3 exits 1');
  assert.ok(/some-suite/.test(calls[0][1]) && /sqlite3/.test(calls[0][1]) && /did not run/.test(calls[0][1]), `message names what did not run: ${calls[0][1]}`);
  calls.length = 0;
  guard('some-suite', io(false, {}));
  assert.deepStrictEqual(calls.map((c) => c[0]), ['log', 'exit']);
  assert.strictEqual(calls[1][1], 0, 'local without sqlite3 exits 0');
  assert.ok(/SKIP some-suite/.test(calls[0][1]));
});

run('every suite that opens a GhostSignals database calls the guard before requiring the hub', () => {
  const hubSuites = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => {
      const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
      // Suites that construct a hub AND init() it (open a DB); init-failure and
      // path-resolution suites deliberately do not need sqlite3.
      return /require\(['"]\.\.\/server\/ghostsignals-hub['"]\)/.test(src) && /\.init\(\)/.test(src) && !/gshub-init-failure/.test(f);
    });
  assert.ok(hubSuites.length >= 8, `expected the hub suites to be found, got ${hubSuites.length}`);
  const unguarded = hubSuites.filter((f) => {
    const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
    const g = src.indexOf("require('./lib/sqlite3-guard')");
    const h = src.search(/require\(['"]\.\.\/server\/ghostsignals-hub['"]\)/);
    return g < 0 || g > h;
  });
  assert.deepStrictEqual(unguarded, [], `these open a DB without the #277 guard (or call it after the hub require):\n    ${unguarded.join('\n    ')}`);
});

run('integration: without sqlite3 a hub suite FAILS under CI=1, naming itself', () => {
  const r = withoutSqlite3('test/ghostsignals-ttl-authority.test.js', { CI: '1' });
  assert.strictEqual(r.status, 1, `exit ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok(/FAIL ghostsignals-ttl-authority/.test(r.stderr) && /sqlite3/.test(r.stderr) && /#277/.test(r.stderr),
    `stderr must name the suite and sqlite3: ${r.stderr}`);
});

run('integration: without sqlite3 a hub suite SKIPS locally (exit 0, says so)', () => {
  const r = withoutSqlite3('test/ghostsignals-ttl-authority.test.js', {});
  assert.strictEqual(r.status, 0, `exit ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok(/SKIP ghostsignals-ttl-authority/.test(r.stdout), `stdout must say SKIP: ${r.stdout}`);
  assert.ok(!/OK \(labs market/.test(r.stdout), 'the suite body must not have run');
});

run('integration: with sqlite3 present the same suite runs its assertions (exit 0, its own OK line)', () => {
  assert.ok(guard.haveSqlite3(), 'sqlite3 must be available for this check (it is on CI via npm install)');
  const r = spawnSync(process.execPath, ['test/ghostsignals-ttl-authority.test.js'], { cwd: ROOT, env: { ...process.env, CI: '1' }, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.ok(/ghostsignals-ttl-authority\.test\.js: OK/.test(r.stdout), `suite must actually run: ${r.stdout}`);
  assert.ok(!/SKIP/.test(r.stdout));
});

if (failed) { console.error(`\n${failed} sqlite3-guard test(s) FAILED`); process.exitCode = 1; }
else console.log('\nAll sqlite3-guard tests passed');
