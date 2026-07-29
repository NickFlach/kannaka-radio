'use strict';

// disk-space.test.js — the radio must notice its own disk pressure (#36).
//
// The 2026-05-19 incident: root disk hit 100% (0 KB of 30 GB) because 12,779
// TTS intro files accumulated since March with nothing pruning them. It filled
// silently for WEEKS; the first symptom was scp failing.
//
// prune-cron now deletes old voice chunks, so the leak is fixed. This covers
// the second line of defense the issue asks for — for when the CRON stops
// running. A cron that silently stops looks identical to a cron with nothing to
// do, which is exactly why the incident lasted weeks.

const assert = require('assert');
const {
  diskUsage,
  classifyUsage,
  usageReport,
  formatBytes,
  DEFAULT_WARN_PCT,
  DEFAULT_CRITICAL_PCT,
} = require('../server/disk-space');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed++; }
}

// ── real reading ────────────────────────────────────────────

run('#36 reads real usage for an existing path', () => {
  const u = diskUsage(process.cwd());
  assert.ok(u, 'expected a reading for cwd');
  assert.ok(u.totalBytes > 0, 'total must be positive');
  assert.ok(u.freeBytes >= 0);
  assert.ok(u.usedPct >= 0 && u.usedPct <= 100, `usedPct out of range: ${u.usedPct}`);
});

run('#36 returns null instead of throwing on a bad path', () => {
  // Diagnostics must never be the thing that crashes the caller.
  assert.strictEqual(diskUsage('/definitely/not/a/real/mount/point/xyzzy'), null);
});

// ── classification ──────────────────────────────────────────

const usage = (usedPct, freeBytes = 1024) => {
  // Build a reading with the requested usedPct.
  const total = 1000000;
  return { totalBytes: total, freeBytes, usedPct };
};

run('#36 classifies below/at/above the warn threshold', () => {
  assert.strictEqual(classifyUsage(usage(10)).level, 'ok');
  assert.strictEqual(classifyUsage(usage(DEFAULT_WARN_PCT - 0.1)).level, 'ok');
  // At the threshold counts as warn — ">= threshold" is the intuitive reading
  // of "alert above 80%", and off-by-one here means the first alert is late.
  assert.strictEqual(classifyUsage(usage(DEFAULT_WARN_PCT)).level, 'warn');
  assert.strictEqual(classifyUsage(usage(85)).level, 'warn');
});

run('#36 escalates to critical', () => {
  assert.strictEqual(classifyUsage(usage(DEFAULT_CRITICAL_PCT)).level, 'critical');
  assert.strictEqual(classifyUsage(usage(100)).level, 'critical');
});

run('#36 an unmeasurable disk is "unknown", NOT "ok"', () => {
  // The important one. Collapsing unknown into ok is how a monitoring gap
  // hides: the 2026-05-19 disk was never reported as unhealthy either.
  assert.strictEqual(classifyUsage(null).level, 'unknown');
  assert.strictEqual(classifyUsage({ usedPct: NaN }).level, 'unknown');
  assert.notStrictEqual(classifyUsage(null).level, 'ok');
});

run('#36 thresholds are overridable', () => {
  assert.strictEqual(classifyUsage(usage(50), { warnPct: 40 }).level, 'warn');
  assert.strictEqual(classifyUsage(usage(50), { warnPct: 40, criticalPct: 45 }).level, 'critical');
});

// ── reporting ───────────────────────────────────────────────

run('#36 a healthy disk produces NO log line', () => {
  // A periodic "disk is fine" line is how real warnings get scrolled past.
  assert.strictEqual(usageReport(classifyUsage(usage(10)), '/'), null);
});

run('#36 a warn names the percentage, the free space and where to look', () => {
  const line = usageReport(classifyUsage(usage(85, 3 * 1024 * 1024 * 1024)), '/home/opc');
  assert.ok(line, 'expected a warning line');
  assert.ok(line.includes('85'), 'must state the usage');
  assert.ok(line.includes('/home/opc'), 'must name the path');
  assert.ok(line.includes('3.0GB'), `must state free space, got: ${line}`);
  // An operator reading this at 3am should not have to remember what grows.
  assert.ok(/prune-cron/.test(line), 'must point at the likely cause');
});

run('#36 critical is distinguishable from warn in the log', () => {
  const warn = usageReport(classifyUsage(usage(85)), '/');
  const crit = usageReport(classifyUsage(usage(95)), '/');
  assert.ok(/WARN/.test(warn));
  assert.ok(/CRITICAL/.test(crit));
});

run('#36 unknown is reported, not silently dropped', () => {
  const line = usageReport(classifyUsage(null), '/');
  assert.ok(line && /could not measure/.test(line),
    'an unmeasurable disk must say so — silence would look identical to healthy');
});

// ── formatting ──────────────────────────────────────────────

run('#36 formatBytes is readable at every scale', () => {
  assert.strictEqual(formatBytes(0), '0.0B');
  assert.strictEqual(formatBytes(1536), '1.5KB');
  assert.strictEqual(formatBytes(30 * 1024 * 1024 * 1024), '30GB');
  assert.strictEqual(formatBytes(-1), 'unknown');
  assert.strictEqual(formatBytes(NaN), 'unknown');
});

console.log(failed === 0 ? '\ndisk-space: all passed' : `\ndisk-space: ${failed} FAILED`);
if (failed > 0) process.exit(1);
