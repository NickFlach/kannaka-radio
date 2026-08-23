'use strict';

/**
 * gs-analytics.js — the Ghost Signals Analytics store (Piece 4, v1).
 *
 * Shares the RadioAdStore's SQLite connection (same single-connection,
 * single-statement, callback-load-bearing discipline; no BEGIN/COMMIT — radio
 * #234 stays structurally impossible). Accounts ARE redeemed radio-ad
 * entitlements: redemption is a one-statement CAS on
 * radio_ad_gsa_entitlements, the month runs from REDEMPTION (review B4), the
 * token is stored HASHED (review M1), and every auth re-checks revoked_at live
 * so a charged-back ad loses the perk (review B4).
 *
 * Customer blobs live under /var/oled/kannaka/gsa (NEVER the root FS), with a
 * global byte budget + per-account quota + expiry/orphan sweeps (review M4).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONTROL_CHARS } = require('./gs-analytics-core');

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;      // 5 MB per dataset
const ACCOUNT_QUOTA = 10;                       // live datasets per account
const GLOBAL_BUDGET_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB across all customers
const REPORT_MAX_BYTES = 256 * 1024;            // stored report JSON cap
const EXPIRED_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // keep data 30d past account expiry

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

class GsaStore {
  constructor(opts = {}) {
    this.radio = opts.radioStore;               // RadioAdStore — shares _run/_get/_all
    this.dataDir = opts.dataDir || '/var/oled/kannaka/gsa';
    this._inFlightBytes = 0;                    // budget reservation for uploads mid-write
  }

  _run(sql, p) { return this.radio._run(sql, p); }
  _get(sql, p) { return this.radio._get(sql, p); }
  _all(sql, p) { return this.radio._all(sql, p); }

  /** Schema + boot reconcile. Idempotent (addCol/IF NOT EXISTS patterns). */
  async migrate() {
    const cols = await this._all(`PRAGMA table_info(radio_ad_gsa_entitlements)`);
    const have = new Set(cols.map((c) => c.name));
    const addCol = async (name, decl) => { if (!have.has(name)) await this._run(`ALTER TABLE radio_ad_gsa_entitlements ADD COLUMN ${name} ${decl}`); };
    await addCol('token_hash', 'TEXT');
    await addCol('redeemed_at', 'TEXT');
    await addCol('account_expires_at', 'TEXT');
    await this._run(`CREATE TABLE IF NOT EXISTS gsa_datasets (
      id TEXT PRIMARY KEY,
      ad_id TEXT NOT NULL,
      name TEXT,
      kind TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'uploaded',
      error TEXT,
      report TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Boot reconcile (review M2): a restart mid-analysis must not strand
    // "analyzing forever" — the customer just re-runs it.
    await this._run(`UPDATE gsa_datasets SET status = 'failed', error = 'interrupted by a restart — run analysis again', updated_at = datetime('now') WHERE status = 'analyzing'`);
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch { /* surfaced on first write */ }
  }

  // ── Accounts (entitlement redemption) ──────────────────────

  /**
   * Redeem a radio-ad entitlement → a bearer token. AT-MOST-ONCE via a single
   * guarded UPDATE (the markPaid CAS idiom). The free month runs from
   * REDEMPTION (redeem_by only gates when you may start — review B4).
   * Re-presenting the ad id after redemption ROTATES the token (review M6:
   * the ad id was already the credential; a lost token isn't a locked account).
   */
  async redeem(adId) {
    const id = String(adId || '').trim();
    if (!/^ad_[A-Za-z0-9_-]{4,32}$/.test(id)) return { ok: false, error: 'bad_ad_id' };
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = sha256(token);
    const upd = await this._run(
      `UPDATE radio_ad_gsa_entitlements SET token_hash = ?, redeemed_at = datetime('now'), account_expires_at = datetime('now','+30 days')
        WHERE ad_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND redeem_by >= datetime('now')`,
      [hash, id],
    );
    if (upd && upd.changes) {
      const row = await this._get(`SELECT account_expires_at FROM radio_ad_gsa_entitlements WHERE ad_id = ?`, [id]);
      return { ok: true, token, expiresAt: row && row.account_expires_at };
    }
    // Diagnose (honest errors help real customers; enumeration is moot at 72
    // random bits — review m1) and handle rotation.
    const row = await this._get(`SELECT * FROM radio_ad_gsa_entitlements WHERE ad_id = ?`, [id]);
    if (!row) return { ok: false, error: 'no_entitlement' };
    if (row.revoked_at) return { ok: false, error: 'revoked' };
    if (row.redeemed_at) {
      // Already redeemed: rotate the token on the still-live account.
      const rot = await this._run(
        `UPDATE radio_ad_gsa_entitlements SET token_hash = ? WHERE ad_id = ? AND redeemed_at IS NOT NULL AND revoked_at IS NULL AND account_expires_at > datetime('now')`,
        [hash, id],
      );
      if (rot && rot.changes) return { ok: true, token, rotated: true, expiresAt: row.account_expires_at };
      return { ok: false, error: 'account_expired' };
    }
    return { ok: false, error: 'offer_expired' };
  }

  /** Authenticate a bearer token → the account, or null. Joins the entitlement
   *  LIVE so revocation (chargeback/refund) and expiry apply immediately. */
  async auth(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const row = await this._get(
      `SELECT ad_id, account_expires_at FROM radio_ad_gsa_entitlements
        WHERE token_hash = ? AND revoked_at IS NULL AND redeemed_at IS NOT NULL AND account_expires_at > datetime('now')`,
      [sha256(token)],
    );
    return row ? { adId: row.ad_id, expiresAt: row.account_expires_at } : null;
  }

  // ── Datasets ───────────────────────────────────────────────

  async _liveBytes() {
    const row = await this._get(`SELECT COALESCE(SUM(bytes),0) AS b FROM gsa_datasets WHERE status != 'deleted'`);
    return (row ? row.b : 0) + this._inFlightBytes;
  }

  /** Reserve budget for an in-flight upload; MUST be released in a finally. */
  reserveBytes(n) { this._inFlightBytes += n; }
  releaseBytes(n) { this._inFlightBytes = Math.max(0, this._inFlightBytes - n); }

  /**
   * Create a dataset row + persist the raw blob (tmp+rename). Enforces the
   * per-account quota and the global byte budget. Names are display-only
   * (sanitized); the FILE path uses only the server-generated id.
   */
  async createDataset(account, { name, kind, bytes, text }) {
    if (bytes > MAX_UPLOAD_BYTES) return { ok: false, error: 'too_large' };
    if (kind !== 'csv' && kind !== 'json') return { ok: false, error: 'bad_kind' };
    const live = await this._get(`SELECT COUNT(*) AS n FROM gsa_datasets WHERE ad_id = ? AND status != 'deleted'`, [account.adId]);
    if (live && live.n >= ACCOUNT_QUOTA) return { ok: false, error: 'quota' };
    // The budget reservation is owned HERE, not by the caller: claim this
    // upload's bytes BEFORE the check so two concurrent uploads can't both see
    // room for the last slice, and count them exactly ONCE (_liveBytes already
    // includes _inFlightBytes — adding `bytes` on top double-counted). Released
    // in the finally; from then on the committed row carries the accounting.
    this.reserveBytes(bytes);
    try {
      if ((await this._liveBytes()) > GLOBAL_BUDGET_BYTES) return { ok: false, error: 'capacity' };
      const id = 'ds_' + crypto.randomBytes(9).toString('base64url');
      // eslint-disable-next-line no-control-regex
      const cleanName = String(name || 'dataset').replace(CONTROL_CHARS, ' ').slice(0, 80);
      const abs = this._blobPath(id);
      const part = `${abs}.part-${process.pid}-${Date.now()}`;
      try {
        // ASYNC: up to 5MB, and the live audio pipeline shares this event loop.
        await fs.promises.writeFile(part, text);
        await fs.promises.rename(part, abs); // atomic within the dir
      } catch (e) {
        // A failed write leaves a .part behind. It is invisible to the DB-based
        // budget and was not matched by the orphan sweep, so every failed upload
        // permanently ate up to 5MB of the volume — and failures get MORE likely
        // as it fills. Always clean up.
        try { await fs.promises.unlink(part); } catch (_) { /* nothing to remove */ }
        return { ok: false, error: e && (e.code === 'ENOSPC' || e.code === 'EACCES') ? 'storage_unavailable' : 'store_failed' };
      }
      await this._run(
        `INSERT INTO gsa_datasets (id, ad_id, name, kind, bytes, status) VALUES (?, ?, ?, ?, ?, 'uploaded')`,
        [id, account.adId, cleanName, kind, bytes],
      );
      return { ok: true, id, name: cleanName };
    } finally {
      this.releaseBytes(bytes);
    }
  }

  _blobPath(id) {
    if (!/^ds_[A-Za-z0-9_-]{4,32}$/.test(id)) throw new Error('bad dataset id');
    const abs = path.resolve(this.dataDir, id + '.blob');
    if (!abs.startsWith(path.resolve(this.dataDir))) throw new Error('bad dataset path');
    return abs;
  }

  readBlob(id) { return fs.promises.readFile(this._blobPath(id), 'utf8'); }

  async markAnalyzing(adId, id) {
    const upd = await this._run(`UPDATE gsa_datasets SET status = 'analyzing', updated_at = datetime('now') WHERE id = ? AND ad_id = ? AND status IN ('uploaded','failed','ready')`, [id, adId]);
    return !!(upd && upd.changes);
  }

  async markReady(adId, id, report) {
    let json = JSON.stringify(report);
    if (Buffer.byteLength(json) > REPORT_MAX_BYTES) {
      // Trim the heaviest parts rather than fail: keep signals + caveats + column summaries.
      json = JSON.stringify({ ...report, timeseries: null, correlations: (report.correlations || []).slice(0, 3), truncated: true });
      if (Buffer.byteLength(json) > REPORT_MAX_BYTES) json = JSON.stringify({ rowCount: report.rowCount, signals: report.signals, caveats: report.caveats, truncated: true });
    }
    // CAS on 'analyzing': the customer can Delete while a job is in flight
    // (the row is gone and its blob unlinked). Without this guard the worker's
    // completion resurrected the row as 'ready' with NO blob — it reappeared in
    // the list, re-consumed a quota slot and budget bytes, and Re-analyze 503'd
    // forever. A completion for a deleted dataset is simply dropped.
    await this._run(`UPDATE gsa_datasets SET status = 'ready', report = ?, error = NULL, updated_at = datetime('now') WHERE id = ? AND ad_id = ? AND status = 'analyzing'`, [json, id, adId]);
  }

  async markFailed(adId, id, error) {
    await this._run(`UPDATE gsa_datasets SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND ad_id = ? AND status = 'analyzing'`, [String(error || 'failed').slice(0, 300), id, adId]);
  }

  listDatasets(adId) {
    return this._all(`SELECT id, name, kind, bytes, status, error, created_at, updated_at FROM gsa_datasets WHERE ad_id = ? AND status != 'deleted' ORDER BY created_at DESC`, [adId]);
  }

  getDataset(adId, id) {
    return this._get(`SELECT * FROM gsa_datasets WHERE id = ? AND ad_id = ? AND status != 'deleted'`, [id, adId]);
  }

  /** Delete: CAS the row FIRST, then unlink (a crash between leaves an orphan
   *  blob for the orphan sweep — never a dangling row, review M4). */
  async deleteDataset(adId, id) {
    const upd = await this._run(`UPDATE gsa_datasets SET status = 'deleted', report = NULL, updated_at = datetime('now') WHERE id = ? AND ad_id = ? AND status != 'deleted'`, [id, adId]);
    if (!(upd && upd.changes)) return { ok: false, error: 'not_found' };
    try { fs.unlinkSync(this._blobPath(id)); } catch { /* orphan sweep covers it */ }
    return { ok: true };
  }

  // ── Sweeps ─────────────────────────────────────────────────

  /** Expiry sweep: delete datasets of accounts >30d past expiry (the stated
   *  retention), then orphan blobs (file with no live row, older than grace). */
  async sweep(now = new Date()) {
    const rows = await this._all(
      `SELECT d.id, d.ad_id FROM gsa_datasets d JOIN radio_ad_gsa_entitlements e ON e.ad_id = d.ad_id
        WHERE d.status != 'deleted' AND e.account_expires_at IS NOT NULL AND e.account_expires_at < datetime(?, '-30 days')`,
      [now.toISOString()],
    );
    for (const r of rows) { try { await this.deleteDataset(r.ad_id, r.id); } catch { /* next sweep */ } }
    // Orphan blobs.
    let names = [];
    try { names = fs.readdirSync(this.dataDir); } catch { return { expired: rows.length, orphans: 0 }; }
    let orphans = 0;
    for (const f of names) {
      // Abandoned .part files (an interrupted or failed write) are collected
      // too: they hold real bytes but no row references them, so the DB-based
      // budget cannot see them and nothing else would ever reclaim them.
      if (/^ds_[A-Za-z0-9_-]{4,32}\.blob\.part-/.test(f)) {
        const pabs = path.join(this.dataDir, f);
        try {
          if (now.getTime() - fs.statSync(pabs).mtimeMs > 60 * 60 * 1000) { fs.unlinkSync(pabs); orphans += 1; }
        } catch { /* best-effort */ }
        continue;
      }
      const m = /^(ds_[A-Za-z0-9_-]{4,32})\.blob$/.exec(f);
      if (!m) continue;
      const row = await this._get(`SELECT id FROM gsa_datasets WHERE id = ? AND status != 'deleted'`, [m[1]]);
      if (row) continue;
      const abs = path.join(this.dataDir, f);
      try {
        const age = now.getTime() - fs.statSync(abs).mtimeMs;
        if (age > 24 * 60 * 60 * 1000) { fs.unlinkSync(abs); orphans += 1; }
      } catch { /* best-effort */ }
    }
    return { expired: rows.length, orphans };
  }

  startSweeper({ intervalMs = 6 * 60 * 60 * 1000 } = {}) {
    const t = setInterval(() => { this.sweep().catch(() => {}); }, intervalMs);
    if (t.unref) t.unref();
    this.sweep().catch(() => {});
    return t;
  }
}

module.exports = { GsaStore, MAX_UPLOAD_BYTES, ACCOUNT_QUOTA, GLOBAL_BUDGET_BYTES };
