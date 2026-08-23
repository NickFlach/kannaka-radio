'use strict';

// radio-ad-payments.test.js — checkout + webhook + refund against a FAKE Stripe
// API (no network) and a real RadioAdStore (temp DB). Verifies the money
// mechanics: paid gate, idempotency, the 2nd settlement path, signature
// rejection, and confirmed-before-marked refunds.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RadioAdStore } = require('../server/radio-ads');
const { RadioAdPayments } = require('../server/radio-ad-payments');

const WHSEC = 'whsec_test_xyz';
const NOWMS = 1_800_000_000_000; // fixed clock (ms)
const NOWSEC = Math.floor(NOWMS / 1000);

function fakeApi() {
  const calls = { checkout: [], refund: [] };
  return {
    calls,
    async createCheckoutSession(params, idem) { calls.checkout.push({ params, idem }); return { id: 'cs_' + calls.checkout.length, url: 'https://checkout.stripe/' + calls.checkout.length }; },
    async createRefund(params, idem) { calls.refund.push({ params, idem }); return { id: 're_' + calls.refund.length }; },
  };
}

function signedEvent(event, secret = WHSEC, t = NOWSEC) {
  const body = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return { body, header: `t=${t},v1=${sig}` };
}

let failed = 0;
async function run(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; } }

(async () => {
  console.log('radio-ad-payments.test.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-pay-'));
  const store = new RadioAdStore({ dbPath: path.join(tmp, 'radio-ads.db'), assetDir: path.join(tmp, 'ads') });
  await store.init();

  const api = fakeApi();
  const pay = new RadioAdPayments({ store, api, webhookSecret: WHSEC, now: () => NOWMS });

  let adId;
  await run('createCheckout mints a draft + a Stripe session (idempotency key per draft)', async () => {
    const out = await pay.createCheckout({ text: 'Buy fresh widgets from Acme, on sale now', band: 'morning' });
    adId = out.adId;
    assert.ok(adId.startsWith('ad_'));
    assert.strictEqual(out.checkoutUrl, 'https://checkout.stripe/1');
    const ad = await store.getAd(adId);
    assert.strictEqual(ad.status, 'draft', 'unpaid until the webhook');
    assert.strictEqual(ad.stripe_session_id, 'cs_1');
    assert.strictEqual(api.calls.checkout[0].idem, `radio_ad_checkout:${adId}`);
    assert.deepStrictEqual(api.calls.checkout[0].params.payment_method_types, ['card']);
    assert.strictEqual(api.calls.checkout[0].params.line_items[0].price_data.unit_amount, 500);
  });

  await run('createCheckout rejects invalid text/band before charging', async () => {
    await assert.rejects(() => pay.createCheckout({ text: 'x', band: 'morning' }), /at least/);
    await assert.rejects(() => pay.createCheckout({ text: 'A perfectly valid advertisement here', band: 'noon' }), /invalid band/);
  });

  await run('webhook with a valid signature marks the ad PAID', async () => {
    const { body, header } = signedEvent({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 500, currency: 'usd', metadata: { radio_ad_id: adId } } } });
    const out = await pay.handleWebhook(body, header);
    assert.strictEqual(out.status, 200);
    const ad = await store.getAd(adId);
    assert.strictEqual(ad.status, 'paid');
    assert.strictEqual(ad.stripe_payment_intent, 'pi_1');
    assert.strictEqual(ad.amount_cents, 500);
    assert.ok(ad.paid_at);
  });

  await run('a duplicate paid webhook is idempotent (no double-apply)', async () => {
    const before = await store.getAd(adId);
    const { body, header } = signedEvent({ id: 'evt_1b', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 500, currency: 'usd', metadata: { radio_ad_id: adId } } } });
    const out = await pay.handleWebhook(body, header);
    assert.strictEqual(out.status, 200);
    const after = await store.getAd(adId);
    assert.strictEqual(after.status, 'paid');
    assert.strictEqual(after.paid_at, before.paid_at, 'paid_at unchanged on replay');
  });

  await run('an invalid signature is rejected (400) and changes nothing', async () => {
    const other = new RadioAdPayments({ store, api, webhookSecret: 'whsec_wrong', now: () => NOWMS });
    const draft = await pay.createCheckout({ text: 'Another spot to attempt a forged webhook', band: 'evening' });
    // Sign with the wrong secret relative to pay's secret.
    const { body, header } = signedEvent({ id: 'evt_x', type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_status: 'paid', payment_intent: 'pi_x', amount_total: 500, metadata: { radio_ad_id: draft.adId } } } }, 'whsec_forged');
    const out = await pay.handleWebhook(body, header);
    assert.strictEqual(out.status, 400);
    assert.strictEqual((await store.getAd(draft.adId)).status, 'draft', 'forged webhook did not pay the ad');
  });

  await run('2nd settlement path: payment_intent.succeeded alone also pays (id backfilled)', async () => {
    const draft = await pay.createCheckout({ text: 'A spot paid via the payment intent path only', band: 'afternoon' });
    const { body, header } = signedEvent({ id: 'evt_pi', type: 'payment_intent.succeeded', data: { object: { id: 'pi_only', amount_received: 500, currency: 'usd', metadata: { radio_ad_id: draft.adId } } } });
    const out = await pay.handleWebhook(body, header);
    assert.strictEqual(out.status, 200);
    const ad = await store.getAd(draft.adId);
    assert.strictEqual(ad.status, 'paid', 'paid via payment_intent alone');
    assert.strictEqual(ad.stripe_payment_intent, 'pi_only');
    assert.strictEqual(ad.stripe_session_id, draft.sessionId, 'session id from checkout creation stands');
    // The matching checkout.session.completed then arrives — still one payment.
    const ev2 = signedEvent({ id: 'evt_cs', type: 'checkout.session.completed', data: { object: { id: draft.sessionId, payment_status: 'paid', payment_intent: 'pi_only', amount_total: 500, currency: 'usd', metadata: { radio_ad_id: draft.adId } } } });
    await pay.handleWebhook(ev2.body, ev2.header);
    const ad2 = await store.getAd(draft.adId);
    assert.strictEqual(ad2.status, 'paid');
    assert.strictEqual(ad2.paid_at, ad.paid_at, 'still one payment (idempotent across both event types)');
  });

  await run('an unpaid checkout.session.completed does NOT pay', async () => {
    const draft = await pay.createCheckout({ text: 'A spot whose session completes unpaid somehow', band: 'morning' });
    const { body, header } = signedEvent({ id: 'evt_u', type: 'checkout.session.completed', data: { object: { id: 'cs_u', payment_status: 'unpaid', metadata: { radio_ad_id: draft.adId } } } });
    const out = await pay.handleWebhook(body, header);
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await store.getAd(draft.adId)).status, 'draft');
  });

  await run('a wrong amount or currency is NOT honored (mispriced/foreign charge)', async () => {
    const draft = await pay.createCheckout({ text: 'A spot whose webhook reports a wrong amount', band: 'morning' });
    // Correct signature, but amount != $5.
    const bad = signedEvent({ id: 'evt_amt', type: 'checkout.session.completed', data: { object: { id: 'cs_amt', payment_status: 'paid', payment_intent: 'pi_amt', amount_total: 100, currency: 'usd', metadata: { radio_ad_id: draft.adId } } } });
    const o1 = await pay.handleWebhook(bad.body, bad.header);
    assert.strictEqual(o1.status, 200, 'acknowledged so Stripe stops retrying');
    assert.strictEqual(o1.body.ignored, 'amount_or_currency_mismatch');
    assert.strictEqual((await store.getAd(draft.adId)).status, 'draft', 'not paid on wrong amount');
    // Wrong currency.
    const cur = signedEvent({ id: 'evt_cur', type: 'checkout.session.completed', data: { object: { id: 'cs_cur', payment_status: 'paid', payment_intent: 'pi_cur', amount_total: 500, currency: 'eur', metadata: { radio_ad_id: draft.adId } } } });
    const o2 = await pay.handleWebhook(cur.body, cur.header);
    assert.strictEqual(o2.status, 200);
    assert.strictEqual((await store.getAd(draft.adId)).status, 'draft', 'not paid on wrong currency');
  });

  await run('a paid webhook for an unknown ad returns 500 (Stripe retries)', async () => {
    const ev = signedEvent({ id: 'evt_missing', type: 'checkout.session.completed', data: { object: { id: 'cs_missing', payment_status: 'paid', payment_intent: 'pi_missing', amount_total: 500, currency: 'usd', metadata: { radio_ad_id: 'ad_does_not_exist' } } } });
    const out = await pay.handleWebhook(ev.body, ev.header);
    assert.strictEqual(out.status, 500, 'not_found → retry so a real paid signal is not dropped');
  });

  await run('refundAd is confirmed-before-marked and idempotent', async () => {
    const r1 = await pay.refundAd(adId);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.refundId, 're_1');
    assert.strictEqual(api.calls.refund[0].idem, `radio_ad_refund:${adId}`);
    assert.strictEqual(api.calls.refund[0].params.payment_intent, 'pi_1');
    const ad = await store.getAd(adId);
    assert.strictEqual(ad.status, 'refunded');
    assert.strictEqual(ad.stripe_refund_id, 're_1');
    // Idempotent: a 2nd refund does NOT call Stripe again.
    const r2 = await pay.refundAd(adId);
    assert.strictEqual(r2.alreadyRefunded, true);
    assert.strictEqual(api.calls.refund.length, 1, 'no second Stripe refund call');
  });

  await run('refundAd on an unpaid ad refuses (nothing to refund)', async () => {
    const draft = await pay.createCheckout({ text: 'A never-paid spot cannot be refunded at all', band: 'morning' });
    const r = await pay.refundAd(draft.adId);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'no_payment_to_refund');
  });

  await run('unconfigured payments: checkout throws, webhook 503', async () => {
    const bare = new RadioAdPayments({ store }); // no api, no keys
    assert.strictEqual(bare.configured(), false);
    assert.strictEqual(bare.webhookConfigured(), false);
    await assert.rejects(() => bare.createCheckout({ text: 'valid enough text here', band: 'morning' }), /payments unavailable/);
    const out = await bare.handleWebhook('{}', 't=1,v1=deadbeef');
    assert.strictEqual(out.status, 503);
  });

  store.db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (!failed) console.log('\nAll radio-ad-payments tests passed');
  else process.exitCode = 1;
})();
