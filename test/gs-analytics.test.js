'use strict';

// gs-analytics.test.js — GSA store + worker-thread runner integration:
// entitlement redemption (at-most-once + rotation + live revocation), dataset
// lifecycle with boot reconcile, scoping, and an end-to-end worker analysis.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RadioAdStore } = require('../server/radio-ads');
const { GsaStore } = require('../server/gs-analytics');
const { GsaRunner } = require('../server/gs-analytics-runner');

let failed = 0;
async function run(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; } }

(async () => {
  console.log('gs-analytics.test.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsa-'));
  const radio = new RadioAdStore({ dbPath: path.join(tmp, 'db.sqlite'), assetDir: path.join(tmp, 'ads') });
  await radio.init();
  const gsa = new GsaStore({ radioStore: radio, dataDir: path.join(tmp, 'gsa') });
  await gsa.migrate();
  const runner = new GsaRunner();

  // A granted entitlement to redeem (the slice-5 grant path).
  await radio.grantGsaEntitlement('ad_alpha1234');

  let token;
  await run('redeem: at-most-once CAS mints a token; month runs from redemption', async () => {
    const r = await gsa.redeem('ad_alpha1234');
    assert.strictEqual(r.ok, true);
    assert.ok(r.token && r.token.length >= 40);
    assert.ok(r.expiresAt, 'account_expires_at set (+30d from redemption)');
    token = r.token;
    const acct = await gsa.auth(token);
    assert.ok(acct && acct.adId === 'ad_alpha1234', 'token authenticates');
  });

  await run('re-presenting the ad id ROTATES the token (old one dies)', async () => {
    const r2 = await gsa.redeem('ad_alpha1234');
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.rotated, true);
    assert.ok(await gsa.auth(r2.token), 'new token works');
    assert.strictEqual(await gsa.auth(token), null, 'old token no longer works');
    token = r2.token;
  });

  await run('redeem guards: unknown / revoked / offer-expired', async () => {
    assert.strictEqual((await gsa.redeem('ad_nope9999')).error, 'no_entitlement');
    assert.strictEqual((await gsa.redeem('not an id')).error, 'bad_ad_id');
    await radio.grantGsaEntitlement('ad_revoked99');
    await radio._run(`UPDATE radio_ad_gsa_entitlements SET revoked_at=datetime('now') WHERE ad_id='ad_revoked99'`);
    assert.strictEqual((await gsa.redeem('ad_revoked99')).error, 'revoked');
    await radio.grantGsaEntitlement('ad_late5678');
    await radio._run(`UPDATE radio_ad_gsa_entitlements SET redeem_by=datetime('now','-1 day') WHERE ad_id='ad_late5678'`);
    assert.strictEqual((await gsa.redeem('ad_late5678')).error, 'offer_expired');
  });

  await run('revocation applies LIVE: a disputed/refunded ad loses access mid-session', async () => {
    await radio.grantGsaEntitlement('ad_chback12');
    const r = await gsa.redeem('ad_chback12');
    assert.ok(await gsa.auth(r.token), 'access works before the chargeback');
    await radio._run(`UPDATE radio_ad_gsa_entitlements SET revoked_at=datetime('now') WHERE ad_id='ad_chback12'`);
    assert.strictEqual(await gsa.auth(r.token), null, 'revocation ends the session immediately');
  });

  await run('full refund revokes the perk (markRefunded wiring)', async () => {
    const d = await radio.createDraft({ text: 'An ad that gets fully refunded and loses GSA', band: 'morning' });
    await radio.markPaid(d.id, { paymentIntent: 'pi_' + d.id, amountCents: 500 });
    await radio.grantGsaEntitlement(d.id);
    await radio.rejectAd(d.id);
    await radio.markRefunded(d.id, 're_x');
    const ent = await radio._get(`SELECT revoked_at FROM radio_ad_gsa_entitlements WHERE ad_id=?`, [d.id]);
    assert.ok(ent.revoked_at, 'entitlement revoked on full refund');
  });

  const account = { adId: 'ad_alpha1234' };
  let dsId;
  await run('dataset create + end-to-end worker analysis → ready report', async () => {
    let csv = 'date,units,revenue\n';
    for (let d = 0; d < 40; d++) csv += `2026-06-${String(1 + (d % 28)).padStart(2, '0')},${100 + 2 * d},${300 + 6 * d}\n`;
    const created = await gsa.createDataset(account, { name: 'sales <b>test</b>', kind: 'csv', bytes: Buffer.byteLength(csv), text: csv });
    assert.strictEqual(created.ok, true);
    dsId = created.id;
    assert.ok(fs.existsSync(path.join(tmp, 'gsa', dsId + '.blob')), 'blob written');
    assert.ok(await gsa.markAnalyzing(account.adId, dsId));
    const res = await runner.analyze('csv', csv);
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    await gsa.markReady(account.adId, dsId, res.report);
    const ds = await gsa.getDataset(account.adId, dsId);
    assert.strictEqual(ds.status, 'ready');
    const rep = JSON.parse(ds.report);
    assert.ok(rep.signals.length > 0, 'signals found');
    assert.ok(rep.columns.length === 3);
  });

  await run('worker: a hostile/bad dataset fails the JOB, not the process', async () => {
    const bad = await runner.analyze('json', '{"not":"an array"}');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.bad, true, 'classified as a bad dataset');
    const junk = await runner.analyze('csv', 'x');
    assert.strictEqual(junk.ok, false);
  });

  await run('runner: bounded queue reports busy beyond depth', async () => {
    const tiny = new GsaRunner({ queueMax: 1 });
    const p1 = tiny.analyze('csv', 'a,b\n1,2\n'); // occupies the single slot
    const p2 = await tiny.analyze('csv', 'a,b\n1,2\n'); // refused immediately
    assert.strictEqual(p2.busy, true);
    const r1 = await p1;
    assert.strictEqual(r1.ok, true);
  });

  await run('scoping: another account cannot see or delete the dataset', async () => {
    const other = { adId: 'ad_chback12' };
    assert.strictEqual(await gsa.getDataset(other.adId, dsId), undefined);
    const del = await gsa.deleteDataset(other.adId, dsId);
    assert.strictEqual(del.ok, false);
    assert.ok(await gsa.getDataset(account.adId, dsId), 'owner still sees it');
  });

  await run('quota enforced per account', async () => {
    // ACCOUNT_QUOTA is 10; one exists — add 9 then the 11th refuses.
    for (let i = 0; i < 9; i++) {
      const c = await gsa.createDataset(account, { name: 'q' + i, kind: 'csv', bytes: 10, text: 'a,b\n1,2\n' });
      assert.strictEqual(c.ok, true, 'fill ' + i);
    }
    const over = await gsa.createDataset(account, { name: 'over', kind: 'csv', bytes: 10, text: 'a,b\n1,2\n' });
    assert.strictEqual(over.error, 'quota');
  });

  await run('rotation cannot resurrect an EXPIRED account', async () => {
    await radio.grantGsaEntitlement('ad_expired77');
    const first = await gsa.redeem('ad_expired77');
    assert.strictEqual(first.ok, true);
    // Age the account past its expiry, then try to rotate a fresh token.
    await radio._run(`UPDATE radio_ad_gsa_entitlements SET account_expires_at=datetime('now','-1 day') WHERE ad_id='ad_expired77'`);
    const again = await gsa.redeem('ad_expired77');
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.error, 'account_expired', 'an expired month cannot be re-opened by re-presenting the ad id');
    assert.strictEqual(await gsa.auth(first.token), null, 'the old token is dead too');
  });

  await run('budget accounting: bytes counted ONCE and the reservation always releases', async () => {
    const before = gsa._inFlightBytes;
    const okDs = await gsa.createDataset({ adId: 'ad_chback12' }, { name: 'acct', kind: 'csv', bytes: 12, text: 'a,b\n1,2\n' });
    assert.strictEqual(okDs.ok, true);
    assert.strictEqual(gsa._inFlightBytes, before, 'reservation released after success');
    // A rejected upload (bad kind) must not leak a reservation either.
    const bad = await gsa.createDataset({ adId: 'ad_chback12' }, { name: 'x', kind: 'exe', bytes: 12, text: 'x' });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(gsa._inFlightBytes, before, 'reservation released after rejection');
    // Sum reflects live rows only (deleted excluded).
    const live = await gsa._liveBytes();
    await gsa.deleteDataset('ad_chback12', okDs.id);
    assert.ok((await gsa._liveBytes()) < live, 'deleting frees budget');
  });

  await run('boot reconcile: a restart mid-analysis marks the row failed, not stuck', async () => {
    await radio._run(`UPDATE gsa_datasets SET status='analyzing' WHERE id=?`, [dsId]);
    await gsa.migrate(); // simulates the boot pass
    const ds = await gsa.getDataset(account.adId, dsId);
    assert.strictEqual(ds.status, 'failed');
    assert.ok(/restart/.test(ds.error));
  });

  await run('a completion for a dataset deleted mid-analysis is DROPPED, not resurrected', async () => {
    // A fresh account: `account` has already hit its quota earlier in this file.
    const racer = { adId: 'ad_racer001' };
    const d = await gsa.createDataset(racer, { name: 'racy', kind: 'csv', bytes: 10, text: 'a,b\n1,2\n' });
    assert.strictEqual(d.ok, true, 'fresh account has quota');
    assert.ok(await gsa.markAnalyzing(racer.adId, d.id));
    // Customer hits Delete while the worker is still running.
    await gsa.deleteDataset(racer.adId, d.id);
    // Worker finishes and reports success + a failure for good measure.
    await gsa.markReady(racer.adId, d.id, { rowCount: 1, signals: [], caveats: [] });
    await gsa.markFailed(racer.adId, d.id, 'late failure');
    assert.strictEqual(await gsa.getDataset(racer.adId, d.id), undefined, 'stays deleted — never reappears with a missing blob');
    const raw = await radio._get(`SELECT status FROM gsa_datasets WHERE id=?`, [d.id]);
    assert.strictEqual(raw.status, 'deleted');
  });

  await run('a failed blob write leaves no .part behind, and the sweep collects stragglers', async () => {
    // Force a write failure by pointing the store at an unusable dir.
    const broken = new GsaStore({ radioStore: radio, dataDir: path.join(tmp, 'gsa', 'nope.blob', 'deeper') });
    const r = await broken.createDataset(account, { name: 'boom', kind: 'csv', bytes: 10, text: 'a,b\n1,2\n' });
    assert.strictEqual(r.ok, false, 'write failed as intended');
    // Now prove the sweep reclaims an abandoned .part in the real dir.
    const stray = path.join(tmp, 'gsa', 'ds_strayaaaa.blob.part-123-456');
    fs.writeFileSync(stray, 'partial');
    const old = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(stray, old / 1000, old / 1000);
    const swept = await gsa.sweep();
    assert.ok(swept.orphans >= 1, 'the .part was collected');
    assert.strictEqual(fs.existsSync(stray), false, 'abandoned .part removed — it is invisible to the byte budget');
  });

  await run('delete: row CAS first, blob unlinked', async () => {
    const del = await gsa.deleteDataset(account.adId, dsId);
    assert.strictEqual(del.ok, true);
    assert.strictEqual(await gsa.getDataset(account.adId, dsId), undefined);
    assert.ok(!fs.existsSync(path.join(tmp, 'gsa', dsId + '.blob')), 'blob gone');
  });

  radio.db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (!failed) console.log('\nAll gs-analytics tests passed');
  else process.exitCode = 1;
})();
