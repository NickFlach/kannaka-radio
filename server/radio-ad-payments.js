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
    // Sponsor slots deliverable per band per day. K=1 (safe/low, review M6): one
    // active ad per band at a time — 4 bands ≈ 4 concurrent slots. Raise only
    // when more daily commercial slots per band are provably deliverable.
    this.bandCapacity = opts.bandCapacity ?? 1;
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
    // Capacity gate (review M6): atomically reserve a band slot or refuse —
    // never sell a spot the band can't deliver. Released on kill/reject/dispute/
    // completion, or swept if never paid.
    const cap = await this.store.reserveBandHold(draft.id, draft.band, this.bandCapacity);
    if (!cap.reserved) { const e = new Error(`the ${draft.band} slot is full right now — please pick another time slot`); e.code = 'band_full'; throw e; }
    try {
      // 60-min session expiry: bounds how long an abandoned checkout holds the
      // band slot and guarantees no payment lands after the capacity sweep frees
      // it (the sweep grace is 90 min, review M1).
      const expiresAt = Math.floor(this._now() / 1000) + 60 * 60;
      const params = checkoutSessionParams({ adId: draft.id, band: draft.band, successUrl: this.successUrl, cancelUrl: this.cancelUrl, runDays, expiresAt });
      const session = await api.createCheckoutSession(params, checkoutIdempotencyKey(draft.id));
      if (session && session.id) await this.store.attachCheckout(draft.id, session.id);
      return { adId: draft.id, checkoutUrl: session && session.url, sessionId: session && session.id };
    } catch (e) {
      await this.store.releaseBandHold(draft.id).catch(() => {}); // Stripe failed → free the slot
      throw e;
    }
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
      // Amount + currency MUST match our server-set price before we honor a
      // paid event — the sole guard against a mispriced/foreign-currency charge.
      // A mismatch is definitive (retrying won't change it): acknowledge (200)
      // so Stripe stops redelivering, but do NOT mark paid.
      if (c.amountCents !== PRICE_CENTS || c.currency !== CURRENCY) {
        return { status: 200, body: { received: true, ignored: 'amount_or_currency_mismatch' } };
      }
      let r;
      try {
        r = await this.store.markPaid(c.adId, { sessionId: c.sessionId, paymentIntent: c.paymentIntent, amountCents: c.amountCents });
      } catch (e) {
        // Transient store error → 500 so Stripe RETRIES; a dropped paid signal
        // would be an unrecorded charge.
        return { status: 500, body: { error: 'could not record payment' } };
      }
      // A paid event for an ad we can't find yet → 500 so Stripe redelivers
      // (this slice has no reconciliation sweep to recover a dropped signal).
      // A terminal-state no-op (already refunded/killed/completed) → 200.
      if (!r.ok && r.reason === 'not_found') return { status: 500, body: { error: 'ad not found — will retry' } };
    }
    if (c.kind === 'disputed' && c.paymentIntent) {
      // A chargeback: stop airing, mark disputed. Issue NO refund (the dispute
      // moves the funds; review B2). Idempotent via disputed_at.
      try {
        await this.store.markDisputed(c.paymentIntent, c.disputeId);
      } catch (e) {
        return { status: 500, body: { error: 'could not record dispute' } };
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
    // NEVER refund a disputed charge — the dispute process moves the funds, so
    // refunding on top is a double-pay (review B2). Belt-and-suspenders with the
    // status guards below.
    if (ad.disputed_at) return { ok: false, error: 'disputed' };
    if (!ad.stripe_payment_intent) return { ok: false, error: 'no_payment_to_refund' };
    // Guard the refundable STATE before touching Stripe: a stray/replayed enact
    // on a live ad must not issue a real refund while it keeps airing.
    if (!['paid', 'rejected', 'killed'].includes(ad.status)) {
      return { ok: false, error: `not_refundable_from:${ad.status}` };
    }
    const api = this._stripe();
    if (!api) return { ok: false, error: 'payments_unconfigured' };
    if (ad.status === 'killed') {
      // PARTIAL (pro-rata) refund of the amount FROZEN at kill time (review
      // B1/B3): same idempotency key + same amount on a re-drive = a true Stripe
      // idempotent replay. Status stays 'killed' (it aired part of the run).
      const amount = ad.refund_amount_cents == null ? 0 : ad.refund_amount_cents;
      if (amount > 0) {
        const refund = await api.createRefund({ payment_intent: ad.stripe_payment_intent, amount }, refundIdempotencyKey(adId));
        await this.store.markKillRefunded(adId, refund && refund.id);
        return { ok: true, refundId: refund && refund.id, amountCents: amount, partial: true };
      }
      // Fully aired → nothing to refund (Stripe rejects a 0-cent refund); record
      // it so the enact doesn't 409-loop.
      await this.store.markKillRefunded(adId, null);
      return { ok: true, refundId: null, amountCents: 0, partial: true };
    }
    // paid / rejected → FULL refund (the ad never aired).
    const refund = await api.createRefund({ payment_intent: ad.stripe_payment_intent }, refundIdempotencyKey(adId));
    await this.store.markRefunded(adId, refund && refund.id);
    return { ok: true, refundId: refund && refund.id };
  }
}

module.exports = { RadioAdPayments, makeStripeApi, PRICE_CENTS, CURRENCY };
