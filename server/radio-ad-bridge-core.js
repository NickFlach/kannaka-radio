'use strict';

/**
 * radio-ad-bridge-core.js — the pure half of the radio↔KAX approval bridge
 * (radio-ads slice 4). HMAC sign/verify, enact validation, and delivery
 * backoff, unit-testable without the network or a DB.
 *
 * TWO secrets, one per direction (review M1), so a captured message can never
 * be replayed against the OTHER endpoint (confused-deputy):
 *   - RADIO_KAX_RAISE_SECRET  — radio signs the raise; KAX verifies.
 *   - KAX_RADIO_ENACT_SECRET  — KAX signs the enact; radio verifies.
 * Signature is `t=<unix>,v1=<hmac_sha256(`${t}.${rawBody}`)>` over the RAW body,
 * verified timing-safe with a ±tolerance replay window (same shape as the
 * Stripe webhook). The ad state machine — not the HMAC — is the exactly-once
 * layer (a replay inside the window is accepted, then idempotent → harmless).
 */

const crypto = require('crypto');

const SIGNATURE_TOLERANCE_SEC = 300;

/** Sign a raw body → the `t=..,v1=..` header value. nowSec injected for tests. */
function signBridge(rawBody, secret, nowSec) {
  const t = String(nowSec);
  const body = typeof rawBody === 'string' ? rawBody : String(rawBody == null ? '' : rawBody);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Verify a bridge signature over the raw body. Mirrors verifyStripeSignature:
 *  timing-safe, tolerance both directions, malformed → false. */
function verifyBridge(rawBody, header, secret, nowSec, toleranceSec = SIGNATURE_TOLERANCE_SEC) {
  if (typeof header !== 'string' || !header || typeof secret !== 'string' || !secret) return false;
  const body = typeof rawBody === 'string' ? rawBody : String(rawBody == null ? '' : rawBody);
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
  if (toleranceSec && Math.abs(Number(nowSec) - ts) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest();
  for (const v1 of v1s) {
    let got;
    try { got = Buffer.from(v1, 'hex'); } catch { continue; }
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return true;
  }
  return false;
}

/** Validate a parsed enact body. Returns { ok, decision } or { ok:false, error }. */
function parseEnact(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_body' };
  const adId = typeof body.adId === 'string' ? body.adId.trim() : '';
  const decision = body.decision;
  if (!adId) return { ok: false, error: 'missing_adId' };
  if (decision !== 'approve' && decision !== 'reject' && decision !== 'kill') return { ok: false, error: 'bad_decision' };
  return { ok: true, adId, decision };
}

/**
 * Capped exponential backoff for a failed raise delivery. Raises retry FOREVER
 * (money — review M5), so there is no terminal state; the delay just caps out.
 * attempts is the count BEFORE this failure (0 on the first).
 */
function raiseBackoffMs(attempts, baseMs = 30_000, capMs = 60 * 60_000) {
  const n = Math.max(0, Number(attempts) || 0);
  const exp = Math.min(capMs, baseMs * Math.pow(2, Math.min(n, 20)));
  return Math.min(capMs, exp);
}

module.exports = { SIGNATURE_TOLERANCE_SEC, signBridge, verifyBridge, parseEnact, raiseBackoffMs };
