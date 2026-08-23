'use strict';

/**
 * gs-analytics-core.js — the pure analysis engine of Ghost Signals Analytics
 * (Piece 4, v1). No I/O: parse → infer → stats → signals, all unit-testable.
 *
 * The product: a customer uploads tabular data (CSV or JSON rows) and gets a
 * ranked list of SIGNALS — concrete, honest findings ("units trending +12%/wk",
 * "9 outliers in amount, max 5.2σ", "price ↔ conversions r=-0.81") — followed
 * by the per-column statistics that back them. Fixed-function only: no
 * expression evaluation over customer data, ever.
 *
 * Everything is bounded: the parser enforces row/column/cell caps as it reads
 * (never buffers unbounded intermediate state), and the analysis is O(rows ×
 * cols) with small constants, so a max-size dataset stays well under the
 * event-loop budget of the live station this runs inside.
 */

// ── Caps (load-bearing: the live radio shares this process) ──
const MAX_ROWS = 50_000;
const MAX_COLS = 100;
const MAX_CELL_CHARS = 500;   // a "cell" longer than this is truncated (text), never analyzed whole
const MAX_TOPK = 5;

// The control-character class, built from an ASCII string ON PURPOSE: a
// literal class in source is fragile — editors normalize the escapes into raw
// bytes, silently changing which characters it covers (it happened twice while
// building this, once dropping DEL/C1 and starting to eat hyphens).
const CONTROL_CHARS = new RegExp('[\u0000-\u001f\u007f-\u009f]', 'g');

class BadDataset extends Error {
  constructor(msg) { super(msg); this.code = 'bad_dataset'; }
}

// ── CSV parsing (single-pass, quote-aware, capped) ──────────
/**
 * Parse CSV text into { header, rows } with caps enforced DURING the pass.
 * Handles quoted fields (embedded commas/newlines/escaped quotes). Throws
 * BadDataset on structural problems. Never quadratic: one forward scan.
 */
function parseCsv(text) {
  if (typeof text !== 'string') throw new BadDataset('csv must be text');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => {
    row.push(field.length > MAX_CELL_CHARS ? field.slice(0, MAX_CELL_CHARS) : field);
    field = '';
    if (row.length > MAX_COLS) throw new BadDataset(`too many columns (max ${MAX_COLS})`);
  };
  const pushRow = () => {
    pushField();
    // skip fully-empty trailing lines
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
      if (rows.length > MAX_ROWS + 1) throw new BadDataset(`too many rows (max ${MAX_ROWS})`);
    }
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      if (field.length <= MAX_CELL_CHARS) field += c; // cap growth, keep scanning
      i += 1; continue;
    }
    if (c === '"' && field === '') { inQuotes = true; i += 1; continue; }
    if (c === ',') { pushField(); i += 1; continue; }
    if (c === '\n') { pushRow(); i += 1; continue; }
    if (c === '\r') { if (text[i + 1] === '\n') i += 1; pushRow(); i += 1; continue; }
    if (field.length <= MAX_CELL_CHARS) field += c;
    i += 1;
  }
  if (field !== '' || row.length) pushRow();
  if (rows.length < 2) throw new BadDataset('need a header row and at least one data row');
  // Column names are attacker-controlled and end up in the report — strip
  // control chars at the door (review B2).
  // eslint-disable-next-line no-control-regex
  const header = rows[0].map((h, idx) => String(h || `col_${idx + 1}`).replace(CONTROL_CHARS, ' ').trim().slice(0, 80) || `col_${idx + 1}`);
  return { header, rows: rows.slice(1) };
}

/** Normalize JSON input (array of flat objects) to { header, rows }. */
function fromJsonRows(arr) {
  if (!Array.isArray(arr) || arr.length === 0) throw new BadDataset('json must be a non-empty array of objects');
  if (arr.length > MAX_ROWS) throw new BadDataset(`too many rows (max ${MAX_ROWS})`);
  const headerSet = [];
  const seen = new Set();
  for (const o of arr.slice(0, 200)) { // header from a sample — bounded
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new BadDataset('rows must be flat objects');
    for (const k of Object.keys(o)) {
      if (!seen.has(k)) { seen.add(k); headerSet.push(String(k).slice(0, 80)); if (headerSet.length > MAX_COLS) throw new BadDataset(`too many columns (max ${MAX_COLS})`); }
    }
  }
  const rows = arr.map((o) => headerSet.map((k) => {
    const v = o[k];
    if (v == null) return '';
    const s = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : JSON.stringify(v);
    return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) : s;
  }));
  return { header: headerSet, rows };
}

// ── Type inference ──────────────────────────────────────────
const NUMBER_RE = /^-?\$?\s?-?[\d,]+(\.\d+)?%?$/;
function toNumber(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (t === '' || !NUMBER_RE.test(t)) return null;
  const v = Number(t.replace(/[$,%\s]/g, ''));
  return Number.isFinite(v) ? v : null;
}
function toDate(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (t.length < 6 || t.length > 30) return null;
  // Require a date-like shape so plain numbers/ids aren't read as epoch dates.
  if (!/^\d{4}-\d{2}-\d{2}/.test(t) && !/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Classify each column from its values: 'numeric' | 'datetime' | 'categorical'
 * | 'text', plus parsed value arrays for the typed ones. A column qualifies for
 * a type when ≥80% of its non-empty values parse as it.
 */
/** Display label for a column: de-duplicated so two columns sharing a header
 *  are distinguishable in the report ("Total" / "Total (2)"). Correlation and
 *  series keying uses the INDEX, never the name — two same-named columns keyed
 *  by name collided and pearson(a,a) reported a fabricated r=1.00 between two
 *  genuinely different (even anti-correlated) columns, walking straight through
 *  every honesty floor. */
function labelColumns(header) {
  const seen = new Map();
  return header.map((h) => {
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
}

function inferColumns(header, rows) {
  return labelColumns(header).map((name, ci) => {
    let nonEmpty = 0; let nums = 0; let dates = 0;
    const distinct = new Set();
    for (const r of rows) {
      const v = r[ci];
      if (v == null || String(v).trim() === '') continue;
      nonEmpty += 1;
      if (toNumber(String(v)) != null) nums += 1;
      else if (toDate(String(v)) != null) dates += 1;
      if (distinct.size <= 1000) distinct.add(String(v));
    }
    const missing = rows.length - nonEmpty;
    let type = 'text';
    if (nonEmpty > 0 && nums / nonEmpty >= 0.8) type = 'numeric';
    else if (nonEmpty > 0 && dates / nonEmpty >= 0.8) type = 'datetime';
    // Categorical = a bounded label set that actually REPEATS. Mostly-unique
    // values (free text, ids) must stay 'text' even when few in number.
    else if (nonEmpty > 0 && distinct.size <= Math.max(20, Math.sqrt(rows.length)) && distinct.size <= nonEmpty * 0.6) type = 'categorical';
    return { name, index: ci, type, nonEmpty, missing, distinct: distinct.size };
  });
}

// ── Statistics ──────────────────────────────────────────────
function numericStats(values) {
  const xs = values.filter((v) => v != null).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { n: 0 };
  const sum = xs.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const med = n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
  const varr = n > 1 ? xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
  const std = Math.sqrt(varr);
  let outliers = 0; let maxZ = 0;
  if (std > 0) {
    for (const x of xs) {
      const z = Math.abs((x - mean) / std);
      if (z > 3) outliers += 1;
      if (z > maxZ) maxZ = z;
    }
  }
  return { n, min: xs[0], max: xs[n - 1], mean, median: med, std, outliers, maxZ };
}

function categoricalStats(values) {
  const counts = new Map();
  let n = 0;
  for (const v of values) {
    if (v == null || v === '') continue;
    n += 1;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOPK)
    .map(([value, count]) => ({ value, count, share: n ? count / n : 0 }));
  return { n, cardinality: counts.size, top };
}

/** Pearson correlation for two parallel numeric arrays (nulls pairwise-dropped). */
function pearson(a, b) {
  let n = 0; let sa = 0; let sb = 0; let saa = 0; let sbb = 0; let sab = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x == null || y == null) continue;
    n += 1; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 30) return { r: null, n }; // too few complete pairs to claim anything honest (review M7)
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 0 || vb <= 0) return { r: null, n };
  return { r: cov / Math.sqrt(va * vb), n };
}

/** Least-squares slope of y over x plus r². */
function linearTrend(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; const dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, r2, meanY: my };
}

/**
 * Bucket rows by period on the time column and aggregate each numeric column
 * (sum per period), then fit a trend and flag anomalous periods (|z|>2.5 on
 * period totals). Period = day if the span ≤ 90 days else week.
 */
function timeSeriesAnalysis(rows, timeCol, numericCols) {
  const times = rows.map((r) => toDate(String(r[timeCol.index] ?? ''))).filter((t) => t != null);
  if (times.length < 6) return null;
  const span = times.reduce((a, b) => (b > a ? b : a), times[0]) - times.reduce((a, b) => (b < a ? b : a), times[0]);
  const DAY = 86_400_000;
  const periodMs = span <= 90 * DAY ? DAY : 7 * DAY;
  const periodName = periodMs === DAY ? 'day' : 'week';
  const series = {};
  for (const col of numericCols) {
    const buckets = new Map();
    for (const r of rows) {
      const t = toDate(String(r[timeCol.index] ?? ''));
      const v = toNumber(String(r[col.index] ?? ''));
      if (t == null || v == null) continue;
      const b = Math.floor(t / periodMs);
      buckets.set(b, (buckets.get(b) || 0) + v);
    }
    if (buckets.size < 4) continue;
    const keys = [...buckets.keys()].sort((a, b) => a - b);
    const xs = keys.map((k) => k - keys[0]);
    const ys = keys.map((k) => buckets.get(k));
    const trend = linearTrend(xs, ys);
    // anomalous periods on the de-meaned totals
    const st = numericStats(ys);
    const anomalies = [];
    if (st.std > 0) {
      keys.forEach((k, idx) => {
        const z = Math.abs((ys[idx] - st.mean) / st.std);
        if (z > 2.5) anomalies.push({ period: new Date(k * periodMs).toISOString().slice(0, 10), value: ys[idx], z: Math.round(z * 10) / 10 });
      });
    }
    series[col.index] = { name: col.name, periodName, points: keys.length, trend, anomalies: anomalies.slice(0, 5) };
  }
  return { timeColumn: timeCol.name, series };
}

// ── The signals report ──────────────────────────────────────
/**
 * Build the full report for a dataset: { rowCount, columns:[...stats],
 * timeseries, correlations, signals:[{score, text, kind}] } — signals ranked
 * by salience, capped, every claim backed by a stat in the same report.
 */
function buildReport(header, rows) {
  if (!rows.length) throw new BadDataset('no data rows');
  const cols = inferColumns(header, rows);
  const signals = [];
  const columns = [];
  const numericCols = cols.filter((c) => c.type === 'numeric');
  const catCols = cols.filter((c) => c.type === 'categorical');
  const dateCols = cols.filter((c) => c.type === 'datetime');

  // Per-column stats + missing/outlier/dominance signals.
  const numericValues = new Map();
  for (const c of cols) {
    const raw = rows.map((r) => r[c.index]);
    if (c.type === 'numeric') {
      const vals = raw.map((v) => toNumber(String(v ?? '')));
      numericValues.set(c.index, vals);
      const st = numericStats(vals);
      columns.push({ ...c, stats: st });
      if (st.n >= 8 && st.outliers > 0) {
        signals.push({ score: Math.min(0.9, 0.4 + st.maxZ / 20), kind: 'outliers', text: `${st.outliers} outlier${st.outliers > 1 ? 's' : ''} in "${c.name}" (most extreme ${st.maxZ.toFixed(1)}σ from the mean)` });
      }
    } else if (c.type === 'categorical') {
      const st = categoricalStats(raw.map((v) => (v == null ? '' : String(v))));
      columns.push({ ...c, stats: st });
      if (st.top[0] && st.top[0].share >= 0.5 && st.cardinality > 1) {
        signals.push({ score: 0.35 + st.top[0].share / 4, kind: 'dominance', text: `"${st.top[0].value}" accounts for ${(st.top[0].share * 100).toFixed(0)}% of "${c.name}"` });
      }
    } else {
      columns.push({ ...c, stats: { n: c.nonEmpty } });
    }
    if (rows.length >= 10 && c.missing / rows.length >= 0.2) {
      signals.push({ score: 0.3 + (c.missing / rows.length) / 3, kind: 'missing', text: `"${c.name}" is ${((c.missing / rows.length) * 100).toFixed(0)}% missing (${c.missing} of ${rows.length} rows)` });
    }
  }

  // Time-series trends + period anomalies.
  let timeseries = null;
  if (dateCols.length && numericCols.length) {
    timeseries = timeSeriesAnalysis(rows, dateCols[0], numericCols.slice(0, 10));
    if (timeseries) {
      for (const s of Object.values(timeseries.series)) {
        const name = s.name;
        // Honesty floors (review M7): a trend claim needs ≥8 periods AND r²≥0.3;
        // a period-anomaly claim needs ≥20 periods (rolling-z on short series is
        // the most garbage-prone finding class).
        if (s.trend && s.points >= 8 && s.trend.r2 >= 0.3 && s.trend.meanY !== 0) {
          const pct = (s.trend.slope / Math.abs(s.trend.meanY)) * 100;
          if (Math.abs(pct) >= 1) {
            signals.push({ score: Math.min(0.95, 0.5 + s.trend.r2 / 2), kind: 'trend', text: `"${name}" is trending ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%/${s.periodName} over ${s.points} ${s.periodName}s (r²=${s.trend.r2.toFixed(2)})` });
          }
        }
        if (s.points >= 20) {
          for (const a of s.anomalies) {
            signals.push({ score: Math.min(0.9, 0.45 + a.z / 15), kind: 'anomaly', text: `"${name}" spiked to ${a.value} on ${a.period} (${a.z}σ from its ${s.periodName}ly norm)` });
          }
        }
      }
    }
  }

  // Correlations — top-10 numeric columns BY VARIANCE (not file order, review
  // B5/M7: bounds the O(k²·n) pass and picks the columns with signal in them).
  const byVariance = numericCols
    .map((c) => ({ c, std: (columns.find((x) => x.index === c.index) || {}).stats?.std || 0 }))
    .sort((x, y) => y.std - x.std)
    .slice(0, 10)
    .map((x) => x.c);
  const correlations = [];
  let pairsTested = 0;
  for (let i = 0; i < byVariance.length; i++) {
    for (let j = i + 1; j < byVariance.length; j++) {
      pairsTested += 1;
      const a = numericValues.get(byVariance[i].index);
      const b = numericValues.get(byVariance[j].index);
      const { r, n } = pearson(a, b);
      if (r != null && Math.abs(r) >= 0.6) {
        correlations.push({ a: byVariance[i].name, b: byVariance[j].name, r: Math.round(r * 100) / 100, n });
        // Direction matters: at r=-1 the columns move OPPOSITELY, and calling
        // that "move together" would be a plainly false finding.
        const how = r >= 0 ? 'move together' : 'move in opposite directions';
        signals.push({ score: 0.4 + Math.abs(r) / 3, kind: 'correlation', text: `"${byVariance[i].name}" and "${byVariance[j].name}" ${how} (r=${r.toFixed(2)}, n=${n}) — correlation, not causation` });
      }
    }
  }

  signals.sort((x, y) => y.score - x.score);
  return scrubNonFinite({
    rowCount: rows.length,
    columnCount: header.length,
    columns,
    timeseries,
    correlations: correlations.sort((x, y) => Math.abs(y.r) - Math.abs(x.r)).slice(0, 10),
    signals: signals.slice(0, 15),
    caveats: [
      'Findings are statistical observations of the uploaded data only — correlation is not causation.',
      pairsTested > 0 ? `${pairsTested} column pair${pairsTested > 1 ? 's' : ''} tested for correlation; some strong-looking pairs arise by chance.` : null,
      rows.length < 100 ? `Small dataset (${rows.length} rows): treat every signal as tentative.` : null,
    ].filter(Boolean),
  });
}

/** Replace non-finite numbers (NaN/±Infinity) with null everywhere in the
 *  report — JSON.stringify would silently turn NaN into null anyway, but the
 *  renderer must see an honest, predictable shape (review M7). */
function scrubNonFinite(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(scrubNonFinite);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = scrubNonFinite(v[k]);
    return o;
  }
  return v;
}

/** HTML-escape untrusted customer strings for the report page. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = {
  CONTROL_CHARS,
  MAX_ROWS, MAX_COLS, MAX_CELL_CHARS,
  BadDataset, parseCsv, fromJsonRows, inferColumns,
  numericStats, categoricalStats, pearson, linearTrend, timeSeriesAnalysis,
  buildReport, esc,
};
