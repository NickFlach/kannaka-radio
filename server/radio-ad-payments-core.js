'use strict';

/**
 * radio-ad-payments-core.js — the pure half of the self-serve radio ad payment
 * subsystem (radio-ads design v2, slice 3: Stripe). No I/O — webhook signature
 * verification, event classification, idempotency keys, and Stripe form
 * encoding are unit-testable without the network or a database. The https calls
 * + orchestration live in radio-ad-payments.js.
 *
 * DECISIONS (locked in the design review): $5 flat for a 7-day run, CARD ONLY,
 * charge-then-refund (NOT auth-hold — a Stripe auth expires in 7 days, which
 * loses to operator-approval latency), refund on rejection. The same Stripe
 * account as KAX commerce; keys live on O1 (STRIPE_SECRET_KEY /
 * STRIPE_WEBHOOK_SECRET), so this whole module is inert (503) until they are set.
 */

const crypto = require('crypto');

// One $5 charge buys the whole 7-day run (once/day). Amounts are in the
// smallest currency unit (cents).
const PRICE_CENTS = 500;
const CURRENCY = 'usd';
const RUN_DAYS = 7;

// Stripe webhook timestamps older/newer than this (seconds) are rejected — the
// replay window. 5 minutes is Stripe's own recommended tolerance.
const SIGNATURE_TOLERANCE_SEC = 300;

/** Idempotency key for creating a draft's Checkout Session — retrying the same
 *  draft's checkout never creates a duplicate session/charge. */
function checkoutIdempotencyKey(adId) { return `radio_ad_checkout:${adId}`; }

/** Idempotency key for refunding an ad — a retried refund never double-refunds. */
function refundIdempotencyKey(adId) { return `radio_ad_refund:${adId}`; }

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header) against the
 * RAW request body. Pure — the clock is injected as nowSec so it is testable.
 *
 * The scheme (Stripe docs): the header is `t=<ts>,v1=<hex>,...` (v1 may repeat
 * during a secret rotation). The signed payload is `${t}.${rawBody}`, HMAC-
 * SHA256 with the endpoint secret. We reject if the timestamp is outside the
 * tolerance (replay defense) and require a timing-safe match on ANY v1.
 */
function verifyStripeSignature(rawBody, header, secret, nowSec, toleranceSec = SIGNATURE_TOLERANCE_SEC) {
  if (typeof header !== 'string' || !header || typeof secret !== 'string' || !secret) return false;
  if (typeof rawBody !== 'string') rawBody = String(rawBody == null ? '' : rawBody);
  let t = null;
  const v1s = [];
  for (const part of header.split(',')) {
    const kv = part.trim();
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    if (k === 't') t = v;
    else if (k === 'v1') v1s.push(v);
  }
  if (!t || v1s.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  if (toleranceSec && Math.abs(Number(nowSec) - ts) > toleranceSec) return false; // replay / stale
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest();
  for (const v1 of v1s) {
    let got;
    try { got = Buffer.from(v1, 'hex'); } catch { continue; }
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return true;
  }
  return false;
}

/**
 * Classify a parsed Stripe event into what the store needs. Two event types
 * converge on 'paid' (the 2nd settlement path — if one webhook is missed the
 * other still lands; markPaid is idempotent):
 *   - checkout.session.completed (only when payment_status==='paid')
 *   - payment_intent.succeeded
 * Everything else is ignored.
 */
function classifyWebhookEvent(event) {
  if (!event || typeof event !== 'object') return { kind: 'ignore' };
  const obj = (event.data && event.data.object) || {};
  const md = obj.metadata || {};
  if (event.type === 'checkout.session.completed') {
    if (obj.payment_status !== 'paid') return { kind: 'ignore' }; // e.g. async payment still pending
    return { kind: 'paid', adId: md.radio_ad_id || null, sessionId: obj.id || null, paymentIntent: obj.payment_intent || null, amountCents: obj.amount_total ?? null };
  }
  if (event.type === 'payment_intent.succeeded') {
    return { kind: 'paid', adId: md.radio_ad_id || null, sessionId: null, paymentIntent: obj.id || null, amountCents: obj.amount_received ?? null };
  }
  return { kind: 'ignore' };
}

/**
 * Encode a (possibly nested) object as Stripe's application/x-www-form-urlencoded
 * bracket notation: { a: { b: 1 }, c: [d] } → a[b]=1&c[0]=d. Pure.
 */
function stripeFormEncode(obj, prefix) {
  const parts = [];
  const enc = encodeURIComponent;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === undefined || val === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (item !== null && typeof item === 'object') parts.push(stripeFormEncode(item, `${k}[${i}]`));
        else parts.push(`${enc(`${k}[${i}]`)}=${enc(String(item))}`);
      });
    } else if (typeof val === 'object') {
      parts.push(stripeFormEncode(val, k));
    } else {
      parts.push(`${enc(k)}=${enc(String(val))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

/** The Checkout Session params for a radio ad — one place so the code and tests
 *  agree on exactly what is sent to Stripe (card-only, $5, metadata carries the
 *  ad id on BOTH the session and the payment_intent for the 2nd settlement path). */
function checkoutSessionParams({ adId, band, successUrl, cancelUrl, priceCents = PRICE_CENTS, currency = CURRENCY, runDays = RUN_DAYS }) {
  return {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: priceCents,
        product_data: { name: `Kannaka Radio ad — ${runDays}-day run (${band})` },
      },
    }],
    metadata: { radio_ad_id: adId, band },
    payment_intent_data: { metadata: { radio_ad_id: adId, band } },
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
}

module.exports = {
  PRICE_CENTS, CURRENCY, RUN_DAYS, SIGNATURE_TOLERANCE_SEC,
  checkoutIdempotencyKey, refundIdempotencyKey,
  verifyStripeSignature, classifyWebhookEvent, stripeFormEncode, checkoutSessionParams,
};
