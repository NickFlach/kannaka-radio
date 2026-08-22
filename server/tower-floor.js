'use strict';

/**
 * tower-floor.js — Ghost Signals Analytics, the tenant side.
 *
 * The dogfood tenancy for KAX-ADR-0005: kannaka-radio leases a floor in the
 * Ghost Signals Tower and runs a reading room on it. The tower delivers the
 * floor's events (chat lines spoken on the floor, panel updates, lease state)
 * to POST /api/tower-floor/events, HMAC-signed. This module is the receiver:
 * it verifies the signature, folds the events into a small in-memory brief,
 * and nothing more — a reading room reads.
 *
 * The secret is the one the tower returned ONCE when the webhook was
 * registered (POST /tower/storey/:n/webhook). It lives in TOWER_WEBHOOK_SECRET
 * on this box; without it the endpoint is inert (503), which is the honest
 * state before the lease is granted and the webhook registered on prod.
 *
 * Deliberately NOT durable: the tower's outbox is the durable record and
 * retries; this side keeps a bounded recent view for the panel/brief and is
 * free to lose it on restart. Verifying a signed delivery must never trust
 * the body before the signature checks out.
 */

const crypto = require('crypto');

const MAX_BRIEF_LINES = 100;

// The rolling brief. Bounded; oldest lines fall off. Reset on restart.
const brief = {
  floorNo: null,
  lease: null, // "granted" | "dark" | "undark" | "ended"
  panelHeadline: null,
  lines: [], // { at, name, text }
  counts: { chat: 0, panel: 0, lease: 0 },
  lastDeliveryId: null,
};

/** The tower's signature format: `sha256=<hex hmac of the exact body>`. */
function expectedSignature(secret, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * Constant-time verify. Returns true only when the header is present, the
 * secret is set, and the digest matches the exact bytes received.
 */
function verifyTowerSignature(secret, rawBody, headerSig) {
  if (!secret || typeof headerSig !== 'string') return false;
  const expected = expectedSignature(secret, rawBody);
  const a = Buffer.from(headerSig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Fold one already-verified event into the brief. Idempotent on delivery id:
 * the tower may re-deliver (at-least-once), and a reading room must not
 * double-count a re-sent line.
 */
function applyTowerEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.id != null && event.id === brief.lastDeliveryId) return; // immediate dup
  brief.lastDeliveryId = event.id ?? brief.lastDeliveryId;
  if (event.floorNo != null) brief.floorNo = event.floorNo;
  const p = event.payload || {};
  switch (event.kind) {
    case 'chat.said':
      brief.counts.chat++;
      brief.lines.push({ at: event.at ?? null, name: p.name ?? null, text: String(p.text ?? '').slice(0, 280) });
      if (brief.lines.length > MAX_BRIEF_LINES) brief.lines.splice(0, brief.lines.length - MAX_BRIEF_LINES);
      break;
    case 'panel.updated':
      brief.counts.panel++;
      brief.panelHeadline = p.headline ?? null;
      break;
    case 'lease.granted': brief.counts.lease++; brief.lease = 'granted'; break;
    case 'lease.dark': brief.counts.lease++; brief.lease = 'dark'; break;
    case 'lease.undark': brief.counts.lease++; brief.lease = 'undark'; break;
    case 'lease.ended': brief.counts.lease++; brief.lease = 'ended'; break;
    default: break; // an unknown kind is not an error — forward-compatible
  }
}

function towerBrief() {
  return {
    floorNo: brief.floorNo,
    lease: brief.lease,
    panelHeadline: brief.panelHeadline,
    recentLines: brief.lines.slice(-20),
    counts: { ...brief.counts },
  };
}

/**
 * The HTTP handler. `rawBody` MUST be the exact bytes received (the signature
 * is over them) — routes.js reads it with readBody before calling in.
 * Returns { status, body } for the caller to write.
 */
function receiveTowerEvent(rawBody, headers, secret = process.env.TOWER_WEBHOOK_SECRET) {
  if (!secret) {
    return { status: 503, body: { ok: false, error: 'tower receiver not configured (TOWER_WEBHOOK_SECRET unset)' } };
  }
  const sig = headers['x-tower-signature'];
  if (!verifyTowerSignature(secret, rawBody, sig)) {
    return { status: 401, body: { ok: false, error: 'bad or missing signature' } };
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid json' } };
  }
  applyTowerEvent(event);
  return { status: 200, body: { ok: true } };
}

/** Test-only: clear the brief between cases. */
function _resetBrief() {
  brief.floorNo = null;
  brief.lease = null;
  brief.panelHeadline = null;
  brief.lines = [];
  brief.counts = { chat: 0, panel: 0, lease: 0 };
  brief.lastDeliveryId = null;
}

module.exports = {
  verifyTowerSignature,
  expectedSignature,
  applyTowerEvent,
  towerBrief,
  receiveTowerEvent,
  _resetBrief,
  MAX_BRIEF_LINES,
};
