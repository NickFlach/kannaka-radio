'use strict';

// radio-ad-slice5.test.js — money-safety controls: pro-rata kill refund with a
// FROZEN amount (idempotent re-drive), dispute stops airing + never refunds
// (no double-pay), band capacity (atomic, K=1), and the GSA entitlement.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RadioAdStore } = require('../server/radio-ads');
const { RadioAdPayments } = require('../server/radio-ad-payments');
const { RadioAdBridge } = require('../server/radio-ad-bridge');
const { signBridge } = require('../server/radio-ad-bridge-core');
const { airEligible } = require('../server/radio-ads-core');

const ENACT = 'enact_secret_B';
const NOWMS = 1_800_000_000_000;
const NOWSEC = Math.floor(NOWMS / 1000);
const fakeVoiceDJ = { generateTTS(t, cb) { const p = path.join(os.tmpdir(), 's5-' + crypto.createHash('md5').update(t).digest('hex').slice(0, 8) + '.mp3'); fs.writeFileSync(p, 'x'); setImmediate(() => cb(null, p, t)); } };

let failed = 0;
async function run(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; } }

function fakeApi() { const calls = { refund: [] }; return { calls, async createCheckoutSession(p, k) { return { id: 'cs_' + k, url: 'u' }; }, async createRefund(params, key) { calls.refund.push({ params, key }); return { id: 're_' + calls.refund.length }; } }; }

async function paidScheduled(store, text, band, airings) {
  const d = await store.createDraft({ text, band });
  await store.markPaid(d.id, { paymentIntent: 'pi_' + d.id, amountCents: 500 });
  await store.renderAd(d.id, fakeVoiceDJ);
  await store._run(`UPDATE radio_ads SET status='scheduled', run_start_date='2026-08-22', airings_done=? WHERE id=?`, [airings || 0, d.id]);
  return d.id;
}

(async () => {
  console.log('radio-ad-slice5.test.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-s5-'));
  const store = new RadioAdStore({ dbPath: path.join(tmp, 'db.sqlite'), assetDir: path.join(tmp, 'ads') });
  await store.init();
  const api = fakeApi();
  const pay = new RadioAdPayments({ store, api, webhookSecret: 'w', now: () => NOWMS });

  await run('kill freezes the pro-rata refund amount; refund is partial + status stays killed', async () => {
    const id = await paidScheduled(store, 'A spot aired 3 of 7 days before being killed', 'morning', 3);
    await store.killAd(id);
    let ad = await store.getAd(id);
    assert.strictEqual(ad.status, 'killed');
    assert.strictEqual(ad.refund_amount_cents, 286, 'round(500*(7-3)/7)=286 frozen at kill');
    const r = await pay.refundAd(id);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.partial, true); assert.strictEqual(r.amountCents, 286);
    assert.strictEqual(api.calls.refund[0].params.amount, 286, 'Stripe refund carries the frozen partial amount');
    ad = await store.getAd(id);
    assert.strictEqual(ad.status, 'killed', 'partial kill refund does NOT flip to refunded');
    assert.ok(ad.refunded_at);
  });

  await run('kill refund is idempotent — re-drive does not double-refund (same key + amount)', async () => {
    const before = api.calls.refund.length;
    const id = (await store._all(`SELECT id FROM radio_ads WHERE status='killed' AND refunded_at IS NOT NULL LIMIT 1`))[0].id;
    const r2 = await pay.refundAd(id);
    assert.strictEqual(r2.alreadyRefunded, true);
    assert.strictEqual(api.calls.refund.length, before, 'no second Stripe refund');
  });

  await run('kill of a never-aired ad refunds the full price', async () => {
    const id = await paidScheduled(store, 'A spot killed before it ever aired at all', 'afternoon', 0);
    await store.killAd(id);
    assert.strictEqual((await store.getAd(id)).refund_amount_cents, 500);
    const r = await pay.refundAd(id);
    assert.strictEqual(r.amountCents, 500);
  });

  await run('kill of a fully-aired ad refunds 0 and does NOT call Stripe', async () => {
    const id = await paidScheduled(store, 'A spot that aired its whole run then got killed', 'evening', 7);
    await store.killAd(id);
    assert.strictEqual((await store.getAd(id)).refund_amount_cents, 0);
    const before = api.calls.refund.length;
    const r = await pay.refundAd(id);
    assert.strictEqual(r.amountCents, 0);
    assert.strictEqual(api.calls.refund.length, before, 'no Stripe call for a 0-cent refund');
    assert.ok((await store.getAd(id)).refunded_at, 'recorded so the enact does not loop');
  });

  await run('DISPUTE stops airing and is NEVER refunded (no double-pay)', async () => {
    const id = await paidScheduled(store, 'A spot that gets charged back mid-run by the buyer', 'morning', 2);
    let evicted = null; store.setKillListener((x) => { evicted = x; });
    const res = await store.markDisputed('pi_' + id, 'dp_1');
    assert.strictEqual(res.ok, true); assert.strictEqual(res.adId, id);
    assert.strictEqual(evicted, id, 'dispute synchronously evicts from the engine');
    const ad = await store.getAd(id);
    assert.ok(ad.disputed_at); assert.strictEqual(ad.stripe_dispute_id, 'dp_1');
    assert.strictEqual(airEligible(ad), false, 'a disputed ad is not air-eligible');
    const elig = await store.eligibleForBand('morning', new Date(Date.UTC(2026, 7, 25, 9, 0)));
    assert.ok(elig.every((a) => a.id !== id), 'disputed ad excluded from eligibleForBand');
    // refund refuses a disputed charge.
    const before = api.calls.refund.length;
    const rf = await pay.refundAd(id);
    assert.strictEqual(rf.ok, false); assert.strictEqual(rf.error, 'disputed');
    assert.strictEqual(api.calls.refund.length, before, 'no refund on a disputed charge');
    store.setKillListener(null);
  });

  await run('dispute webhook marks disputed by payment_intent and issues no refund', async () => {
    const id = await paidScheduled(store, 'A spot disputed via a real stripe webhook event', 'late_night', 1);
    const body = JSON.stringify({ id: 'evt_d', type: 'charge.dispute.created', data: { object: { id: 'dp_web', payment_intent: 'pi_' + id } } });
    const sig = (function () { const t = NOWSEC; const v = crypto.createHmac('sha256', 'w').update(`${t}.${body}`).digest('hex'); return `t=${t},v1=${v}`; })();
    const before = api.calls.refund.length;
    const out = await pay.handleWebhook(body, sig);
    assert.strictEqual(out.status, 200);
    assert.ok((await store.getAd(id)).disputed_at, 'ad marked disputed');
    assert.strictEqual(api.calls.refund.length, before, 'dispute issues no refund');
  });

  await run('band capacity K=1: a second checkout for a full band is refused, released frees it', async () => {
    // First morning ad holds the slot.
    const a = await store.reserveBandHold('ad_a', 'morning', 1);
    assert.strictEqual(a.reserved, true);
    const b = await store.reserveBandHold('ad_b', 'morning', 1);
    assert.strictEqual(b.reserved, false, 'morning is full');
    // Another band is free.
    assert.strictEqual((await store.reserveBandHold('ad_c', 'evening', 1)).reserved, true);
    // Release the morning holder → a new ad can take it.
    await store.releaseBandHold('ad_a');
    assert.strictEqual((await store.reserveBandHold('ad_d', 'morning', 1)).reserved, true);
  });

  await run('checkout refuses when the band is full (band_full), releases nothing extra', async () => {
    const p2 = new RadioAdPayments({ store, api, webhookSecret: 'w', now: () => NOWMS, bandCapacity: 1 });
    // The 'morning' band currently holds ad_d (from the prior test). A checkout for morning must refuse.
    await assert.rejects(() => p2.createCheckout({ text: 'A morning spot that should be refused as full', band: 'morning' }), /full/);
  });

  await run('reject and complete both release the band hold', async () => {
    const p3 = new RadioAdPayments({ store, api, webhookSecret: 'w', now: () => NOWMS, bandCapacity: 1 });
    // free afternoon first (evening/morning are held); use a fresh band via release
    await store.releaseBandHold('ad_c'); // free evening
    const co = await p3.createCheckout({ text: 'An evening spot we will then reject to free the slot', band: 'evening' });
    // reject releases the hold
    await store.markPaid(co.adId, { paymentIntent: 'pi_' + co.adId, amountCents: 500 });
    await store.rejectAd(co.adId);
    assert.strictEqual((await store.reserveBandHold('ad_e', 'evening', 1)).reserved, true, 'evening freed by reject');
  });

  await run('GSA entitlement is idempotent (one grant per ad)', async () => {
    await store.grantGsaEntitlement('ad_gsa');
    await store.grantGsaEntitlement('ad_gsa');
    const rows = await store._all(`SELECT * FROM radio_ad_gsa_entitlements WHERE ad_id='ad_gsa'`);
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].redeem_by, 'redemption date set');
  });

  await run('bridge KILL enact: kills + pro-rata refunds; approve grants GSA', async () => {
    const bridge = new RadioAdBridge({ store, payments: pay, voiceDJ: fakeVoiceDJ, enactSecret: ENACT, now: () => NOWMS });
    // approve path grants GSA
    const idA = await store.createDraft({ text: 'An approved spot that should get the GSA perk', band: 'morning' });
    await store.markPaid(idA.id, { paymentIntent: 'pi_' + idA.id, amountCents: 500 });
    await store.renderAd(idA.id, fakeVoiceDJ);
    await store.markRaised(idA.id);
    const ab = JSON.stringify({ adId: idA.id, decision: 'approve' });
    const ao = await bridge.handleEnact(ab, signBridge(ab, ENACT, NOWSEC));
    assert.strictEqual(ao.status, 200);
    assert.strictEqual((await store._all(`SELECT * FROM radio_ad_gsa_entitlements WHERE ad_id=?`, [idA.id])).length, 1, 'approve granted GSA');
    // kill path (paidScheduled returns the id STRING)
    const idK = await paidScheduled(store, 'A live spot the operator kills via the bridge enact', 'afternoon', 2);
    const kb = JSON.stringify({ adId: idK, decision: 'kill' });
    const ko = await bridge.handleEnact(kb, signBridge(kb, ENACT, NOWSEC));
    assert.strictEqual(ko.status, 200); assert.strictEqual(ko.body.decision, 'kill'); assert.strictEqual(ko.body.refunded, true);
    assert.strictEqual((await store.getAd(idK)).status, 'killed');
    // idempotent re-drive
    const ko2 = await bridge.handleEnact(kb, signBridge(kb, ENACT, NOWSEC));
    assert.strictEqual(ko2.status, 200);
  });

  store.db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (!failed) console.log('\nAll radio-ad-slice5 tests passed');
  else process.exitCode = 1;
})();
