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
  // 14:00 UTC = 09:00 at a Central station — morning on the STATION clock,
  // which is the clock airEligible answers to. (This fixture used 09:00 UTC
  // back when bands were UTC; on a Central station that instant is 04:00,
  // i.e. late_night.) Derived rather than hardcoded so it holds whatever
  // RADIO_TZ the station runs on.
  const now = new Date(Date.UTC(2026, 7, 22, 14, 0));
  const band = core.currentBand(now);
  const otherBand = core.RADIO_AD_BANDS.find((b) => b !== band);
  const day = core.stationDay(now);
  const base = { status: 'scheduled', tts_file: 'ads/x.mp3', band, airings_done: 0, run_days: 7, last_aired_date: null };
  assert.ok(core.airEligible(base, now));
  assert.ok(!core.airEligible({ ...base, status: 'killed' }, now));
  assert.ok(!core.airEligible({ ...base, tts_file: null }, now)); // unrendered
  assert.ok(!core.airEligible({ ...base, band: otherBand }, now)); // wrong band
  assert.ok(!core.airEligible({ ...base, airings_done: 7 }, now)); // run done
  assert.ok(!core.airEligible({ ...base, last_aired_date: day }, now)); // already today
});

// ── The station clock ───────────────────────────────────────
// Bands were UTC, which made the picker lie to anyone not living on UTC: a
// spot bought as "Afternoon · 12p–6p" aired 7am–1pm for a Central buyer.

run('bands follow the STATION zone, not UTC', () => {
  // 18:30 UTC = 13:30 in Chicago (CDT). UTC calls that evening; the station
  // calls it afternoon, and the station is the one the buyer meant.
  const t = new Date('2026-08-23T18:30:00Z');
  assert.strictEqual(core.bandForHour(t.getUTCHours()), 'evening', 'UTC would say evening');
  assert.strictEqual(core.currentBand(t, 'America/Chicago'), 'afternoon', 'the station says afternoon');
  assert.strictEqual(core.currentBand(t, 'UTC'), 'evening', 'and an explicit UTC station still says evening');
});

run('the station day follows the same zone as the bands', () => {
  // 00:33 UTC on the 24th is still 19:33 on the 23rd in Chicago.
  const t = new Date('2026-08-24T00:33:00Z');
  assert.strictEqual(t.toISOString().slice(0, 10), '2026-08-24', 'UTC has rolled over');
  assert.strictEqual(core.stationDay(t, 'America/Chicago'), '2026-08-23', 'the station has not');
  assert.strictEqual(core.stationHour(t, 'America/Chicago'), 19);
});

run('THE INVARIANT: the day boundary never falls inside a band', () => {
  // This is why stationDay had to move with the bands. With bands local and
  // the day left on UTC, the day rolled at 19:00 Central — mid-evening — so an
  // ad could air at 18:30 (day N) and again at 19:30 (day N+1): one paid day
  // burned twice, and the once-a-day promise broken.
  //
  // Walk a full local day in 15-minute steps. Every time the day key changes,
  // the local hour must be exactly 0 — the start of late_night, never mid-band.
  for (const tz of ['America/Chicago', 'UTC', 'Asia/Kolkata']) {
    let prevDay = null;
    let rolls = 0;
    for (let i = 0; i < 24 * 4 * 2; i++) {
      const t = new Date(Date.UTC(2026, 7, 23, 0, 0, 0) + i * 15 * 60 * 1000);
      const day = core.stationDay(t, tz);
      if (prevDay !== null && day !== prevDay) {
        rolls++;
        assert.strictEqual(
          core.stationHour(t, tz), 0,
          `${tz}: the day rolled at local hour ${core.stationHour(t, tz)} — that is inside a band`,
        );
        assert.strictEqual(core.currentBand(t, tz), 'late_night', `${tz}: a day must begin in late_night`);
      }
      prevDay = day;
    }
    // The count is zone-dependent across a fixed UTC window (a zone offset
    // shifts where local midnight falls inside it), so assert only that the
    // loop actually SAW a rollover — otherwise the check above is vacuous.
    assert.ok(rolls >= 1, `${tz}: no day rollover observed — the assertion above never ran`);
  }
});

run('DST is handled — the same wall-clock hour maps to the same band in summer and winter', () => {
  // 14:00 Chicago in August (CDT, UTC-5) and in January (CST, UTC-6).
  const summer = new Date('2026-08-23T19:00:00Z'); // 14:00 CDT
  const winter = new Date('2026-01-23T20:00:00Z'); // 14:00 CST
  assert.strictEqual(core.stationHour(summer, 'America/Chicago'), 14);
  assert.strictEqual(core.stationHour(winter, 'America/Chicago'), 14);
  assert.strictEqual(core.currentBand(summer, 'America/Chicago'), 'afternoon');
  assert.strictEqual(core.currentBand(winter, 'America/Chicago'), 'afternoon');
  // A fixed offset would have got one of these wrong, which is the whole
  // reason this goes through Intl rather than subtracting hours.
});

run('local midnight lands in late_night, not in the previous day', () => {
  const t = new Date('2026-08-24T05:00:00Z'); // 00:00 CDT
  assert.strictEqual(core.stationHour(t, 'America/Chicago'), 0, 'h23 — midnight is 0, never 24');
  assert.strictEqual(core.currentBand(t, 'America/Chicago'), 'late_night');
  assert.strictEqual(core.stationDay(t, 'America/Chicago'), '2026-08-24');
});

run('an unusable zone falls back to UTC instead of taking the station down', () => {
  // Never throw out of the airing poller over a typo'd env var.
  assert.doesNotThrow(() => core.stationDay(new Date(), 'Not/AZone'));
  assert.doesNotThrow(() => core.currentBand(new Date(), 'Not/AZone'));
});

run('the picker labels say whose clock they mean', () => {
  const opts = core.bandOptions(new Date('2026-08-23T18:00:00Z'), 'America/Chicago');
  assert.strictEqual(opts.length, 4);
  assert.deepStrictEqual(opts.map((o) => o.id), core.RADIO_AD_BANDS);
  assert.strictEqual(opts[1].label, 'Afternoon · 12p–6p CDT', 'the zone is stamped on the label');
  const winter = core.bandOptions(new Date('2026-01-23T18:00:00Z'), 'America/Chicago');
  assert.strictEqual(winter[1].label, 'Afternoon · 12p–6p CST', 'and it tracks DST');
});

if (!failed) console.log('\nAll radio-ads-core tests passed');
else process.exitCode = 1;
