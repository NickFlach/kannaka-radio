'use strict';

/**
 * radio-ads-core.js — the pure half of the self-serve radio ad subsystem
 * (KAX radio-ads design v2, slice 2). No I/O, so bands, validation, the
 * airing state machine, and date bucketing can be unit-tested without a
 * database or the DJ engine. The durable store + CAS airing ledger live in
 * radio-ads.js and answer to this.
 *
 * WHY a separate subsystem (not the house commercials pool): dj-engine's
 * interleaveCommercials injects a shared pool every N tracks and EXEMPTS
 * commercials from the no-repeat ledger, so a paid ad routed through it would
 * air constantly across every channel. Paid ads air exactly once per day in
 * one band for their run, gated by a durable per-(ad, day) claim.
 */

const crypto = require('crypto');

// ── Bands ───────────────────────────────────────────────────
// Four rough windows, by station-local hour (the O1 host runs UTC; a future
// TZ knob can shift these without touching callers). A customer picks the
// band their spot "likely airs" in — approximate by design.
const RADIO_AD_BANDS = ['morning', 'afternoon', 'evening', 'late_night'];

/** The band an hour-of-day (0-23) falls in. */
function bandForHour(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (h >= 6 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  if (h >= 18 && h < 24) return 'evening';
  return 'late_night'; // 0–6
}

function currentBand(now = new Date()) {
  return bandForHour(now.getUTCHours());
}

function isValidBand(b) {
  return RADIO_AD_BANDS.includes(b);
}

/** Station-day bucket (UTC) as YYYY-MM-DD — the airing ledger's calendar key. */
function stationDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// ── Ad text ─────────────────────────────────────────────────
// ~30 seconds of Kannaka's read. edge-TTS reads ~150 wpm ≈ 75 words in 30s;
// cap on characters so a customer can't buy a 30s spot and submit a monologue.
const MAX_AD_CHARS = 480;
const MIN_AD_CHARS = 8;

class InvalidAdText extends Error {
  constructor(msg) { super(msg); this.code = 'invalid_ad_text'; }
}

/** Normalize + validate submitted ad text. Throws InvalidAdText. */
function normalizeAdText(raw) {
  if (typeof raw !== 'string') throw new InvalidAdText('ad text must be a string');
  // Collapse whitespace and strip control chars — this becomes spoken audio
  // and a stored asset; no newlines/escapes smuggled in.
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < MIN_AD_CHARS) throw new InvalidAdText(`ad text must be at least ${MIN_AD_CHARS} characters`);
  if (text.length > MAX_AD_CHARS) throw new InvalidAdText(`ad text must be at most ${MAX_AD_CHARS} characters (about 30 seconds spoken)`);
  return text;
}

/** Content hash — freezes the render identity. The airing asset and the
 *  preview are the SAME file keyed by this, so what airs is exactly what was
 *  previewed/approved (no bait-and-switch, no re-render drift). */
function contentHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ── State machine ───────────────────────────────────────────
// The full money lifecycle; slice 2 exercises draft→approved→scheduled→
// airing→completed + killed. paid/pending/rejected/refunded/disputed arrive
// with the Stripe + approval slices.
const AD_STATES = ['draft', 'paid', 'pending', 'approved', 'scheduled', 'airing', 'completed', 'rejected', 'refunded', 'killed', 'disputed'];

const AD_TRANSITIONS = {
  draft: ['paid', 'rejected'],
  paid: ['pending', 'refunded'],
  pending: ['approved', 'rejected'],
  approved: ['scheduled', 'rejected'],
  scheduled: ['airing', 'completed', 'killed', 'disputed'],
  airing: ['scheduled', 'completed', 'killed', 'disputed'],
  completed: [],
  rejected: ['refunded'],
  refunded: [],
  killed: ['refunded'],
  disputed: [],
};

function canTransition(from, to) {
  return Array.isArray(AD_TRANSITIONS[from]) && AD_TRANSITIONS[from].includes(to);
}

/** Is an ad eligible to air right now, purely from its row + the clock? The
 *  db layer adds the "not already aired today" check via the ledger CAS. */
function airEligible(ad, now = new Date()) {
  if (!ad || ad.status !== 'scheduled') return false;
  if (!ad.tts_file) return false; // never air an unrendered ad
  if (ad.band !== currentBand(now)) return false;
  if (ad.airings_done >= ad.run_days) return false;
  if (ad.last_aired_date === stationDay(now)) return false; // once per day
  return true;
}

module.exports = {
  RADIO_AD_BANDS, bandForHour, currentBand, isValidBand, stationDay,
  MAX_AD_CHARS, MIN_AD_CHARS, InvalidAdText, normalizeAdText, contentHash,
  AD_STATES, AD_TRANSITIONS, canTransition, airEligible,
};
