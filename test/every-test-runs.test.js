'use strict';

// every-test-runs.test.js — the guard for a defect this repo keeps having.
//
// `npm test` is a hardcoded `&&` chain of file paths, so a new test file runs
// only if someone remembers to add it there. Nothing enforces that, and the
// failure is silent in the worst direction: CI goes green having never
// executed the test you just wrote, and the PR merges on that green.
//
// It had happened at least three times by 2026-08-24 — mailer.test.js (merged
// the previous night, covering the advertiser mail path), the ghostsignals
// idempotency-budget suite, and both deep-cuts suites, which merged in PR #271
// without CI ever running one of their 21 assertions.
//
// This test compares the files on disk against the files the script names.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const script = pkg.scripts && pkg.scripts.test ? pkg.scripts.test : '';

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('every-test-runs.test.js');

const onDisk = fs.readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => `test/${f}`);
const named = new Set((script.match(/node (test\/[\w.\-]+\.js)/g) || []).map((m) => m.slice(5)));

run('every test file on disk is named by `npm test`', () => {
  const orphans = onDisk.filter((f) => !named.has(f));
  assert.deepStrictEqual(
    orphans, [],
    `these exist but CI never runs them — add them to package.json "test":\n    ${orphans.join('\n    ')}`,
  );
});

run('`npm test` names no file that has been deleted', () => {
  // The other direction: a stale entry makes the whole chain exit non-zero on
  // a missing module, which reads as a broken build rather than a stale list.
  const ghosts = [...named].filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert.deepStrictEqual(ghosts, [], `named in package.json but not on disk:\n    ${ghosts.join('\n    ')}`);
});

run('this guard is itself registered (or it proves nothing)', () => {
  assert.ok(named.has('test/every-test-runs.test.js'),
    'a guard CI does not run is exactly the defect it guards against');
});

if (!failed) console.log(`\nAll every-test-runs tests passed (${onDisk.length} test files, all registered)`);
else process.exitCode = 1;
