'use strict';

// radio-ads-core.test.js — bands, ad-text validation, the airing state
// machine, and air-eligibility. Pure; no DB.

const assert = require('assert');
const core = require('../server/radio-ads-core');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('radio-ads-core.test.js');

run('four bands cover the 24h clock with no gap or overlap', () => {
  const seen = new Set();
  for (let h = 0; h < 24; h++) {
    const b = core.bandForHour(h);
    assert.ok(core.isValidBand(b), `hour ${h} -> unknown band ${b}`);
    seen.add(b);
  }
  assert.deepStrictEqual([...seen].sort(), [...core.RADIO_AD_BANDS].sort());
  assert.strictEqual(core.bandForHour(6), 'morning');
  assert.strictEqual(core.bandForHour(11), 'morning');
  assert.strictEqual(core.bandForHour(12), 'afternoon');
  assert.strictEqual(core.bandForHour(18), 'evening');
  assert.strictEqual(core.bandForHour(23), 'evening');
  assert.strictEqual(core.bandForHour(0), 'late_night');
  assert.strictEqual(core.bandForHour(5), 'late_night');
  assert.strictEqual(core.bandForHour(24), 'late_night'); // wraps
});

run('ad text: normalized, bounded, control chars stripped', () => {
  assert.strictEqual(core.normalizeAdText('  hello   there  '), 'hello there');
  assert.strictEqual(core.normalizeAdText('hello' + String.fromCharCode(7) + 'world'), 'hello world'); // ctrl -> space, collapsed
  assert.throws(() => core.normalizeAdText('x'), core.InvalidAdText); // too short
  assert.throws(() => core.normalizeAdText('x'.repeat(core.MAX_AD_CHARS + 1)), core.InvalidAdText);
  assert.throws(() => core.normalizeAdText(42), core.InvalidAdText);
});

run('content hash is stable and text-sensitive', () => {
  const a = core.contentHash('Buy widgets from Acme');
  assert.strictEqual(a, core.contentHash('Buy widgets from Acme'));
  assert.notStrictEqual(a, core.contentHash('Buy widgets from Acme.'));
  assert.strictEqual(a.length, 16);
});

run('state machine: legal transitions only', () => {
  assert.ok(core.canTransition('scheduled', 'killed'));
  assert.ok(core.canTransition('scheduled', 'completed'));
  assert.ok(core.canTransition('approved', 'scheduled'));
  assert.ok(core.canTransition('rejected', 'refunded'));
  assert.ok(!core.canTransition('completed', 'scheduled')); // terminal
  assert.ok(!core.canTransition('draft', 'scheduled')); // must pay+approve first
  assert.ok(!core.canTransition('refunded', 'airing'));
});

run('airEligible: only scheduled + rendered + right band + run left + not aired today', () => {
  const day = core.stationDay(new Date(Date.UTC(2026, 7, 22, 9, 0))); // morning
  const now = new Date(Date.UTC(2026, 7, 22, 9, 0));
  const base = { status: 'scheduled', tts_file: 'ads/x.mp3', band: 'morning', airings_done: 0, run_days: 7, last_aired_date: null };
  assert.ok(core.airEligible(base, now));
  assert.ok(!core.airEligible({ ...base, status: 'killed' }, now));
  assert.ok(!core.airEligible({ ...base, tts_file: null }, now)); // unrendered
  assert.ok(!core.airEligible({ ...base, band: 'evening' }, now)); // wrong band
  assert.ok(!core.airEligible({ ...base, airings_done: 7 }, now)); // run done
  assert.ok(!core.airEligible({ ...base, last_aired_date: day }, now)); // already today
});

if (!failed) console.log('\nAll radio-ads-core tests passed');
else process.exitCode = 1;
