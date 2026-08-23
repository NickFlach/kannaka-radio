'use strict';

/**
 * radio-ad-payments.js — Stripe checkout + webhook + refund for self-serve
 * radio ads (radio-ads design v2, slice 3). Talks to the Stripe REST API over
 * https (no SDK dependency → nothing new to install on O1). The pure logic
 * (signature verify, event classification, form encoding) is in
 * radio-ad-payments-core.js; this file is the I/O + orchestration.
 *
 * Inert until keys are set: with no STRIPE_SECRET_KEY the checkout/refund paths
 * report unconfigured (route → 503) and the station is unaffected; with no
 * STRIPE_WEBHOOK_SECRET the webhook returns 503. Keys live on O1 (slice 6).
 */

const https = require('https');
const {
  PRICE_CENTS, CURRENCY, RUN_DAYS, SIGNATURE_TOLERANCE_SEC,
  checkoutIdempotencyKey, refundIdempotencyKey,
  verifyStripeSignature, classifyWebhookEvent, stripeFormEncode, checkoutSessionParams,
} = require('./radio-ad-payments-core');

/** A minimal Stripe REST client over https. Injectable (see RadioAdPayments
 *  opts.api) so tests never touch the network. */
function makeStripeApi(secretKey) {
  function post(apiPath, params, idempotencyKey) {
    const body = stripeFormEncode(params);
    return new Promise((resolve, reject) => {
      const req = https.request({
        method: 'POST',
        hostname: 'api.stripe.com',
        path: apiPath,
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON error body */ }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json || {});
          const msg = (json && json.error && json.error.message) || `stripe ${res.statusCode}`;
          const e = new Error(msg);
          e.statusCode = res.statusCode;
          e.stripeCode = json && json.error && json.error.code;
          reject(e);
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('stripe request timed out')));
      req.write(body);
      req.end();
    });
  }
  return {
    createCheckoutSession(params, idempotencyKey) { return post('/v1/checkout/sessions', params, idempotencyKey); },
    createRefund(params, idempotencyKey) { return post('/v1/refunds', params, idempotencyKey); },
  };
}

class RadioAdPayments {
  constructor(opts = {}) {
    this.store = opts.store;
    this._secretKey = opts.secretKey || process.env.STRIPE_SECRET_KEY || null;
    this._webhookSecret = opts.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || null;
    this.successUrl = opts.successUrl || 'https://radio.ninja-portal.com/?ad=paid';
    this.cancelUrl = opts.cancelUrl || 'https://radio.ninja-portal.com/?ad=cancelled';
    this._api = opts.api || null; // injectable Stripe client (tests / DI)
    this._now = opts.now || (() => Date.now());
  }

  /** True once a secret key is present — the checkout/refund paths are live. */
  configured() { return !!(this._api || this._secretKey); }
  /** True once the webhook secret is present — the webhook can verify. */
  webhookConfigured() { return !!this._webhookSecret; }

  _stripe() {
    if (this._api) return this._api;
    if (!this._secretKey) return null;
    this._api = makeStripeApi(this._secretKey);
    return this._api;
  }

  /**
   * Create a draft ad + a Stripe Checkout Session for it. The draft validates
   * the text/band (throws InvalidAdText). Returns { adId, checkoutUrl }.
   */
  async createCheckout({ text, band, requestedBy = null, runDays = RUN_DAYS } = {}) {
    const api = this._stripe();
    if (!api) { const e = new Error('payments unavailable'); e.code = 'payments_unconfigured'; throw e; }
    const draft = await this.store.createDraft({ text, band, requestedBy, runDays }); // validates
    const params = checkoutSessionParams({ adId: draft.id, band: draft.band, successUrl: this.successUrl, cancelUrl: this.cancelUrl, runDays });
    const session = await api.createCheckoutSession(params, checkoutIdempotencyKey(draft.id));
    if (session && session.id) await this.store.attachCheckout(draft.id, session.id);
    return { adId: draft.id, checkoutUrl: session && session.url, sessionId: session && session.id };
  }

  /**
   * Handle a raw Stripe webhook. Verifies the signature over the RAW body (never
   * the parsed JSON), then marks the ad paid — idempotently, so a duplicate
   * delivery or the 2nd settlement path (both event types) can't double-apply.
   * Returns { status, body } for the route to send.
   */
  async handleWebhook(rawBody, sigHeader) {
    if (!this._webhookSecret) return { status: 503, body: { error: 'webhook unconfigured' } };
    const nowSec = Math.floor(this._now() / 1000);
    if (!verifyStripeSignature(rawBody, sigHeader, this._webhookSecret, nowSec, SIGNATURE_TOLERANCE_SEC)) {
      return { status: 400, body: { error: 'invalid signature' } };
    }
    let event;
    try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'bad json' } }; }
    const c = classifyWebhookEvent(event);
    if (c.kind === 'paid' && c.adId) {
      try {
        await this.store.markPaid(c.adId, { sessionId: c.sessionId, paymentIntent: c.paymentIntent, amountCents: c.amountCents });
      } catch (e) {
        // Return 500 so Stripe RETRIES — a transient store error must not drop a
        // paid signal (that would be an unrecorded charge).
        return { status: 500, body: { error: 'could not record payment' } };
      }
    }
    return { status: 200, body: { received: true } };
  }

  /**
   * Refund an ad's charge — confirmed-BEFORE-marked: create the Stripe refund
   * first, mark the row refunded only after Stripe confirms, so a failed refund
   * never shows the customer as refunded when they were not. Idempotent via the
   * refund idempotency key + the row's refunded_at guard.
   */
  async refundAd(adId) {
    const ad = await this.store.getAd(adId);
    if (!ad) return { ok: false, error: 'not_found' };
    if (ad.refunded_at) return { ok: true, alreadyRefunded: true, refundId: ad.stripe_refund_id };
    if (!ad.stripe_payment_intent) return { ok: false, error: 'no_payment_to_refund' };
    const api = this._stripe();
    if (!api) return { ok: false, error: 'payments_unconfigured' };
    const refund = await api.createRefund({ payment_intent: ad.stripe_payment_intent }, refundIdempotencyKey(adId));
    await this.store.markRefunded(adId, refund && refund.id);
    return { ok: true, refundId: refund && refund.id };
  }
}

module.exports = { RadioAdPayments, makeStripeApi, PRICE_CENTS, CURRENCY };
