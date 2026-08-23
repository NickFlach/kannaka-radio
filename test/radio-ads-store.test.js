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

  await run('RESERVE advances no counter; CONFIRM does; a 2nd reserve same day is blocked', async () => {
    const first = await store.pickAiringForNow(morning);
    assert.ok(first, 'first reserve succeeds');
    assert.strictEqual(first.adId, adId);
    assert.strictEqual(first.airDate, '2026-08-22');
    // Reserve alone must NOT advance the run counter (the money invariant).
    let ad = await store.getAd(adId);
    assert.strictEqual(ad.airings_done, 0, 'reserve advances no counter');
    assert.strictEqual(ad.last_aired_date, null, 'reserve does not stamp last_aired_date');
    // A 2nd reserve the same day is blocked by the UNIQUE(ad_id,air_date) lock.
    const second = await store.pickAiringForNow(new Date(Date.UTC(2026, 7, 22, 10, 30)));
    assert.strictEqual(second, null, 'same-day re-reserve yields nothing');
    // Confirm the airing → NOW the counter advances (derived from the ledger).
    const c = await store.confirmAiring(first.adId, first.airDate);
    assert.strictEqual(c.counted, true);
    assert.strictEqual(c.airing, 1);
    ad = await store.getAd(adId);
    assert.strictEqual(ad.airings_done, 1, 'confirm advances the counter');
    assert.strictEqual(ad.last_aired_date, '2026-08-22');
  });

  await run('confirm is idempotent — a replay does not double-count', async () => {
    const again = await store.confirmAiring(adId, '2026-08-22');
    assert.strictEqual(again.counted, false, 'a second confirm is a no-op');
    const ad = await store.getAd(adId);
    assert.strictEqual(ad.airings_done, 1, 'counter unchanged on replay');
  });

  await run('an unconfirmed reservation is SWEPT on restart (no silent lost day)', async () => {
    // Reserve a fresh day but do NOT confirm — simulate a restart between
    // reserve and broadcast. Boot reconcile must delete the unconfirmed row so
    // the day is re-claimable and nothing was counted.
    const when = new Date(Date.UTC(2026, 7, 23, 9, 0)); // day 2, morning
    const r = await store.pickAiringForNow(when);
    assert.ok(r, 'reserved day 2');
    let rows = await store._all(`SELECT * FROM radio_ad_airings WHERE ad_id=? AND air_date='2026-08-23'`, [adId]);
    assert.strictEqual(rows.length, 1, 'reservation row present pre-restart');
    assert.strictEqual(rows[0].aired_at, null, 'reservation is unconfirmed');
    // "Restart": a fresh store on the same DB runs boot reconcile in init().
    const store2 = new RadioAdStore({ dbPath, assetDir });
    await store2.init();
    rows = await store2._all(`SELECT * FROM radio_ad_airings WHERE ad_id=? AND air_date='2026-08-23'`, [adId]);
    assert.strictEqual(rows.length, 0, 'boot reconcile swept the stranded reservation');
    const ad = await store2.getAd(adId);
    assert.strictEqual(ad.airings_done, 1, 'no counter movement from the stranded day');
    // The day is claimable again — the customer did not lose it.
    const r2 = await store2.pickAiringForNow(when);
    assert.ok(r2 && r2.adId === adId, 'the swept day can be re-reserved');
    await store2.confirmAiring(r2.adId, r2.airDate); // count it for real
  });

  await run('a CONFIRMED airing survives a restart (once-per-day holds)', async () => {
    // day 2 was just confirmed above; a fresh store must not re-air it.
    const store2 = new RadioAdStore({ dbPath, assetDir });
    await store2.init();
    const again = await store2.pickAiringForNow(new Date(Date.UTC(2026, 7, 23, 11, 0)));
    assert.strictEqual(again, null, 'a confirmed day cannot be re-aired after restart');
  });

  await run('run terminates at run_days CONFIRMED airings, then completes', async () => {
    // days 1,2 confirmed; walk days 3..7, reserve+confirm each.
    for (let day = 3; day <= 7; day++) {
      const when = new Date(Date.UTC(2026, 7, 21 + day, 9, 0));
      const r = await store.pickAiringForNow(when);
      assert.ok(r, `day ${day} reserves`);
      const c = await store.confirmAiring(r.adId, r.airDate);
      assert.strictEqual(c.airing, day, `day ${day} is the ${day}th confirmed airing`);
    }
    const ad = await store.getAd(adId);
    assert.strictEqual(ad.status, 'completed', 'after 7 CONFIRMED airings the run completes');
    assert.strictEqual(ad.airings_done, 7);
    // Day 8: nothing (completed, not scheduled).
    const past = await store.pickAiringForNow(new Date(Date.UTC(2026, 7, 29, 9, 0)));
    assert.strictEqual(past, null);
    assert.strictEqual(await store.confirmedAirings(adId), 7, 'all 7 days physically aired');
  });

  await run('kill releases an unconfirmed reservation and fires the sync eviction', async () => {
    const d = await store.createDraft({ text: 'This spot will be killed before it ever airs', band: 'morning' });
    await store.renderAd(d.id, fakeVoiceDJ);
    await store._run(`UPDATE radio_ads SET status='approved' WHERE id=?`, [d.id]);
    const killWhen = new Date(Date.UTC(2026, 8, 1, 9, 0));
    await store.scheduleAd(d.id, killWhen);
    // Reserve today, then kill before it airs.
    const r = await store.pickAiringForNow(killWhen);
    assert.ok(r && r.adId === d.id, 'reserved');
    let evicted = null;
    store.setKillListener((id) => { evicted = id; }); // engine eviction hook
    await store.killAd(d.id, killWhen);
    assert.strictEqual(evicted, d.id, 'kill fired the synchronous engine eviction');
    const rows = await store._all(`SELECT * FROM radio_ad_airings WHERE ad_id=?`, [d.id]);
    assert.strictEqual(rows.length, 0, 'the unconfirmed reservation was released');
    const ad = await store.getAd(d.id);
    assert.strictEqual(ad.status, 'killed');
    assert.strictEqual(ad.airings_done, 0, 'a killed ad never counted');
    store.setKillListener(null);
  });

  await run('confirm after kill: it aired once, is NOT counted, row is kept', async () => {
    // Kill lands in the same tick as a spot that is already going out: reserve,
    // kill (releases the reservation), but the audio was already on air so the
    // engine still confirms. A re-reserve would be needed since kill released;
    // instead simulate the race directly: reserve, confirm, THEN kill.
    const d = await store.createDraft({ text: 'A spot that airs the same instant it is killed off', band: 'morning' });
    await store.renderAd(d.id, fakeVoiceDJ);
    await store._run(`UPDATE radio_ads SET status='approved' WHERE id=?`, [d.id]);
    const when = new Date(Date.UTC(2026, 8, 3, 9, 0));
    await store.scheduleAd(d.id, when);
    const r = await store.pickAiringForNow(when);
    // Race: status flips to killed after the spot physically aired but before
    // confirm runs.
    await store._run(`UPDATE radio_ads SET status='killed' WHERE id=?`, [d.id]);
    const c = await store.confirmAiring(r.adId, r.airDate);
    assert.strictEqual(c.counted, false, 'a killed ad that already aired is not counted');
    assert.strictEqual(c.reason, 'not_scheduled');
    const rows = await store._all(`SELECT * FROM radio_ad_airings WHERE ad_id=? AND aired_at IS NOT NULL`, [d.id]);
    assert.strictEqual(rows.length, 1, 'the confirmed row is kept (it aired once; once/day holds)');
  });

  await run('wrong-band ads are not reserved', async () => {
    const d = await store.createDraft({ text: 'An evening-only advertisement for night owls', band: 'evening' });
    await store.renderAd(d.id, fakeVoiceDJ);
    await store._run(`UPDATE radio_ads SET status='approved' WHERE id=?`, [d.id]);
    await store.scheduleAd(d.id, new Date(Date.UTC(2026, 8, 2, 20, 0)));
    const morningPick = await store.pickAiringForNow(new Date(Date.UTC(2026, 8, 2, 9, 0))); // morning
    assert.strictEqual(morningPick, null, 'evening ad not reserved in the morning');
    const eveningPick = await store.pickAiringForNow(new Date(Date.UTC(2026, 8, 2, 20, 0)));
    assert.ok(eveningPick && eveningPick.adId === d.id, 'evening ad reserves in the evening');
  });

  await run('the UNIQUE ledger row blocks a re-reserve (CAS, not just the filter)', async () => {
    // Reach the INSERT with the eligibleForBand filter NOT excluding the ad
    // (last_aired_date null) but a reservation row already present for today —
    // only the UNIQUE constraint can stop the re-reserve.
    const when = new Date(Date.UTC(2026, 9, 5, 9, 0)); // morning, a fresh day
    const day = when.toISOString().slice(0, 10);
    const d = await store.createDraft({ text: 'A spot to prove the ledger CAS blocks a re-air', band: 'morning' });
    await store.renderAd(d.id, fakeVoiceDJ);
    await store._run(`UPDATE radio_ads SET status='approved' WHERE id=?`, [d.id]);
    await store.scheduleAd(d.id, when);
    await store._run(`INSERT INTO radio_ad_airings (ad_id, air_date) VALUES (?, ?)`, [d.id, day]);
    const elig = await store.eligibleForBand('morning', when);
    assert.ok(elig.some((a) => a.id === d.id), 'candidate passes the filter (last_aired_date null)');
    const pick = await store.pickAiringForNow(when);
    assert.strictEqual(pick, null, 'the ledger UNIQUE row blocks the reserve');
    const ad = await store.getAd(d.id);
    assert.strictEqual(ad.airings_done, 0, 'a blocked reserve does not advance the counter');
  });

  await run('releaseReservation removes only an UNCONFIRMED row', async () => {
    // Operate directly on this ad's ledger rows — candidate ordering across
    // other still-scheduled morning ads must not decide what we test here.
    const d = await store.createDraft({ text: 'A spot to prove release only touches unconfirmed rows', band: 'morning' });
    await store.renderAd(d.id, fakeVoiceDJ);
    await store._run(`UPDATE radio_ads SET status='scheduled', run_start_date='2026-10-06' WHERE id=?`, [d.id]);
    // An unconfirmed reservation IS releasable.
    await store._run(`INSERT INTO radio_ad_airings (ad_id, air_date) VALUES (?, '2026-10-06')`, [d.id]);
    const relOpen = await store.releaseReservation(d.id, '2026-10-06');
    assert.strictEqual(relOpen.released, true, 'an unconfirmed reservation is released');
    assert.strictEqual((await store._all(`SELECT * FROM radio_ad_airings WHERE ad_id=?`, [d.id])).length, 0);
    // A CONFIRMED row is immutable — release must NOT remove it.
    await store._run(`INSERT INTO radio_ad_airings (ad_id, air_date) VALUES (?, '2026-10-07')`, [d.id]);
    await store.confirmAiring(d.id, '2026-10-07');
    const relDone = await store.releaseReservation(d.id, '2026-10-07');
    assert.strictEqual(relDone.released, false, 'a confirmed row cannot be released');
    const rows = await store._all(`SELECT * FROM radio_ad_airings WHERE ad_id=? AND aired_at IS NOT NULL`, [d.id]);
    assert.strictEqual(rows.length, 1, 'the confirmed airing survives a release attempt');
  });

  await run('migration: an OLD-shape airings table upgrades in place, history preserved', async () => {
    // Seed a pre-reserve/confirm DB: aired_at NOT NULL, no reserved_at, 2 rows.
    const sqlite3 = require('sqlite3');
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-ads-old-'));
    const oldDbPath = path.join(oldDir, 'radio-ads.db');
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(oldDbPath, (e) => {
        if (e) return reject(e);
        db.serialize(() => {
          db.run(`CREATE TABLE radio_ad_airings (ad_id TEXT NOT NULL, air_date TEXT NOT NULL, aired_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (ad_id, air_date))`);
          db.run(`INSERT INTO radio_ad_airings (ad_id, air_date, aired_at) VALUES ('ad_old', '2026-08-01', '2026-08-01 09:00:00')`);
          db.run(`INSERT INTO radio_ad_airings (ad_id, air_date, aired_at) VALUES ('ad_old', '2026-08-02', '2026-08-02 09:00:00')`, (e2) => (e2 ? reject(e2) : db.close(resolve)));
        });
      });
    });
    // Open a store → _migrate rebuilds to reserve/confirm shape.
    const migrated = new RadioAdStore({ dbPath: oldDbPath, assetDir: path.join(oldDir, 'ads') });
    await migrated.init();
    const cols = await migrated._all(`PRAGMA table_info(radio_ad_airings)`);
    assert.ok(cols.some((c) => c.name === 'reserved_at'), 'reserved_at column added');
    assert.ok(cols.some((c) => c.name === 'aired_at'), 'aired_at retained');
    // Both historical rows survive as CONFIRMED (aired_at preserved) — boot
    // reconcile must NOT delete them.
    const rows = await migrated._all(`SELECT * FROM radio_ad_airings WHERE ad_id='ad_old' ORDER BY air_date`);
    assert.strictEqual(rows.length, 2, 'both historical airings preserved');
    assert.strictEqual(rows[0].aired_at, '2026-08-01 09:00:00', 'aired_at value carried over');
    assert.strictEqual(rows[0].reserved_at, '2026-08-01 09:00:00', 'reserved_at backfilled from aired_at');
    assert.strictEqual(await migrated.confirmedAirings('ad_old'), 2);
    migrated.db.close();
    // A 2nd boot is idempotent (reserved_at present → no rebuild) and preserves history.
    const reboot = new RadioAdStore({ dbPath: oldDbPath, assetDir: path.join(oldDir, 'ads') });
    await reboot.init();
    assert.strictEqual((await reboot._all(`SELECT * FROM radio_ad_airings WHERE ad_id='ad_old'`)).length, 2, 'idempotent — history intact on 2nd boot');
    reboot.db.close();
    try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  await run('previewRender freezes a servable render; identical text is a cache hit', async () => {
    const p1 = await store.previewRender('  Try our brand-new preview spot today  ', fakeVoiceDJ);
    assert.strictEqual(p1.cached, false);
    assert.ok(/^radio-ads\/ad_[0-9a-f]{16}\.mp3$/.test(p1.file) || p1.file.includes('ad_'), 'url-shaped rel path');
    assert.ok(fs.existsSync(path.join(assetDir, `ad_${p1.contentHash}.mp3`)));
    const p2 = await store.previewRender('Try our brand-new preview spot today', fakeVoiceDJ);
    assert.strictEqual(p2.cached, true, 'same normalized text reuses the frozen render');
    assert.strictEqual(p1.contentHash, p2.contentHash);
  });

  await run('pruneUnreferencedPreviews deletes only abandoned+old renders, keeps paid + fresh', async () => {
    // Abandoned old preview: a render file with no db row, aged past the grace.
    const abandoned = path.join(assetDir, 'ad_' + 'a'.repeat(16) + '.mp3');
    fs.writeFileSync(abandoned, 'old-preview-audio');
    const old = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    fs.utimesSync(abandoned, old / 1000, old / 1000);
    // Fresh preview: aged inside the grace window — must survive.
    const fresh = path.join(assetDir, 'ad_' + 'b'.repeat(16) + '.mp3');
    fs.writeFileSync(fresh, 'fresh-preview-audio');
    // A paid ad's render (referenced by tts_file) — must survive even if old.
    const paid = await store.createDraft({ text: 'A paid ad whose render must never be pruned away', band: 'morning' });
    await store.renderAd(paid.id, fakeVoiceDJ);
    const paidFile = path.join(assetDir, `ad_${paid.contentHash}.mp3`);
    fs.utimesSync(paidFile, old / 1000, old / 1000); // make it old too
    // A non-matching file must be ignored entirely.
    const foreign = path.join(assetDir, 'not-an-ad.mp3');
    fs.writeFileSync(foreign, 'unrelated');
    fs.utimesSync(foreign, old / 1000, old / 1000);

    const res = await store.pruneUnreferencedPreviews();
    assert.ok(res.deleted >= 1, 'at least the abandoned old preview is deleted');
    assert.strictEqual(fs.existsSync(abandoned), false, 'abandoned old preview deleted');
    assert.strictEqual(fs.existsSync(fresh), true, 'fresh preview kept (inside grace)');
    assert.strictEqual(fs.existsSync(paidFile), true, 'paid/referenced render kept even when old');
    assert.strictEqual(fs.existsSync(foreign), true, 'non ad_<hash> file untouched');
  });

  store.db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (!failed) console.log('\nAll radio-ads-store tests passed');
  else process.exitCode = 1;
})();
