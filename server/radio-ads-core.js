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

// ── The station clock ───────────────────────────────────────
/**
 * Bands and the airing ledger both run on STATION-LOCAL time.
 *
 * They used to run on UTC, which made the picker lie: the O1 host runs UTC, so
 * a spot bought as "Afternoon · 12p–6p" aired 12:00–18:00 UTC — 7am to 1pm for
 * a Central-time buyer, i.e. their morning. Nobody buying afternoon air time
 * means "while I am asleep or at breakfast".
 *
 * `stationDay` MUST move with the bands, not stay on UTC. It is the airing
 * ledger's calendar key — the thing that enforces once per day — and if the two
 * clocks disagree the day boundary lands inside a band. Concretely, with bands
 * local and the day still UTC, the day would roll at 19:00 Central, mid-evening
 * band: an ad could air at 18:30 (day N) and again at 19:30 (day N+1), burning
 * one paid day twice and breaking the once-a-day promise. One clock, both uses.
 *
 * ⚠ Changing the zone shifts the ledger's day keys. Safe to do while nothing
 * has aired yet; on a station mid-run it can allow one extra airing on the
 * changeover day, so treat the zone as fixed once ads are running.
 */
const STATION_TZ = resolveZone(process.env.RADIO_TZ || 'America/Chicago');

/** An unusable zone must never take the station down — fall back to UTC. */
function resolveZone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[radio-ads] RADIO_TZ="${tz}" is not a usable time zone — falling back to UTC`);
    return 'UTC';
  }
}

// Intl formatters are expensive to build and these run on the airing poller, so
// keep one per zone.
const _fmtCache = new Map();
function _fmt(tz) {
  let f = _fmtCache.get(tz);
  if (!f) {
    const opts = {
      year: 'numeric', month: '2-digit', day: '2-digit',
      // h23 rather than hour12:false — some ICU builds render midnight as "24"
      // under the latter, which would land it in the wrong band.
      hour: '2-digit', hourCycle: 'h23',
    };
    // Guard here as well as at module load: STATION_TZ is validated once, but
    // callers pass a zone explicitly too, and an airing poller must not die of
    // a bad string. UTC is the honest fallback — wrong bands beat no station.
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts });
    } catch {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...opts });
    }
    _fmtCache.set(tz, f);
  }
  return f;
}

/** { year, month, day, hour } for an instant, in the station's zone. */
function stationParts(now = new Date(), tz = STATION_TZ) {
  const out = {};
  for (const p of _fmt(tz).formatToParts(now)) out[p.type] = p.value;
  return out;
}

// ── Bands ───────────────────────────────────────────────────
// Four rough windows, by station-local hour. A customer picks the band their
// spot "likely airs" in — approximate by design.
const RADIO_AD_BANDS = ['morning', 'afternoon', 'evening', 'late_night'];

/** The band an hour-of-day (0-23) falls in. */
function bandForHour(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (h >= 6 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  if (h >= 18 && h < 24) return 'evening';
  return 'late_night'; // 0–6
}

/** The hour of day (0-23) at the station right now. DST-correct via Intl. */
function stationHour(now = new Date(), tz = STATION_TZ) {
  return Number(stationParts(now, tz).hour);
}

function currentBand(now = new Date(), tz = STATION_TZ) {
  return bandForHour(stationHour(now, tz));
}

function isValidBand(b) {
  return RADIO_AD_BANDS.includes(b);
}

/** Station-day bucket as YYYY-MM-DD — the airing ledger's calendar key. */
function stationDay(now = new Date(), tz = STATION_TZ) {
  const p = stationParts(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The zone as a buyer would recognise it ("CDT"/"CST"/"UTC") so the picker can
 *  say whose clock it means instead of leaving them to guess. */
function stationZoneLabel(now = new Date(), tz = STATION_TZ) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(now);
    const z = parts.find((p) => p.type === 'timeZoneName');
    return (z && z.value) || tz;
  } catch {
    return tz;
  }
}

/** Human labels for the picker, stamped with the station's current zone. */
const BAND_HOURS = { morning: '6a–12p', afternoon: '12p–6p', evening: '6p–12a', late_night: '12a–6a' };
const BAND_NAMES = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', late_night: 'Late night' };
function bandOptions(now = new Date(), tz = STATION_TZ) {
  const zone = stationZoneLabel(now, tz);
  return RADIO_AD_BANDS.map((id) => ({ id, label: `${BAND_NAMES[id]} · ${BAND_HOURS[id]} ${zone}` }));
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
  // paid → approved/rejected directly too: the raise's best-effort paid→pending
  // marker may not have landed when the operator decides, so the enact drives
  // approveAndSchedule/rejectAd straight from 'paid' (radio-ads slice 4).
  paid: ['pending', 'approved', 'rejected', 'refunded'],
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
  if (ad.disputed_at) return false; // a disputed charge must stop airing (slice 5, orthogonal to status)
  if (!ad.tts_file) return false; // never air an unrendered ad
  if (ad.band !== currentBand(now)) return false;
  if (ad.airings_done >= ad.run_days) return false;
  if (ad.last_aired_date === stationDay(now)) return false; // once per day
  return true;
}

/** Render a Date in the exact TEXT shape SQLite's `datetime('now')` writes:
 *  "YYYY-MM-DD HH:MM:SS", UTC, no 'T', no fraction, no 'Z'.
 *
 *  Every timestamp column in this store is TEXT written by `datetime('now')`,
 *  so any cutoff we compare against one has to match byte-for-byte — in that
 *  shape lexicographic order IS chronological order. A JS `toISOString()` is
 *  NOT interchangeable: it shares the date prefix and then diverges at ' '
 *  (0x20) vs 'T' (0x54), which silently makes every same-day row compare as
 *  older than the cutoff. Use this for any `<column> < ?` time comparison. */
function sqliteTimestamp(d = new Date()) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  RADIO_AD_BANDS, bandForHour, currentBand, isValidBand, stationDay,
  MAX_AD_CHARS, MIN_AD_CHARS, InvalidAdText, normalizeAdText, contentHash,
  AD_STATES, AD_TRANSITIONS, canTransition, airEligible, sqliteTimestamp,
  STATION_TZ, stationHour, stationParts, stationZoneLabel, bandOptions, BAND_HOURS, BAND_NAMES,
};
