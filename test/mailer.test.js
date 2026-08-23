'use strict';

// mailer.test.js — advertiser + operator mail. The interesting assertions are
// the NEGATIVE ones: mail must never fire twice on a replayed webhook or a
// re-driven enact, must never carry untrusted ad copy into a Subject, and must
// never be able to fail a payment or a decision.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Mailer, bareAddr, encodeHeader, bandLabel } = require('../server/mailer');
const { RadioAdStore } = require('../server/radio-ads');
const { RadioAdPayments } = require('../server/radio-ad-payments');
const { RadioAdBridge } = require('../server/radio-ad-bridge');
const { signBridge } = require('../server/radio-ad-bridge-core');

const WHSEC = 'whsec_mail_test';
const ENACT = 'enact_secret_mail';
const NOWMS = 1_800_000_000_000;
const NOWSEC = Math.floor(NOWMS / 1000);

let failed = 0;
async function run(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; } }

function capturingMailer(extra = {}) {
  const outbox = [];
  const m = new Mailer({
    env: { RADIO_OPERATOR_EMAIL: 'nick@example.com', MAIL_FROM: 'Kannaka Radio <radio@example.com>', ...extra.env },
    send: async (msg) => { if (extra.throws) throw new Error('relay down'); outbox.push(msg); },
    logger: () => {},
  });
  m.outbox = outbox;
  return m;
}

function signedStripe(event, secret = WHSEC, t = NOWSEC) {
  const body = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return { body, header: `t=${t},v1=${sig}` };
}

function paidEvent(adId, id, email) {
  return signedStripe({
    id, type: 'checkout.session.completed',
    data: { object: { id: 'cs_' + adId, payment_status: 'paid', payment_intent: 'pi_' + adId, amount_total: 500, currency: 'usd', ...(email ? { customer_details: { email } } : {}), metadata: { radio_ad_id: adId } } },
  });
}

const fakeVoiceDJ = { generateTTS(t, cb) { const p = path.join(os.tmpdir(), 'mail-' + crypto.createHash('md5').update(t).digest('hex').slice(0, 8) + '.mp3'); fs.writeFileSync(p, 'x'); setImmediate(() => cb(null, p, t)); } };
function fakeStripe() { const calls = { refund: [] }; return { calls, async createCheckoutSession(p, k) { return { id: 'cs_' + k, url: 'u' }; }, async createRefund(p, k) { calls.refund.push({ p, k }); return { id: 're_1' }; }, async updatePaymentIntent() { return {}; } }; }

(async () => {
  console.log('mailer.test.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-mail-'));

  // ── Pure helpers ──
  await run('bareAddr strips the display name for the SMTP envelope', () => {
    assert.strictEqual(bareAddr('Kannaka Radio <radio@example.com>'), 'radio@example.com');
    assert.strictEqual(bareAddr('  plain@example.com  '), 'plain@example.com');
  });

  await run('encodeHeader passes ASCII through and RFC-2047s the rest', () => {
    assert.strictEqual(encodeHeader('Your spot is booked'), 'Your spot is booked');
    const enc = encodeHeader('Your spot — booked');
    assert.ok(enc.startsWith('=?UTF-8?B?'), 'non-ASCII must be encoded, not sent raw');
    assert.strictEqual(Buffer.from(enc.slice(10, -2), 'base64').toString('utf8'), 'Your spot — booked');
  });

  await run('an unconfigured mailer sends nothing and reports it', async () => {
    const m = new Mailer({ env: {}, logger: () => {} });
    assert.strictEqual(m.configured(), false);
    assert.strictEqual(await m.send({ to: 'a@b.c', subject: 's', text: 't' }), false);
  });

  await run('send NEVER throws, even when the relay is down', async () => {
    const m = capturingMailer({ throws: true });
    assert.strictEqual(await m.send({ to: 'a@b.c', subject: 's', text: 't' }), false, 'reports failure');
    assert.strictEqual(await m.adPurchased('a@b.c', { adId: 'ad_1', band: 'morning', runDays: 7 }), false);
  });

  await run('operator mail keeps untrusted ad copy OUT of the subject', async () => {
    const m = capturingMailer();
    const nasty = 'BUY NOW\nSubject: Injected\nbcc: someone@evil.test';
    await m.operatorReviewNeeded({ adId: 'ad_x', band: 'morning', amountCents: 500, runDays: 7, text: nasty });
    const msg = m.outbox[0];
    assert.strictEqual(msg.subject, 'Kannaka Radio: a paid spot needs your review', 'subject is system-authored');
    assert.ok(!msg.subject.includes('BUY NOW'), 'no customer text in the subject');
    assert.ok(msg.text.includes('BUY NOW'), 'the copy is still shown, in the body');
  });

  await run('operator mail is skipped when no operator address is configured', async () => {
    const m = new Mailer({ env: { MAIL_FROM: 'x <x@y.z>' }, send: async () => {}, logger: () => {} });
    assert.strictEqual(await m.operatorReviewNeeded({ adId: 'ad_y', band: 'morning', amountCents: 500, runDays: 7, text: 'hi' }), false);
  });

  await run('band labels are human, and an unknown band degrades to itself', () => {
    assert.strictEqual(bandLabel('late_night'), 'Late night · 12a–6a');
    assert.strictEqual(bandLabel('brand_new_band'), 'brand_new_band');
  });

  // ── Wired into the payment path ──
  const store = new RadioAdStore({ dbPath: path.join(tmp, 'db.sqlite'), assetDir: path.join(tmp, 'ads') });
  await store.init();

  await run('a paid webhook mails the buyer AND the operator, exactly once each', async () => {
    const m = capturingMailer();
    const pay = new RadioAdPayments({ store, api: fakeStripe(), webhookSecret: WHSEC, now: () => NOWMS, mailer: m });
    const d = await pay.createCheckout({ text: 'A spot that should generate two emails', band: 'morning' });
    const ev = paidEvent(d.adId, 'evt_m1', 'buyer@example.com');
    assert.strictEqual((await pay.handleWebhook(ev.body, ev.header)).status, 200);
    assert.strictEqual(m.outbox.length, 2, 'one buyer mail + one operator mail');
    const buyer = m.outbox.find((x) => x.to === 'buyer@example.com');
    const op = m.outbox.find((x) => x.to === 'nick@example.com');
    assert.ok(buyer && /booked/i.test(buyer.subject));
    assert.ok(buyer.text.includes('Morning · 6a–12p'), 'buyer is told which slot');
    assert.ok(op && /needs your review/i.test(op.subject));
    assert.strictEqual((await store.getAd(d.adId)).customer_email, 'buyer@example.com', 'address persisted for later');

    // A REPLAYED webhook must not mail anybody a second time.
    const again = paidEvent(d.adId, 'evt_m1b', 'buyer@example.com');
    assert.strictEqual((await pay.handleWebhook(again.body, again.header)).status, 200);
    assert.strictEqual(m.outbox.length, 2, 'a replayed Stripe event sends no further mail');
  });

  await run('the stored buyer address is write-once (a replay cannot re-point it)', async () => {
    const m = capturingMailer();
    const pay = new RadioAdPayments({ store, api: fakeStripe(), webhookSecret: WHSEC, now: () => NOWMS, mailer: m });
    const d = await pay.createCheckout({ text: 'A spot whose address must not be moved', band: 'evening' });
    const first = paidEvent(d.adId, 'evt_w1', 'real@example.com');
    await pay.handleWebhook(first.body, first.header);
    const forged = paidEvent(d.adId, 'evt_w2', 'attacker@evil.test');
    await pay.handleWebhook(forged.body, forged.header);
    assert.strictEqual((await store.getAd(d.adId)).customer_email, 'real@example.com');
    assert.ok(!m.outbox.some((x) => x.to === 'attacker@evil.test'), 'never mails the second address');
  });

  await run('a dead relay does not fail the webhook — the payment still records', async () => {
    const m = capturingMailer({ throws: true });
    const pay = new RadioAdPayments({ store, api: fakeStripe(), webhookSecret: WHSEC, now: () => NOWMS, mailer: m });
    const d = await pay.createCheckout({ text: 'A spot bought while the mail relay is down', band: 'late_night' });
    const ev = paidEvent(d.adId, 'evt_m2', 'buyer2@example.com');
    const out = await pay.handleWebhook(ev.body, ev.header);
    assert.strictEqual(out.status, 200, 'mail failure must not make Stripe retry');
    assert.strictEqual((await store.getAd(d.adId)).status, 'paid');
  });

  await run('a purchase with no buyer email still nudges the operator', async () => {
    const m = capturingMailer();
    const pay = new RadioAdPayments({ store, api: fakeStripe(), webhookSecret: WHSEC, now: () => NOWMS, mailer: m });
    const d = await pay.createCheckout({ text: 'A spot bought without an email address at all', band: 'afternoon' });
    const ev = paidEvent(d.adId, 'evt_m3', null);
    await pay.handleWebhook(ev.body, ev.header);
    assert.strictEqual(m.outbox.length, 1);
    assert.strictEqual(m.outbox[0].to, 'nick@example.com', 'the operator is told regardless');
  });

  // ── Wired into the decision path ──
  async function enactFor(bridge, adId, decision) {
    const body = JSON.stringify({ adId, decision });
    return bridge.handleEnact(body, signBridge(body, ENACT, NOWSEC));
  }

  // Each decision test gets its own store: band capacity is K=1, so the holds
  // taken by the payment tests above would (correctly) refuse a second
  // checkout in the same band.
  const stores = [];
  async function freshStore(tag) {
    const s = new RadioAdStore({ dbPath: path.join(tmp, `${tag}.sqlite`), assetDir: path.join(tmp, `${tag}-ads`) });
    await s.init();
    stores.push(s);
    return s;
  }

  await run('approval mails the buyer once; a re-driven enact does not mail again', async () => {
    const m = capturingMailer();
    const api = fakeStripe();
    const store = await freshStore('approve');
    const pay = new RadioAdPayments({ store, api, webhookSecret: WHSEC, now: () => NOWMS, mailer: m });
    const bridge = new RadioAdBridge({ store, payments: pay, enactSecret: ENACT, now: () => NOWMS, mailer: m });
    const d = await pay.createCheckout({ text: 'A spot that gets approved and should say so', band: 'morning' });
    const ev = paidEvent(d.adId, 'evt_a1', 'approved@example.com');
    await pay.handleWebhook(ev.body, ev.header);
    await store.renderAd(d.adId, fakeVoiceDJ);
    m.outbox.length = 0;

    assert.strictEqual((await enactFor(bridge, d.adId, 'approve')).status, 200);
    assert.strictEqual(m.outbox.length, 1);
    assert.ok(/on the air/i.test(m.outbox[0].subject));
    assert.strictEqual(m.outbox[0].to, 'approved@example.com');

    assert.strictEqual((await enactFor(bridge, d.adId, 'approve')).status, 200, 're-drive is still OK');
    assert.strictEqual(m.outbox.length, 1, 'but sends no second mail');
  });

  await run('rejection mails only AFTER the refund is confirmed, and only once', async () => {
    const m = capturingMailer();
    const api = fakeStripe();
    const store = await freshStore('reject');
    const pay = new RadioAdPayments({ store, api, webhookSecret: WHSEC, now: () => NOWMS, mailer: m });
    const bridge = new RadioAdBridge({ store, payments: pay, enactSecret: ENACT, now: () => NOWMS, mailer: m });
    const d = await pay.createCheckout({ text: 'A spot that gets turned down and refunded', band: 'evening' });
    const ev = paidEvent(d.adId, 'evt_r1', 'rejected@example.com');
    await pay.handleWebhook(ev.body, ev.header);
    m.outbox.length = 0;

    const out = await enactFor(bridge, d.adId, 'reject');
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.refunded, true);
    assert.strictEqual(m.outbox.length, 1);
    assert.ok(/refunded in full/i.test(m.outbox[0].subject));
    // The claim in the mail must be true at the time it is sent.
    assert.ok((await store.getAd(d.adId)).refunded_at, 'refund recorded before the mail claims it');
    assert.strictEqual(api.calls.refund.length, 1);

    assert.strictEqual((await enactFor(bridge, d.adId, 'reject')).status, 200);
    assert.strictEqual(m.outbox.length, 1, 'a re-driven rejection does not re-announce');
  });

  await run('with no mailer wired, decisions and payments behave exactly as before', async () => {
    const store = await freshStore('nomail');
    const pay = new RadioAdPayments({ store, api: fakeStripe(), webhookSecret: WHSEC, now: () => NOWMS });
    const bridge = new RadioAdBridge({ store, payments: pay, enactSecret: ENACT, now: () => NOWMS });
    const d = await pay.createCheckout({ text: 'A spot bought on a station with no mail at all', band: 'afternoon' });
    const ev = paidEvent(d.adId, 'evt_n1', 'nobody@example.com');
    assert.strictEqual((await pay.handleWebhook(ev.body, ev.header)).status, 200);
    await store.renderAd(d.adId, fakeVoiceDJ);
    assert.strictEqual((await enactFor(bridge, d.adId, 'approve')).status, 200);
    assert.strictEqual((await store.getAd(d.adId)).status, 'scheduled');
  });

  store.db.close();
  for (const s of stores) { try { s.db.close(); } catch { /* already closed */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (!failed) console.log('\nAll mailer tests passed');
  else process.exitCode = 1;
})();
