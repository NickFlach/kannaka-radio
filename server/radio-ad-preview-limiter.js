'use strict';

/**
 * radio-ad-preview-limiter.js — rate + concurrency + daily caps for the
 * pre-payment, unauthenticated ad TTS preview.
 *
 * The design review flagged the preview as a cost + disk-fill DoS against the
 * LIVE station on O1 (unauthenticated TTS, ~91% disk): an abuser loops
 * previews to saturate CPU (starving the live-stream render) and fill the
 * disk. Three guards, all in-memory (a preview limiter need not survive a
 * restart):
 *   - per-IP: a bounded number of previews per rolling window;
 *   - global concurrency: cap simultaneous TTS renders so previews can never
 *     starve the airing render pipeline;
 *   - global daily: a backstop on total previews/day (identical text is a
 *     hash cache-hit upstream, so this bounds only NOVEL text).
 *
 * Two-phase by design, so a request that dies before its body arrives can
 * never leak a concurrency slot (the diff review's MAJOR finding):
 *   - admit(ip): the CHEAP per-IP + daily check. Runs BEFORE the body is
 *     read, so a spammer is rejected without us reading their payload. It
 *     does NOT reserve a render slot.
 *   - acquireSlot()/releaseSlot(): the concurrency slot. Reserved right
 *     before the actual render and released in a finally, so it brackets ONLY
 *     the render. If the body never arrives (413 oversize, slow-loris abort —
 *     readBody never fires its callback), no slot was ever taken, so none can
 *     leak.
 *
 * Pure + injectable clock so the windows are unit-testable.
 */

class PreviewLimiter {
  constructor(opts = {}) {
    this.perIpMax = opts.perIpMax ?? 5;
    this.perIpWindowMs = opts.perIpWindowMs ?? 10 * 60_000;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.dailyMax = opts.dailyMax ?? 500;
    this._ip = new Map();       // ip -> number[] (timestamps in window)
    this._inFlight = 0;
    this._day = null;           // YYYY-MM-DD
    this._dayCount = 0;
  }

  _rollDay(now) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this._day) { this._day = day; this._dayCount = 0; }
  }

  /**
   * Cheap admission check: per-IP rolling window + global daily cap. Consumes
   * one unit of the per-IP and daily budgets on success. Does NOT reserve a
   * concurrency slot — call acquireSlot() for that, immediately before the
   * render. Runs before the request body is read so a rejected caller costs
   * us nothing but this check.
   * Returns { ok } or { ok:false, reason:'daily_cap'|'rate', retryAfterSec }.
   */
  admit(ip, now = Date.now()) {
    this._rollDay(now);
    if (this._dayCount >= this.dailyMax) {
      return { ok: false, reason: 'daily_cap', retryAfterSec: 3600 };
    }
    const key = ip || 'unknown';
    const cutoff = now - this.perIpWindowMs;
    const hits = (this._ip.get(key) || []).filter((t) => t > cutoff);
    if (hits.length >= this.perIpMax) {
      const oldest = hits[0];
      return { ok: false, reason: 'rate', retryAfterSec: Math.max(1, Math.ceil((oldest + this.perIpWindowMs - now) / 1000)) };
    }
    hits.push(now);
    this._ip.set(key, hits);
    this._dayCount++;
    // Opportunistic prune so the ip map can't grow unbounded.
    if (this._ip.size > 5000) {
      for (const [k, v] of this._ip) {
        const live = v.filter((t) => t > cutoff);
        if (live.length === 0) this._ip.delete(k); else this._ip.set(k, live);
      }
    }
    return { ok: true };
  }

  /**
   * Reserve a render slot. Returns true if a slot was free (caller MUST call
   * releaseSlot() when the render settles, success or failure), or false when
   * all slots are busy — the caller should 429 with reason 'busy'.
   */
  acquireSlot() {
    if (this._inFlight >= this.maxConcurrent) return false;
    this._inFlight++;
    return true;
  }

  releaseSlot() {
    if (this._inFlight > 0) this._inFlight--;
  }
}

module.exports = { PreviewLimiter };
