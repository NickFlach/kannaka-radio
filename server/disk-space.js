'use strict';

/**
 * disk-space.js — let the radio notice its own disk pressure (#36).
 *
 * On 2026-05-19 the Oracle root disk hit 100% (0 KB free of 30 GB): 12,779 TTS
 * intro files had accumulated since March because nothing pruned them. It
 * filled silently for WEEKS — the first symptom was scp failing and services
 * malfunctioning.
 *
 * `prune-cron.sh` now deletes voice chunks older than 7 days, which fixes the
 * leak. This is the other half the issue asks for: a second line of defense for
 * when the cron itself stops running (stuck lock file, missing binary, host
 * reimaged). A cron that silently stops looks exactly like a cron that has
 * nothing to do, which is why the incident lasted weeks rather than hours.
 *
 * Deliberately in-process rather than another cron: a check that lives in the
 * service cannot itself be the thing that stopped running, and it needs no
 * host-side install. It does NOT replace external monitoring — a full disk can
 * also stop the service from logging its own warning — so treat it as the inner
 * of two rings, not the only one.
 */

const fs = require('fs');

/** Default warn threshold (percent used). Below the point writes start failing. */
const DEFAULT_WARN_PCT = 80;
/** Default critical threshold — at this point a prune is overdue, not upcoming. */
const DEFAULT_CRITICAL_PCT = 92;

/**
 * Filesystem usage for the volume containing `targetPath`, or null when it
 * cannot be determined.
 *
 * Returns null rather than throwing: this is diagnostics, and a monitoring
 * helper that can crash the caller is worse than one that reports nothing.
 * (`fs.statfsSync` needs Node >= 18.15; CI runs 20.)
 */
function diskUsage(targetPath) {
  try {
    const st = fs.statfsSync(targetPath);
    const blockSize = Number(st.bsize);
    const totalBlocks = Number(st.blocks);
    // `bavail`, not `bfree`: bfree includes blocks reserved for root, which a
    // service running as `opc` cannot write into. bavail is the number that
    // answers "will my next write succeed", which is the question being asked.
    const availBlocks = Number(st.bavail);
    if (!Number.isFinite(blockSize) || !Number.isFinite(totalBlocks) || !Number.isFinite(availBlocks)) {
      return null;
    }
    const totalBytes = totalBlocks * blockSize;
    const freeBytes = availBlocks * blockSize;
    if (!(totalBytes > 0)) return null;
    const usedPct = Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10;
    return { totalBytes, freeBytes, usedPct };
  } catch (_) {
    return null;
  }
}

/**
 * Classify a usage reading.
 *
 * `unknown` is its own level and is NOT treated as ok: "we could not measure
 * the disk" and "the disk is fine" are different states, and collapsing them is
 * how a monitoring gap hides. The caller decides how loud unknown should be.
 */
function classifyUsage(usage, opts = {}) {
  const warnPct = Number.isFinite(opts.warnPct) ? opts.warnPct : DEFAULT_WARN_PCT;
  const criticalPct = Number.isFinite(opts.criticalPct) ? opts.criticalPct : DEFAULT_CRITICAL_PCT;
  if (!usage || !Number.isFinite(usage.usedPct)) {
    return { level: 'unknown', usedPct: null, warnPct, criticalPct };
  }
  const level =
    usage.usedPct >= criticalPct ? 'critical' : usage.usedPct >= warnPct ? 'warn' : 'ok';
  return { level, usedPct: usage.usedPct, freeBytes: usage.freeBytes, warnPct, criticalPct };
}

/** Human-readable byte size, for log lines an operator reads at 3am. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

/**
 * One-line report for a classified reading, or null when nothing is worth
 * saying. Returning null for `ok` keeps a healthy host silent — a periodic
 * "disk is fine" line is how real warnings get scrolled past.
 */
function usageReport(verdict, targetPath) {
  if (!verdict || verdict.level === 'ok') return null;
  if (verdict.level === 'unknown') {
    return `[disk] could not measure free space on ${targetPath} — external monitoring is the only cover`;
  }
  const free = formatBytes(verdict.freeBytes);
  const tag = verdict.level === 'critical' ? 'CRITICAL' : 'WARN';
  return (
    `[disk] ${tag} ${verdict.usedPct}% used on ${targetPath} (${free} free) — ` +
    `threshold ${verdict.level === 'critical' ? verdict.criticalPct : verdict.warnPct}%. ` +
    `Check prune-cron is still running (voice chunks + Ghost Recorder wavs are the usual growth).`
  );
}

module.exports = {
  diskUsage,
  classifyUsage,
  usageReport,
  formatBytes,
  DEFAULT_WARN_PCT,
  DEFAULT_CRITICAL_PCT,
};
