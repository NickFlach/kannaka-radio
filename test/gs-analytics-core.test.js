'use strict';

// gs-analytics-core.test.js — the pure GSA analysis engine: bounded parsing,
// type inference, honest statistics, and the ranked signals report.

const assert = require('assert');
const {
  MAX_ROWS, MAX_COLS,
  BadDataset, parseCsv, fromJsonRows, inferColumns,
  numericStats, categoricalStats, pearson, linearTrend,
  buildReport, esc,
} = require('../server/gs-analytics-core');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; } }

console.log('gs-analytics-core.test.js');

run('parseCsv: basic + quoted commas/newlines/escaped quotes + CRLF', () => {
  const { header, rows } = parseCsv('a,b,c\r\n1,"x, y",3\n2,"he said ""hi""\nnext",4\n');
  assert.deepStrictEqual(header, ['a', 'b', 'c']);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0][1], 'x, y');
  assert.strictEqual(rows[1][1], 'he said "hi"\nnext');
});

run('parseCsv: caps rows and columns', () => {
  const wide = 'h' + ',h'.repeat(MAX_COLS) + '\n' + '1'.repeat(1);
  assert.throws(() => parseCsv(wide), /too many columns/);
  let tall = 'a\n';
  for (let i = 0; i < MAX_ROWS + 2; i++) tall += i + '\n';
  assert.throws(() => parseCsv(tall), /too many rows/);
  assert.throws(() => parseCsv('only-header\n'), /at least one data row/);
});

run('fromJsonRows: flat objects only, header from sample', () => {
  const { header, rows } = fromJsonRows([{ a: 1, b: 'x' }, { a: 2, b: 'y', c: true }]);
  assert.deepStrictEqual(header, ['a', 'b', 'c']);
  assert.strictEqual(rows[1][2], 'true');
  assert.throws(() => fromJsonRows([1, 2]), /flat objects/);
  assert.throws(() => fromJsonRows([]), /non-empty/);
});

run('inferColumns: numeric / datetime / categorical / text + missing', () => {
  const header = ['when', 'amount', 'region', 'note'];
  const rows = [];
  for (let d = 1; d <= 30; d++) {
    rows.push([`2026-06-${String(d).padStart(2, '0')}`, String(d * 10), d % 2 ? 'east' : 'west', d % 3 ? `note number ${d} unique text` : '']);
  }
  const cols = inferColumns(header, rows);
  assert.strictEqual(cols[0].type, 'datetime');
  assert.strictEqual(cols[1].type, 'numeric');
  assert.strictEqual(cols[2].type, 'categorical');
  assert.strictEqual(cols[3].type, 'text');
  assert.strictEqual(cols[3].missing, 10);
});

run('numeric ids are not misread as dates; $ and % and , parse as numbers', () => {
  const cols = inferColumns(['id', 'price'], [['1000001', '$1,234.50'], ['1000002', '$999.00'], ['1000003', '12%']]);
  assert.strictEqual(cols[0].type, 'numeric', 'plain integers are numeric, not epoch dates');
  assert.strictEqual(cols[1].type, 'numeric');
});

run('numericStats: known values + outlier detection', () => {
  const vals = Array.from({ length: 50 }, (_, i) => 100 + (i % 5)); // tight cluster
  vals.push(100000); // planted outlier
  const st = numericStats(vals);
  assert.strictEqual(st.n, 51);
  assert.ok(st.outliers >= 1, 'outlier found');
  assert.ok(st.maxZ > 3);
  assert.strictEqual(numericStats([]).n, 0);
});

run('categoricalStats: top-k with shares', () => {
  const st = categoricalStats(['a', 'a', 'a', 'b', 'c', '']);
  assert.strictEqual(st.n, 5);
  assert.strictEqual(st.cardinality, 3);
  assert.strictEqual(st.top[0].value, 'a');
  assert.ok(Math.abs(st.top[0].share - 0.6) < 1e-9);
});

run('pearson: strong pair detected, tiny n refused', () => {
  const a = Array.from({ length: 40 }, (_, i) => i);
  const b = a.map((x) => 3 * x + 1);
  const { r, n } = pearson(a, b);
  assert.ok(r > 0.999); assert.strictEqual(n, 40);
  assert.strictEqual(pearson([1, 2, 3], [1, 2, 3]).r, null, 'n<30 → no claim (honesty floor)');
});

run('linearTrend: recovers a known slope', () => {
  const xs = [0, 1, 2, 3, 4, 5];
  const ys = xs.map((x) => 10 + 2 * x);
  const t = linearTrend(xs, ys);
  assert.ok(Math.abs(t.slope - 2) < 1e-9);
  assert.ok(t.r2 > 0.999);
});

run('buildReport: finds the planted trend, outlier, correlation, dominance, missing', () => {
  const header = ['date', 'units', 'revenue', 'latency', 'region', 'comment'];
  const rows = [];
  for (let d = 0; d < 60; d++) {
    const date = new Date(Date.UTC(2026, 5, 1 + d)).toISOString().slice(0, 10);
    const units = 100 + 2 * d + (d % 3); // clean upward trend
    const revenue = units * 3 + (d % 5); // strongly correlated with units
    const latency = d === 30 ? 5000 : 50 + (d % 7); // planted outlier, its own column
    const region = d % 10 === 0 ? 'west' : 'east'; // east dominates 90%
    const comment = d % 2 ? '' : `free text comment for day ${d} entirely unique`; // 50% missing
    rows.push([date, String(units), String(revenue), String(latency), region, comment]);
  }
  const rep = buildReport(header, rows);
  assert.strictEqual(rep.rowCount, 60);
  const kinds = new Set(rep.signals.map((s) => s.kind));
  assert.ok(kinds.has('trend'), 'trend signal found: ' + JSON.stringify([...kinds]));
  assert.ok(kinds.has('outliers') || kinds.has('anomaly'), 'planted outlier surfaced');
  assert.ok(kinds.has('correlation'), 'units↔revenue correlation found');
  assert.ok(kinds.has('dominance'), 'east dominance found');
  assert.ok(kinds.has('missing'), 'missing-comment signal found');
  assert.ok(rep.signals.every((s) => typeof s.text === 'string' && s.score > 0));
  const corrSig = rep.signals.find((s) => s.kind === 'correlation');
  assert.ok(/not causation/.test(corrSig.text), 'correlation carries its caveat');
});

run('buildReport: degenerate inputs stay graceful', () => {
  // all-text tiny dataset
  const rep1 = buildReport(['a', 'b'], [['hello world text one', 'x'], ['another line of text', 'y']]);
  assert.ok(rep1.caveats.some((c) => /Small dataset/.test(c)), 'small-data caveat present');
  assert.ok(Array.isArray(rep1.signals));
  // single data row
  const rep2 = buildReport(['n'], [['5']]);
  assert.strictEqual(rep2.rowCount, 1);
  // all-null column
  const rep3 = buildReport(['x', 'empty'], [['1', ''], ['2', ''], ['3', '']]);
  assert.ok(rep3.columns.length === 2);
  // no crash = pass
});

run('control-char sanitizing covers ESC/DEL/C1 and PRESERVES hyphens', () => {
  // Regression: the class was twice normalized by an editor into a form that
  // dropped DEL/C1 and started eating hyphens out of real column names, so it
  // is now built from an ASCII string. Assert the behaviour, not the source.
  const { CONTROL_CHARS } = require('../server/gs-analytics-core');
  const ESC = String.fromCharCode(27), DEL = String.fromCharCode(127), C1 = String.fromCharCode(0x9b);
  assert.strictEqual(('a' + ESC + 'b' + DEL + 'c' + C1 + 'd').replace(CONTROL_CHARS, ''), 'abcd');
  assert.strictEqual('order-date'.replace(CONTROL_CHARS, ''), 'order-date', 'hyphens are not control chars');
  const { header } = parseCsv('order-date,unit-price' + ESC + '\n1,2\n');
  assert.deepStrictEqual(header, ['order-date', 'unit-price']);
});

run('esc: neutralizes HTML in customer data', () => {
  assert.strictEqual(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(esc('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
});

if (!failed) console.log('\nAll gs-analytics-core tests passed');
else process.exitCode = 1;
