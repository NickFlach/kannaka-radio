'use strict';

/**
 * radio-ad-bridge.js — the radio side of the radio↔KAX approval bridge
 * (radio-ads slice 4). Two responsibilities, both idempotent and self-healing:
 *
 *  - OUTBOUND (tick): render paid ads early (so the enact is instant, review M3),
 *    enqueue a raise for every paid ad (idempotent), and deliver pending raises
 *    to KAX over an HMAC-signed POST (retry forever with capped backoff — money).
 *  - INBOUND (handleEnact): KAX POSTs the operator's decision here, HMAC-signed;
 *    approve → render+schedule, reject → refund. State-tolerant + idempotent.
 *
 * Inert until env is set: no raise URL/secret → the tick still renders + enqueues
 * (nothing lost) but does not deliver; no enact secret → the enact endpoint 503s.
 * Two direction-bound secrets (review M1).
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { signBridge, verifyBridge, parseEnact, raiseBackoffMs } = require('./radio-ad-bridge-core');

const ENACT_TIMEOUT_MS = 10_000; // << the KAX 5-min execution lease (review M4)

function defaultPost(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(ENACT_TIMEOUT_MS, () => req.destroy(new Error('bridge POST timed out')));
    req.write(body);
    req.end();
  });
}

class RadioAdBridge {
  constructor(opts = {}) {
    this.store = opts.store;
    this.payments = opts.payments || null;
    this.voiceDJ = opts.voiceDJ || null;
    this.raiseUrl = opts.raiseUrl || process.env.KAX_RAISE_URL || null;
    this.raiseSecret = opts.raiseSecret || process.env.RADIO_KAX_RAISE_SECRET || null;
    this.enactSecret = opts.enactSecret || process.env.KAX_RADIO_ENACT_SECRET || null;
    this._post = opts.post || defaultPost;
    this._now = opts.now || (() => Date.now());
  }

  deliveryConfigured() { return !!(this.raiseUrl && this.raiseSecret); }
  enactConfigured() { return !!this.enactSecret; }

  /** Render paid/raised-but-unrendered ads (early, so enact is instant) and
   *  enqueue a raise for every paid ad. Best-effort per ad — one failure never
   *  blocks the others. */
  async reconcile() {
    if (this.voiceDJ) {
      let need = [];
      try { need = await this.store.adsNeedingRender(); } catch { need = []; }
      for (const ad of need) {
        try { await this.store.renderAd(ad.id, this.voiceDJ); } catch (_) { /* retry next tick */ }
      }
    }
    // Free band slots held by checkouts that were never paid (abandoned).
    try { await this.store.releaseStaleUnpaidHolds(); } catch (_) { /* best-effort */ }
    let paid = [];
    try { paid = await this.store.paidWithoutRaise(); } catch { paid = []; }
    for (const ad of paid) {
      try {
        await this.store.enqueueRaise(ad.id, {
          adId: ad.id,
          band: ad.band,
          amountCents: ad.amount_cents,
          runDays: ad.run_days,
          textPreview: String(ad.text || '').slice(0, 200),
        });
      } catch (_) { /* UNIQUE(ad_id,kind) race — already enqueued */ }
    }
  }

  /** Deliver undelivered raises to KAX. On 2xx: mark delivered + move paid→pending
   *  (best-effort). On failure: bump attempt with capped backoff (retry forever). */
  async deliverPendingRaises() {
    if (!this.deliveryConfigured()) return { delivered: 0, failed: 0, skipped: true };
    let rows = [];
    try { rows = await this.store.pendingRaises(new Date(this._now())); } catch { return { delivered: 0, failed: 0 }; }
    let delivered = 0; let failed = 0;
    for (const row of rows) {
      const body = row.payload || JSON.stringify({ adId: row.ad_id });
      const header = signBridge(body, this.raiseSecret, Math.floor(this._now() / 1000));
      try {
        const res = await this._post(this.raiseUrl, body, { 'X-Radio-Signature': header });
        if (res && res.status >= 200 && res.status < 300) {
          await this.store.markRaiseDelivered(row.id);
          try { await this.store.markRaised(row.ad_id); } catch (_) { /* best-effort marker */ }
          delivered += 1;
        } else {
          await this.store.bumpRaiseAttempt(row.id, `HTTP ${res && res.status}`, new Date(this._now() + raiseBackoffMs(row.attempts)));
          failed += 1;
        }
      } catch (e) {
        await this.store.bumpRaiseAttempt(row.id, e && e.message, new Date(this._now() + raiseBackoffMs(row.attempts)));
        failed += 1;
      }
    }
    return { delivered, failed };
  }

  /** One outbound cycle: reconcile (render + enqueue), then deliver. Guarded
   *  against re-entrancy — a reconcile whose TTS render outlasts the poll
   *  interval must not let a second tick double-render (wasted TTS spend) or
   *  double-POST a raise (review F3). */
  async tick() {
    if (this._ticking) return { delivered: 0, failed: 0, skipped: 'busy' };
    this._ticking = true;
    try {
      try { await this.reconcile(); } catch (_) { /* never let the tick throw */ }
      try { return await this.deliverPendingRaises(); } catch (_) { return { delivered: 0, failed: 0 }; }
    } finally {
      this._ticking = false;
    }
  }

  /** Start the outbound poller (unref'd interval). */
  startPoller({ intervalMs = 30_000 } = {}) {
    const t = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
    if (t.unref) t.unref();
    // one immediate cycle so a just-paid ad is raised promptly
    this.tick().catch(() => {});
    return t;
  }

  /**
   * INBOUND: handle a KAX enact POST (raw body + signature header). Verifies the
   * enact-direction secret over the RAW body, then drives the ad to scheduled
   * (approve) or refunded (reject). Idempotent + state-tolerant. Returns
   * { status, body }: 401 bad sig, 400 bad body, 409 not-actionable (KAX keeps
   * it needs-action), 200 done.
   */
  async handleEnact(rawBody, sigHeader) {
    if (!this.enactSecret) return { status: 503, body: { error: 'enact unconfigured' } };
    if (!verifyBridge(rawBody, sigHeader, this.enactSecret, Math.floor(this._now() / 1000))) {
      return { status: 401, body: { error: 'invalid signature' } };
    }
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'bad json' } }; }
    const e = parseEnact(parsed);
    if (!e.ok) return { status: 400, body: { error: e.error } };
    if (e.decision === 'approve') {
      const r = await this.store.approveAndSchedule(e.adId, new Date(this._now()));
      if (r.ok) {
        // Grant the free-month GSA entitlement on approval (idempotent, review M7).
        try { await this.store.grantGsaEntitlement(e.adId); } catch (_) { /* best-effort; not money */ }
        return { status: 200, body: { ok: true, decision: 'approve', already: !!r.already } };
      }
      // not_rendered → render hasn't landed yet; 409 so KAX retries.
      return { status: 409, body: { ok: false, reason: r.reason } };
    }
    if (e.decision === 'kill') {
      // Mid-run kill: stop airing (freezes the pro-rata refund amount + evicts),
      // then refund the UNAIRED portion. Idempotent + safe under re-drive.
      await this.store.killAd(e.adId, new Date(this._now()));
      if (!this.payments) return { status: 200, body: { ok: true, decision: 'kill', refunded: false, note: 'payments unconfigured' } };
      const rk = await this.payments.refundAd(e.adId);
      if (rk.ok) return { status: 200, body: { ok: true, decision: 'kill', refunded: rk.amountCents !== 0, amountCents: rk.amountCents, alreadyRefunded: !!rk.alreadyRefunded } };
      // Nothing to refund / disputed / inert → done (don't 409-loop). A real
      // refund error (Stripe down) → 409 so KAX retries; killAd is a no-op on
      // re-drive and the amount is frozen, so the retry is safe.
      if (['no_payment_to_refund', 'disputed', 'payments_unconfigured'].includes(rk.error)) {
        return { status: 200, body: { ok: true, decision: 'kill', refunded: false, note: rk.error } };
      }
      return { status: 409, body: { ok: false, reason: rk.error } };
    }
    // reject → move to rejected, then refund (confirmed-before-marked). Both
    // idempotent; refund needs the payments module (Stripe configured).
    const rj = await this.store.rejectAd(e.adId);
    if (!rj.ok) return { status: 409, body: { ok: false, reason: rj.reason } };
    if (!this.payments) return { status: 200, body: { ok: true, decision: 'reject', refunded: false, note: 'payments unconfigured' } };
    const rf = await this.payments.refundAd(e.adId);
    if (rf.ok) return { status: 200, body: { ok: true, decision: 'reject', refunded: true, alreadyRefunded: !!rf.alreadyRefunded } };
    // Nothing to refund / disputed / inert → done, don't 409-loop (a disputed ad
    // is handled by the chargeback, not a refund).
    if (['no_payment_to_refund', 'disputed', 'payments_unconfigured'].includes(rf.error)) {
      return { status: 200, body: { ok: true, decision: 'reject', refunded: false, note: rf.error } };
    }
    // A refund that could not be issued (e.g. Stripe down) → 409 so KAX retries;
    // the ad is 'rejected', refundAd is idempotent, the retry completes it.
    return { status: 409, body: { ok: false, reason: rf.error } };
  }
}

module.exports = { RadioAdBridge };
