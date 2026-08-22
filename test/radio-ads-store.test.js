'use strict';

// radio-ads-store.test.js — the durable store + the airing CAS.
//
// The load-bearing property: an ad airs AT MOST once per station-day, that
// count survives a "restart" (a fresh store on the same DB file), and a run
// terminates at run_days. Uses a temp SQLite file + a fake VoiceDJ.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RadioAdStore } = require('../server/radio-ads');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-ads-'));
const dbPath = path.join(tmp, 'radio-ads.db');
const assetDir = path.join(tmp, 'ads');

// Fake VoiceDJ: writes a stand-in "mp3" to a tmp path and calls back.
const fakeVoiceDJ = {
  generateTTS(text, cb) {
    const p = path.join(tmp, 'tts-' + Math.abs(hashish(text)) + '.mp3');
    fs.writeFileSync(p, 'ID3-fake-audio-' + text.slice(0, 8));
    setImmediate(() => cb(null, p, text));
  },
};
function hashish(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

let failed = 0;
async function run(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; } }

(async () => {
  console.log('radio-ads-store.test.js');

  const store = new RadioAdStore({ dbPath, assetDir });
  await store.init();

  let adId;
  await run('createDraft validates + stores, render freezes an asset, reused by hash', async () => {
    const d = await store.createDraft({ text: '  Buy fresh widgets from Acme, now on sale  ', band: 'morning' });
    adId = d.id;
    assert.ok(adId.startsWith('ad_'));
    const r1 = await store.renderAd(adId, fakeVoiceDJ);
    assert.strictEqual(r1.cached, false);
    assert.ok(fs.existsSync(path.join(assetDir, `ad_${d.contentHash}.mp3`)));
    const r2 = await store.renderAd(adId, fakeVoiceDJ);
    assert.strictEqual(r2.cached, true, 'same hash reuses the render, no re-TTS');
    assert.strictEqual(r1.file, r2.file);
  });

  await run('an unrendered ad cannot be scheduled', async () => {
    const d = await store.createDraft({ text: 'Another perfectly good advertisement here', band: 'morning' });
    await store._run(`UPDATE radio_ads SET status='approved' WHERE id=?`, [d.id]);
    await assert.rejects(() => store.scheduleAd(d.id), /no rendered audio/);
  });

  // Force the ad into the morning band + scheduled for a deterministic clock.
  const morning = new Date(Date.UTC(2026, 7, 22, 9, 0)); // 09:00 UTC = morning
  await run('scheduleAd requires approved; idempotent', async () => {
    await store._run(`UPDATE radio_ads SET status='approved', band='morning' WHERE id=?`, [adId]);
    const s1 = await store.scheduleAd(adId, morning);
    assert.strictEqual(s1.status, 'scheduled');
    const s2 = await store.scheduleAd(adId, morning);
    assert.strictEqual(s2.already, true);
  });

  await run('airs once per day; a second pick same day does NOT re-air (CAS)', async () => {
    const first = await store.pickAiringForNow(morning);
    assert.ok(first, 'first pick airs');
    assert.strictEqual(first.adId, adId);
    assert.strictEqual(first.airing, 1);
    const second = await store.pickAiringForNow(new Date(Date.UTC(2026, 7, 22, 10, 30))); // still morning, same day
    assert.strictEqual(second, null, 'same-day re-pick yields nothing');
  });

  await run('the once-per-day guard survives a restart (fresh store, same DB)', async () => {
    const store2 = new RadioAdStore({ dbPath, assetDir });
    await store2.init();
    const again = await store2.pickAiringForNow(new Date(Date.UTC(2026, 7, 22, 11, 0))); // same day, after "restart"
    assert.strictEqual(again, null, 'restart cannot double-air the day');
  });

  await run('airs on the next day; run terminates at run_days then completes', async () => {
    // Walk days 2..7. Each day the morning band should air exactly once.
    for (let day = 2; day <= 7; day++) {
      const when = new Date(Date.UTC(2026, 7, 21 + day, 9, 0));
      const pick = await store.pickAiringForNow(when);
      assert.ok(pick, `day ${day} should air`);
      assert.strictEqual(pick.airing, day);
    }
    const ad = await store.getAd(adId);
    assert.strictEqual(ad.status, 'completed', 'after 7 airings the ad completes');
    assert.strictEqual(ad.airings_done, 7);
    // Day 8: nothing (completed, not scheduled).
    const past = await store.pickAiringForNow(new Date(Date.UTC(2026, 7, 29, 9, 0)));
    assert.strictEqual(past, null);
  });

  await run('kill stops a scheduled ad before it airs', async () => {
    const d = await store.createDraft({ text: 'This spot will be killed before it ever airs', band: 'morning' });
    await store.renderAd(d.id, fakeVoiceDJ);
    await store._run(`UPDATE radio_ads SET status='approved' WHERE id=?`, [d.id]);
    await store.scheduleAd(d.id, morning);
    await store.killAd(d.id);
    const pick = await store.pickAiringForNow(new Date(Date.UTC(2026, 8, 1, 9, 0)));
    assert.strictEqual(pick, null, 'a killed ad never airs');
    const ad = await store.getAd(d.id);
    assert.strictEqual(ad.status, 'killed');
  });

  await run('wrong-band ads are not picked', async () => {
    const d = await store.createDraft({ text: 'An evening-only advertisement for night owls', band: 'evening' });
    await store.renderAd(d.id, fakeVoiceDJ);
    await store._run(`UPDATE radio_ads SET status='approved' WHERE id=?`, [d.id]);
    await store.scheduleAd(d.id, new Date(Date.UTC(2026, 8, 2, 20, 0)));
    const morningPick = await store.pickAiringForNow(new Date(Date.UTC(2026, 8, 2, 9, 0))); // morning
    assert.strictEqual(morningPick, null, 'evening ad not aired in the morning');
    const eveningPick = await store.pickAiringForNow(new Date(Date.UTC(2026, 8, 2, 20, 0)));
    assert.ok(eveningPick && eveningPick.adId === d.id, 'evening ad airs in the evening');
  });

  await run('the UNIQUE ledger row itself blocks a re-air (CAS, not just the filter)', async () => {
    // Reach the INSERT path with the eligibleForBand filter NOT excluding the
    // ad: last_aired_date cleared, but a claim row already present for today.
    // This exercises the actual CAS (the crash-between-INSERT-and-UPDATE
    // state) rather than the last_aired_date fast-path the other tests hit.
    const when = new Date(Date.UTC(2026, 9, 5, 9, 0)); // morning, a fresh day
    const day = when.toISOString().slice(0, 10);
    const d = await store.createDraft({ text: 'A spot to prove the ledger CAS blocks a re-air', band: 'morning' });
    await store.renderAd(d.id, fakeVoiceDJ);
    await store._run(`UPDATE radio_ads SET status='approved' WHERE id=?`, [d.id]);
    await store.scheduleAd(d.id, when);
    // Simulate "claimed today but counter never advanced" (the crash window):
    await store._run(`INSERT INTO radio_ad_airings (ad_id, air_date) VALUES (?, ?)`, [d.id, day]);
    // last_aired_date is still NULL, so eligibleForBand WILL return it — the
    // only thing that can stop the re-air is the UNIQUE constraint.
    const elig = await store.eligibleForBand('morning', when);
    assert.ok(elig.some((a) => a.id === d.id), 'candidate passes the filter (last_aired_date null)');
    const pick = await store.pickAiringForNow(when);
    assert.strictEqual(pick, null, 'the ledger UNIQUE row blocks the claim → no re-air');
    const ad = await store.getAd(d.id);
    assert.strictEqual(ad.airings_done, 0, 'a blocked claim does not advance the counter');
  });

  store.db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (!failed) console.log('\nAll radio-ads-store tests passed');
  else process.exitCode = 1;
})();
