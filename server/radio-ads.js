'use strict';

/**
 * radio-ads.js — durable store + airing ledger for self-serve radio ads
 * (KAX radio-ads design v2, slice 2).
 *
 * SQLite (async sqlite3, the same lib the GhostSignals hub uses), its own
 * file under KANNAKA_DATA_DIR. Two tables:
 *   - radio_ads: the ad + its run state (band, run days, airings_done, …).
 *   - radio_ad_airings: a per-(ad, station-day) ledger row, UNIQUE(ad_id,
 *     air_date). Inserting it BEFORE the audio plays is the atomic
 *     check-and-set that makes "once per day" survive a restart: a re-air on
 *     a day already aired fails the unique constraint and is skipped.
 *
 * Callbacks are load-bearing on every db.run (a callback-less run that errors
 * emits an unhandled 'error' that crashes the shared radio process — see the
 * hub). Every write is a single statement; no BEGIN/COMMIT, so the nested-tx
 * crash class (radio #234) can't arise here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const {
  isValidBand, currentBand, stationDay, normalizeAdText, contentHash, airEligible,
} = require('./radio-ads-core');

class RadioAdStore {
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || path.join(
      process.env.KANNAKA_DATA_DIR || path.join(os.homedir(), '.kannaka'),
      'radio-ads.db',
    );
    // Where frozen TTS renders live — a subdir of the music dir so the DJ
    // engine can reference them by a music-relative path like commercials.
    this.assetDir = opts.assetDir || null; // set by init() caller
    this.db = null;
  }

  init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) return reject(err);
        this.db.serialize(() => {
          this.db.run(`CREATE TABLE IF NOT EXISTS radio_ads (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'draft',
            text TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            tts_file TEXT,
            band TEXT NOT NULL,
            run_days INTEGER NOT NULL DEFAULT 7,
            run_start_date TEXT,
            airings_done INTEGER NOT NULL DEFAULT 0,
            last_aired_date TEXT,
            requested_by TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`);
          this.db.run(`CREATE TABLE IF NOT EXISTS radio_ad_airings (
            ad_id TEXT NOT NULL,
            air_date TEXT NOT NULL,
            aired_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (ad_id, air_date)
          )`, (e) => (e ? reject(e) : resolve(this)));
        });
      });
    });
  }

  _run(sql, params = []) { return new Promise((res, rej) => this.db.run(sql, params, function (e) { e ? rej(e) : res(this); })); }
  _get(sql, params = []) { return new Promise((res, rej) => this.db.get(sql, params, (e, row) => (e ? rej(e) : res(row)))); }
  _all(sql, params = []) { return new Promise((res, rej) => this.db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows)))); }

  // ── Lifecycle ──────────────────────────────────────────────

  /** Create a draft ad. Validates + freezes the content hash. Money and the
   *  approval linkage attach in later slices; slice 2 stops at draft. */
  async createDraft({ text, band, requestedBy = null, runDays = 7 }) {
    const clean = normalizeAdText(text); // throws InvalidAdText
    if (!isValidBand(band)) throw new Error(`invalid band "${band}"`);
    const id = 'ad_' + crypto.randomBytes(9).toString('base64url');
    const hash = contentHash(clean);
    await this._run(
      `INSERT INTO radio_ads (id, status, text, content_hash, band, run_days, requested_by) VALUES (?, 'draft', ?, ?, ?, ?, ?)`,
      [id, clean, hash, band, runDays, requestedBy ? String(requestedBy).slice(0, 200) : null],
    );
    return { id, contentHash: hash, text: clean, band };
  }

  getAd(id) { return this._get(`SELECT * FROM radio_ads WHERE id = ?`, [id]); }

  /**
   * Freeze the ad's TTS render and reuse it as BOTH the preview and the
   * airing asset — keyed by content hash so identical text renders once and
   * what airs is exactly what was previewed. Idempotent: an existing file for
   * the hash is reused, never re-rendered.
   *
   * @param voiceDJ shared VoiceDJ (generateTTS(text, cb))
   */
  async renderAd(id, voiceDJ) {
    if (!this.assetDir) throw new Error('radio-ads asset dir not configured');
    const ad = await this.getAd(id);
    if (!ad) throw new Error(`ad ${id} not found`);
    const relPrefix = path.basename(this.assetDir);
    const fileName = `ad_${ad.content_hash}.mp3`;
    const absPath = path.join(this.assetDir, fileName);
    const relFile = path.join(relPrefix, fileName);
    if (fs.existsSync(absPath)) {
      await this._run(`UPDATE radio_ads SET tts_file = ?, updated_at = datetime('now') WHERE id = ?`, [relFile, id]);
      return { file: relFile, cached: true };
    }
    if (!fs.existsSync(this.assetDir)) fs.mkdirSync(this.assetDir, { recursive: true });
    const tmpPath = await new Promise((resolve, reject) => {
      voiceDJ.generateTTS(ad.text, (err, p) => (err || !p ? reject(err || new Error('tts produced no file')) : resolve(p)));
    });
    fs.copyFileSync(tmpPath, absPath);
    try { fs.unlinkSync(tmpPath); } catch { /* tmp cleanup best-effort */ }
    await this._run(`UPDATE radio_ads SET tts_file = ?, updated_at = datetime('now') WHERE id = ?`, [relFile, id]);
    return { file: relFile, cached: false };
  }

  /**
   * Move an approved ad into the scheduled run (this is what the KAX approval
   * handler will call in a later slice; exposed now for the airing tests and
   * the eventual enact callback). Requires a frozen render — an unrendered ad
   * must never be scheduled. Sets run_start_date to today.
   */
  async scheduleAd(id, now = new Date()) {
    const ad = await this.getAd(id);
    if (!ad) throw new Error(`ad ${id} not found`);
    if (!ad.tts_file) throw new Error(`ad ${id} has no rendered audio — render before scheduling`);
    // Idempotent: already scheduled is a no-op success (the enact callback is
    // at-least-once).
    if (ad.status === 'scheduled') return { id, status: 'scheduled', already: true };
    await this._run(
      `UPDATE radio_ads SET status = 'scheduled', run_start_date = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('approved','scheduled')`,
      [stationDay(now), id],
    );
    return { id, status: 'scheduled', already: false };
  }

  /** Kill switch: stop future airings immediately. The selector re-checks
   *  status at air time, so a killed ad stops on the next window. */
  async killAd(id) {
    await this._run(`UPDATE radio_ads SET status = 'killed', updated_at = datetime('now') WHERE id = ? AND status IN ('scheduled','airing')`, [id]);
    return { id, status: 'killed' };
  }

  // ── The airing ledger ──────────────────────────────────────

  /** Scheduled ads for a band that haven't finished their run — candidates
   *  before the per-day CAS. */
  eligibleForBand(band, now = new Date()) {
    return this._all(
      `SELECT * FROM radio_ads WHERE status = 'scheduled' AND band = ? AND tts_file IS NOT NULL AND airings_done < run_days AND (last_aired_date IS NULL OR last_aired_date != ?) ORDER BY run_start_date, id`,
      [band, stationDay(now)],
    );
  }

  /**
   * Pick the next ad to air right now, claim its airing atomically, and return
   * its track (or null if nothing is due). The claim is an INSERT into
   * radio_ad_airings on the UNIQUE (ad_id, air_date) — a re-air on a
   * day-already-aired throws SQLITE_CONSTRAINT and we skip to the next
   * candidate, so a restart mid-window can never double-air a day. Status is
   * re-checked at claim time (kill switch) via the airEligible predicate.
   *
   * Airs one ad per call; the DJ engine calls this once per band window.
   */
  async pickAiringForNow(now = new Date()) {
    const band = currentBand(now);
    const day = stationDay(now);
    const candidates = await this.eligibleForBand(band, now);
    for (const ad of candidates) {
      if (!airEligible(ad, now)) continue; // status/band/run re-check
      // The CAS: claim today for this ad. UNIQUE(ad_id, air_date) makes the
      // second claimer (or a restart re-run) lose here.
      try {
        await this._run(`INSERT INTO radio_ad_airings (ad_id, air_date) VALUES (?, ?)`, [ad.id, day]);
      } catch (e) {
        if (String(e && e.code).includes('SQLITE_CONSTRAINT')) continue; // already aired today
        throw e;
      }
      // Claimed. Advance the run counters; flip to completed on the last airing.
      const done = ad.airings_done + 1;
      const finished = done >= ad.run_days;
      await this._run(
        `UPDATE radio_ads SET airings_done = ?, last_aired_date = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
        [done, day, finished ? 'completed' : 'scheduled', ad.id],
      );
      return {
        adId: ad.id,
        file: ad.tts_file,
        title: `[SPONSOR] ${ad.id}`,
        commercial: true,
        sponsor: true,
        airing: done,
        of: ad.run_days,
      };
    }
    return null;
  }

  /** Operator/debug view of an ad's run. */
  async adStatus(id) {
    const ad = await this.getAd(id);
    if (!ad) return null;
    const airings = await this._all(`SELECT air_date, aired_at FROM radio_ad_airings WHERE ad_id = ? ORDER BY air_date`, [id]);
    return { ...ad, airings };
  }
}

module.exports = { RadioAdStore };
