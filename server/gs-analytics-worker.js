'use strict';

/**
 * gs-analytics-worker.js — runs ONE analysis job inside a worker_thread and
 * exits. Parsing happens HERE too (review B1/B5): a hostile payload can at
 * worst OOM/stack-overflow THIS thread (resourceLimits + spawn-per-job make
 * that a failed job), never the live station in the parent.
 */

const { parentPort, workerData } = require('worker_threads');
const { parseCsv, fromJsonRows, buildReport, BadDataset } = require('./gs-analytics-core');

try {
  const { kind, text } = workerData || {};
  let header;
  let rows;
  if (kind === 'csv') {
    ({ header, rows } = parseCsv(String(text ?? '')));
  } else if (kind === 'json') {
    let arr;
    try { arr = JSON.parse(String(text ?? '')); } catch { throw new BadDataset('invalid JSON'); }
    ({ header, rows } = fromJsonRows(arr));
  } else {
    throw new BadDataset('unknown dataset kind');
  }
  const report = buildReport(header, rows);
  parentPort.postMessage({ ok: true, report });
} catch (e) {
  const bad = !!(e && e.code === 'bad_dataset');
  parentPort.postMessage({ ok: false, bad, error: bad ? e.message : 'analysis failed' });
}
