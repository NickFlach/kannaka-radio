'use strict';

// radio-ad-airing-hook.test.js — the DJ-engine half of the airing hook: an
// ephemeral single-slot OVERLAY substitutes a staged sponsor into an existing
// house-commercial slot, confirm fires only when the spot FINISHES on-air, a
// killed ad is evicted synchronously, and music behavior is byte-identical when
// nothing is staged.

const assert = require('assert');
const { DJEngine } = require('../server/dj-engine');
const { currentBand, stationDay, RADIO_AD_BANDS } = require('../server/radio-ads-core');

let failed = 0;
async function run(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; } }

// A fixed clock so the drift check is deterministic. BAND and DAY are DERIVED
// from it rather than named, because bands and the airing ledger run on
// station-local time — naming a band here would re-break the moment RADIO_TZ
// changes, which is exactly how the drift test broke when the station moved
// off UTC.
const CLOCK = new Date(Date.UTC(2026, 7, 22, 9, 0));
const BAND = currentBand(CLOCK);
const DAY = stationDay(CLOCK);
const OTHER_BAND = RADIO_AD_BANDS.find((b) => b !== BAND);

function freshEngine() {
  const changes = [];
  const eng = new DJEngine({ getMusicDir: () => '.', onTrackChange: (t) => changes.push(t) });
  eng._clock = () => CLOCK;
  eng.state.channel = 'dj';
  // music, COMMERCIAL, music — a house commercial sits at idx 1.
  eng.state.playlistMeta = [
    { title: 'Song A', album: 'Test', file: 'a.mp3' },
    { title: '[AD] House Spot', album: 'Test', file: 'house.mp3', commercial: true },
    { title: 'Song B', album: 'Test', file: 'b.mp3' },
  ];
  eng.state.playlist = eng.state.playlistMeta.map((m) => m.file);
  eng.state.currentTrackIdx = 0;
  return { eng, changes };
}

function stageSponsor(eng, over = {}) {
  eng.stageSponsor({ adId: 'ad_x', file: 'radio-ads/ad_deadbeef.mp3', title: '[SPONSOR] ad_x', airDate: DAY, band: BAND, claimedAt: Date.now(), ...over });
}

(async () => {
  console.log('radio-ad-airing-hook.test.js');

  await run('overlay substitutes a staged sponsor into the house-commercial slot', async () => {
    const { eng, changes } = freshEngine();
    stageSponsor(eng);
    const cur = eng.advanceTrack('a.mp3'); // finish song A → land on the commercial (idx 1)
    assert.strictEqual(eng.state.currentTrackIdx, 1);
    assert.strictEqual(cur.file, 'radio-ads/ad_deadbeef.mp3', 'sponsor audio overlaid');
    assert.strictEqual(cur.sponsor, true);
    assert.strictEqual(cur.commercial, true, 'stays commercial:true → no-repeat/reshuffle untouched');
    assert.strictEqual(eng.getCurrentTrack().file, 'radio-ads/ad_deadbeef.mp3', 'getCurrentTrack honors the overlay');
    assert.strictEqual(eng.hasPendingSponsor(), false, 'pending consumed');
    assert.strictEqual(changes[changes.length - 1].sponsor, true, 'onTrackChange saw the sponsor');
    // The persistent playlistMeta entry is NOT mutated (overlay is ephemeral).
    assert.strictEqual(eng.state.playlistMeta[1].file, 'house.mp3', 'playlistMeta untouched');
    assert.strictEqual(eng.state.playlistMeta[1].sponsor, undefined);
  });

  await run('confirm fires only when the sponsor FINISHES on-air', async () => {
    const { eng } = freshEngine();
    let confirmed = null;
    eng._confirmSponsor = (adId, airDate) => { confirmed = { adId, airDate }; };
    stageSponsor(eng);
    eng.advanceTrack('a.mp3'); // now airing the sponsor
    assert.strictEqual(confirmed, null, 'not confirmed while still on-air');
    const next = eng.advanceTrack('radio-ads/ad_deadbeef.mp3'); // sponsor finished
    assert.deepStrictEqual(confirmed, { adId: 'ad_x', airDate: DAY }, 'confirmed on finish');
    assert.strictEqual(next.file, 'b.mp3', 'advanced to the next music track');
    assert.strictEqual(eng._sponsorOverride, null, 'override cleared after it finished');
  });

  await run('a sponsor cut mid-air (swap) is NOT confirmed → it re-airs, never charged', async () => {
    const { eng } = freshEngine();
    let confirmed = null;
    eng._confirmSponsor = (adId, airDate) => { confirmed = { adId, airDate }; };
    stageSponsor(eng);
    eng.advanceTrack('a.mp3'); // airing sponsor
    // A different file finished (album swap cut the spot) → no confirm.
    eng.advanceTrack('something-else.mp3');
    assert.strictEqual(confirmed, null, 'a cut spot is not counted');
  });

  await run('no-op when nothing is staged — the house commercial plays unchanged', async () => {
    const { eng } = freshEngine();
    const cur = eng.advanceTrack('a.mp3');
    assert.strictEqual(cur.file, 'house.mp3', 'house commercial plays');
    assert.strictEqual(cur.sponsor, undefined);
    assert.strictEqual(eng._sponsorOverride, null);
  });

  await run('evictSponsor drops a staged sponsor and a live overlay (kill safety)', async () => {
    const { eng } = freshEngine();
    stageSponsor(eng);
    eng.evictSponsor('ad_x');
    assert.strictEqual(eng.hasPendingSponsor(), false, 'staged sponsor evicted');
    const cur = eng.advanceTrack('a.mp3');
    assert.strictEqual(cur.file, 'house.mp3', 'a killed ad never reaches the slot');
    // And a live overlay is dropped too.
    const { eng: eng2 } = freshEngine();
    stageSponsor(eng2);
    eng2.advanceTrack('a.mp3'); // overlay live
    assert.strictEqual(eng2.getCurrentTrack().sponsor, true);
    eng2.evictSponsor('ad_x');
    assert.strictEqual(eng2.getCurrentTrack().file, 'house.mp3', 'live overlay evicted → house commercial');
  });

  await run('drift: a sponsor reserved for another band/day is NOT overlaid', async () => {
    const { eng } = freshEngine();
    stageSponsor(eng, { band: OTHER_BAND }); // any band the clock is NOT in
    const cur = eng.advanceTrack('a.mp3');
    assert.strictEqual(cur.file, 'house.mp3', 'out-of-band sponsor is skipped');
    assert.strictEqual(eng.hasPendingSponsor(), true, 'and left staged for the poller TTL to release');
  });

  await run('non-dj channel is never substituted (sponsor scope)', async () => {
    const { eng } = freshEngine();
    eng.state.channel = 'orc';
    stageSponsor(eng);
    const cur = eng.advanceTrack('a.mp3');
    assert.strictEqual(cur.file, 'house.mp3', 'orc/kax/etc do not air Kannaka Radio sponsors');
  });

  await run('peek announces the sponsor but does NOT consume it', async () => {
    const { eng } = freshEngine();
    stageSponsor(eng);
    const peek = eng.peekNextTrack(); // next (idx 1) is the commercial
    assert.strictEqual(peek.file, 'radio-ads/ad_deadbeef.mp3', 'peek shows the sponsor for the intro');
    assert.strictEqual(eng.hasPendingSponsor(), true, 'peek did not consume the reservation');
    assert.strictEqual(eng._sponsorOverride, null, 'peek wrote no override');
  });

  await run('nextIsCommercial is a side-effect-free lookahead', async () => {
    const { eng } = freshEngine();
    assert.strictEqual(eng.nextIsCommercial(), true, 'idx 0 → next (idx 1) is the commercial');
    eng.state.currentTrackIdx = 1;
    assert.strictEqual(eng.nextIsCommercial(), false, 'idx 1 → next (idx 2) is music');
  });

  if (!failed) console.log('\nAll radio-ad-airing-hook tests passed');
  else process.exitCode = 1;
})();
