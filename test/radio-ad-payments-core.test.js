'use strict';

// radio-ad-payments-core.test.js — the pure Stripe logic: webhook signature
// verification (the security-critical part), event classification, form
// encoding, and the checkout params.

const assert = require('assert');
const crypto = require('crypto');
const {
  verifyStripeSignature, classifyWebhookEvent, stripeFormEncode, checkoutSessionParams,
  checkoutIdempotencyKey, refundIdempotencyKey, PRICE_CENTS,
} = require('../server/radio-ad-payments-core');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

// Build a Stripe-style signature header for a payload at time t with a secret.
function sign(payload, secret, t, scheme = 'v1') {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex');
  return `t=${t},${scheme}=${sig}`;
}

console.log('radio-ad-payments-core.test.js');

const SECRET = 'whsec_test_abc';
const NOW = 1_800_000_000; // fixed clock (seconds)

run('valid signature within tolerance passes', () => {
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  const header = sign(body, SECRET, NOW);
  assert.strictEqual(verifyStripeSignature(body, header, SECRET, NOW), true);
});

run('wrong secret fails', () => {
  const body = '{"a":1}';
  const header = sign(body, SECRET, NOW);
  assert.strictEqual(verifyStripeSignature(body, header, 'whsec_other', NOW), false);
});

run('tampered body fails', () => {
  const body = '{"amount":500}';
  const header = sign(body, SECRET, NOW);
  assert.strictEqual(verifyStripeSignature('{"amount":5000}', header, SECRET, NOW), false);
});

run('stale timestamp (replay) fails', () => {
  const body = '{"a":1}';
  const stale = NOW - 3600; // 1h old
  const header = sign(body, SECRET, stale);
  assert.strictEqual(verifyStripeSignature(body, header, SECRET, NOW), false, 'outside 5-min tolerance');
  // But valid within tolerance.
  const fresh = sign(body, SECRET, NOW - 60);
  assert.strictEqual(verifyStripeSignature(body, header, SECRET, NOW), false);
  assert.strictEqual(verifyStripeSignature(body, fresh, SECRET, NOW), true);
});

run('multiple v1 signatures — any valid one passes (secret rotation)', () => {
  const body = '{"a":1}';
  const good = crypto.createHmac('sha256', SECRET).update(`${NOW}.${body}`, 'utf8').digest('hex');
  const header = `t=${NOW},v1=${'0'.repeat(64)},v1=${good}`;
  assert.strictEqual(verifyStripeSignature(body, header, SECRET, NOW), true);
});

run('malformed / missing header fails safely', () => {
  const body = '{"a":1}';
  assert.strictEqual(verifyStripeSignature(body, '', SECRET, NOW), false);
  assert.strictEqual(verifyStripeSignature(body, 'garbage', SECRET, NOW), false);
  assert.strictEqual(verifyStripeSignature(body, `v1=${'a'.repeat(64)}`, SECRET, NOW), false, 'no t=');
  assert.strictEqual(verifyStripeSignature(body, `t=${NOW}`, SECRET, NOW), false, 'no v1=');
  assert.strictEqual(verifyStripeSignature(body, null, SECRET, NOW), false);
  assert.strictEqual(verifyStripeSignature(body, sign(body, SECRET, NOW), '', NOW), false, 'no secret');
});

run('classify: checkout.session.completed paid → paid with metadata + currency', () => {
  const c = classifyWebhookEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 500, currency: 'usd', metadata: { radio_ad_id: 'ad_1' } } } });
  assert.deepStrictEqual(c, { kind: 'paid', adId: 'ad_1', sessionId: 'cs_1', paymentIntent: 'pi_1', amountCents: 500, currency: 'usd' });
});

run('classify: checkout.session.completed UNPAID → ignore', () => {
  const c = classifyWebhookEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_2', payment_status: 'unpaid', metadata: { radio_ad_id: 'ad_2' } } } });
  assert.strictEqual(c.kind, 'ignore');
});

run('classify: payment_intent.succeeded → paid (2nd settlement path)', () => {
  const c = classifyWebhookEvent({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_9', amount_received: 500, currency: 'usd', metadata: { radio_ad_id: 'ad_9' } } } });
  assert.deepStrictEqual(c, { kind: 'paid', adId: 'ad_9', sessionId: null, paymentIntent: 'pi_9', amountCents: 500, currency: 'usd' });
});

run('classify: unrelated event → ignore', () => {
  assert.strictEqual(classifyWebhookEvent({ type: 'charge.refunded', data: { object: {} } }).kind, 'ignore');
  assert.strictEqual(classifyWebhookEvent(null).kind, 'ignore');
});

run('stripeFormEncode: nested + array bracket notation', () => {
  const s = stripeFormEncode({ mode: 'payment', payment_method_types: ['card'], metadata: { radio_ad_id: 'ad_1' }, line_items: [{ quantity: 1, price_data: { unit_amount: 500 } }] });
  assert.ok(s.includes('mode=payment'));
  assert.ok(s.includes('payment_method_types%5B0%5D=card'), 'array bracket');
  assert.ok(s.includes('metadata%5Bradio_ad_id%5D=ad_1'), 'nested object');
  assert.ok(s.includes('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=500'), 'deep nesting');
  assert.ok(!s.includes('undefined'));
});

run('checkoutSessionParams: card-only, $5, ad id on session AND payment_intent', () => {
  const p = checkoutSessionParams({ adId: 'ad_1', band: 'morning', successUrl: 'https://s', cancelUrl: 'https://c' });
  assert.deepStrictEqual(p.payment_method_types, ['card']);
  assert.strictEqual(p.mode, 'payment');
  assert.strictEqual(p.line_items[0].price_data.unit_amount, PRICE_CENTS);
  assert.strictEqual(p.metadata.radio_ad_id, 'ad_1');
  assert.strictEqual(p.payment_intent_data.metadata.radio_ad_id, 'ad_1', 'so payment_intent.succeeded also carries the ad id');
});

run('idempotency keys are stable per ad', () => {
  assert.strictEqual(checkoutIdempotencyKey('ad_1'), 'radio_ad_checkout:ad_1');
  assert.strictEqual(refundIdempotencyKey('ad_1'), 'radio_ad_refund:ad_1');
});

if (!failed) console.log('\nAll radio-ad-payments-core tests passed');
else process.exitCode = 1;
