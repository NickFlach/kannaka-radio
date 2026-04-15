/**
 * ghostsignals-hub.js — Constellation-wide prediction market service.
 *
 * Reference implementation of ADR-0012:
 * https://github.com/NickFlach/open-resonance-collective/blob/main/docs/adr/ADR-0012-constellation-wide-prediction-markets.md
 *
 * Promotes the hologram's in-page GSHub to a server-side, persistent,
 * multi-agent shared market layer. SQLite-backed at ~/.kannaka/ghostsignals.db.
 *
 * Exports a `GhostSignalsHub` class. Call `init()` once at startup, then
 * use `createMarket / placeTrade / resolveMarket / registerTrader / ...`.
 *
 * The HTTP layer in routes.js wraps these methods.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// We require the stem-server's sqlite3 install if available — both apps
// run on the same host so they share the binary. Falls back to the local
// kannaka-radio install if present.
function loadSqlite3() {
  const tries = [
    '/home/opc/open-resonance-collective/packages/stem-server/node_modules/sqlite3',
    'sqlite3',
  ];
  for (const p of tries) {
    try { return require(p).verbose(); } catch (_) {}
  }
  throw new Error('sqlite3 module not found — install in radio or stem-server');
}

// ── LMSR cost function helpers ────────────────────────────────────────
function lmsrCost(q, b) {
  const max = Math.max(...q) / b;
  let s = 0;
  for (const qi of q) s += Math.exp(qi / b - max);
  return b * (max + Math.log(s));
}
function lmsrPrices(q, b) {
  const max = Math.max(...q) / b;
  const exps = q.map(qi => Math.exp(qi / b - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

// ── Brier score for reputation update ─────────────────────────────────
function brierAccuracy(predictedProb, actualOutcome /* 1 if happened, 0 else */) {
  const diff = predictedProb - actualOutcome;
  return 1 - diff * diff; // [0, 1] — higher = more accurate
}

class GhostSignalsHub {
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || path.join(process.env.HOME || '/home/opc', '.kannaka', 'ghostsignals.db');
    this.startingCapital = opts.startingCapital || 100;
    this.defaultLiquidity = opts.defaultLiquidity || 10;
    this.broadcast = opts.broadcast || (() => {});
    this.db = null;
    this._resolverInterval = null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────
  init() {
    const sqlite3 = loadSqlite3();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new sqlite3.Database(this.dbPath);
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(`CREATE TABLE IF NOT EXISTS traders (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          capital REAL NOT NULL DEFAULT 100,
          reputation REAL NOT NULL DEFAULT 0.5,
          trades_total INTEGER NOT NULL DEFAULT 0,
          trades_won INTEGER NOT NULL DEFAULT 0,
          joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_active DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        this.db.run(`CREATE TABLE IF NOT EXISTS markets (
          id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          outcomes TEXT NOT NULL,
          liquidity REAL NOT NULL,
          q TEXT NOT NULL,
          source TEXT NOT NULL,
          source_app TEXT,
          tag TEXT,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NOT NULL,
          resolved INTEGER NOT NULL DEFAULT 0,
          resolved_outcome INTEGER,
          resolved_at DATETIME,
          resolution_method TEXT,
          volume REAL NOT NULL DEFAULT 0
        )`);
        this.db.run(`CREATE TABLE IF NOT EXISTS trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          market_id TEXT NOT NULL,
          trader_id TEXT NOT NULL,
          outcome_idx INTEGER NOT NULL,
          shares REAL NOT NULL,
          cost REAL NOT NULL,
          recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        this.db.run(`CREATE TABLE IF NOT EXISTS positions (
          market_id TEXT NOT NULL,
          trader_id TEXT NOT NULL,
          outcome_idx INTEGER NOT NULL,
          shares REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (market_id, trader_id, outcome_idx)
        )`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(resolved, expires_at)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_markets_volume ON markets(volume)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_trades_trader ON trades(trader_id)`, (err) => {
          if (err) return reject(err);
          // Seed system trader if not present
          this.db.get('SELECT id FROM traders WHERE id = ?', ['system'], (e, row) => {
            if (row) return resolve();
            this.db.run(
              `INSERT INTO traders (id, display_name, kind, capital, reputation) VALUES (?, ?, ?, ?, ?)`,
              ['system', 'System Bootstrapper', 'system', 1000, 0.5],
              (e2) => e2 ? reject(e2) : resolve()
            );
          });
        });
      });
    });
  }

  startResolverLoop(intervalMs = 10000) {
    if (this._resolverInterval) return;
    this._resolverInterval = setInterval(() => this._resolveExpiredMarkets().catch(() => {}), intervalMs);
  }

  stopResolverLoop() {
    if (this._resolverInterval) {
      clearInterval(this._resolverInterval);
      this._resolverInterval = null;
    }
  }

  // ── Trader API ───────────────────────────────────────────────────
  registerTrader({ id, display_name, kind = 'ai' }) {
    return new Promise((resolve, reject) => {
      const traderId = id || crypto.randomBytes(6).toString('hex');
      this.db.get('SELECT * FROM traders WHERE id = ?', [traderId], (err, row) => {
        if (err) return reject(err);
        if (row) {
          // Refresh last_active
          this.db.run('UPDATE traders SET last_active = CURRENT_TIMESTAMP WHERE id = ?', [traderId]);
          return resolve({ ...row, returning: true });
        }
        this.db.run(
          `INSERT INTO traders (id, display_name, kind, capital) VALUES (?, ?, ?, ?)`,
          [traderId, display_name || traderId, kind, this.startingCapital],
          (e2) => {
            if (e2) return reject(e2);
            this.db.get('SELECT * FROM traders WHERE id = ?', [traderId], (e3, full) => {
              if (e3) return reject(e3);
              this.broadcast({ type: 'gs_trader_joined', data: full });
              resolve({ ...full, returning: false });
            });
          }
        );
      });
    });
  }

  getTrader(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM traders WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        // Add accuracy
        row.accuracy = row.trades_total > 0 ? row.trades_won / row.trades_total : 0;
        resolve(row);
      });
    });
  }

  leaderboard({ sort = 'capital', limit = 20 } = {}) {
    const orderCol = ({ capital: 'capital', reputation: 'reputation', accuracy: '(CAST(trades_won AS REAL) / NULLIF(trades_total, 0))' })[sort] || 'capital';
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT id, display_name, kind, capital, reputation, trades_total, trades_won
         FROM traders
         WHERE id != 'system'
         ORDER BY ${orderCol} DESC
         LIMIT ?`,
        [limit],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(r => ({ ...r, accuracy: r.trades_total > 0 ? r.trades_won / r.trades_total : 0 })));
        }
      );
    });
  }

  // ── Market API ───────────────────────────────────────────────────
  createMarket({ question, outcomes = ['Yes', 'No'], ttl_sec = 3600, liquidity, tag = 'custom', source = 'system', source_app, metadata }) {
    return new Promise((resolve, reject) => {
      const id = 'm_' + crypto.randomBytes(6).toString('hex');
      const lq = liquidity || this.defaultLiquidity;
      const q = new Array(outcomes.length).fill(0);
      const expiresAt = new Date(Date.now() + ttl_sec * 1000).toISOString();
      this.db.run(
        `INSERT INTO markets
          (id, question, outcomes, liquidity, q, source, source_app, tag, metadata, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, question, JSON.stringify(outcomes), lq, JSON.stringify(q),
          source, source_app || null, tag, metadata ? JSON.stringify(metadata) : null,
          expiresAt,
        ],
        (err) => {
          if (err) return reject(err);
          this.getMarket(id).then(m => {
            this.broadcast({ type: 'gs_market_created', data: m });
            resolve(m);
          }).catch(reject);
        }
      );
    });
  }

  getMarket(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM markets WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        resolve(this._enrichMarket(row));
      });
    });
  }

  _enrichMarket(row) {
    const outcomes = JSON.parse(row.outcomes);
    const q = JSON.parse(row.q);
    const prices = lmsrPrices(q, row.liquidity);
    return {
      id: row.id,
      question: row.question,
      outcomes,
      liquidity: row.liquidity,
      q,
      prices,
      source: row.source,
      source_app: row.source_app,
      tag: row.tag,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      created_at: row.created_at,
      expires_at: row.expires_at,
      resolved: !!row.resolved,
      resolved_outcome: row.resolved_outcome,
      resolved_at: row.resolved_at,
      resolution_method: row.resolution_method,
      volume: row.volume,
      ttl_remaining_sec: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
    };
  }

  listMarkets({ sort = 'volume', active = true, limit = 20, tag } = {}) {
    return new Promise((resolve, reject) => {
      const conds = [];
      const params = [];
      if (active) conds.push('resolved = 0');
      if (tag) { conds.push('tag = ?'); params.push(tag); }
      const where = conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '';
      const orderCol = ({
        volume: 'volume DESC',
        recent: 'created_at DESC',
        expiring: 'expires_at ASC',
      })[sort] || 'volume DESC';
      params.push(limit);
      this.db.all(
        `SELECT * FROM markets ${where} ORDER BY ${orderCol} LIMIT ?`,
        params,
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(r => this._enrichMarket(r)));
        }
      );
    });
  }

  async placeTrade({ market_id, trader_id, outcome, shares }) {
    if (!Number.isFinite(shares) || shares <= 0) throw new Error('shares must be positive');
    if (!Number.isInteger(outcome) || outcome < 0) throw new Error('outcome must be a non-negative integer');
    const market = await this.getMarket(market_id);
    if (!market) throw new Error('market not found');
    if (market.resolved) throw new Error('market already resolved');
    if (outcome >= market.outcomes.length) throw new Error('outcome out of range');
    const trader = await this.getTrader(trader_id);
    if (!trader) throw new Error('trader not registered');

    const qBefore = market.q.slice();
    const costBefore = lmsrCost(qBefore, market.liquidity);
    qBefore[outcome] += shares;
    const costAfter = lmsrCost(qBefore, market.liquidity);
    const cost = costAfter - costBefore;

    if (cost > trader.capital) {
      throw new Error(`insufficient capital: cost ${cost.toFixed(2)}, available ${trader.capital.toFixed(2)}`);
    }

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('BEGIN');
        // Update market q + volume
        this.db.run(
          `UPDATE markets SET q = ?, volume = volume + ? WHERE id = ?`,
          [JSON.stringify(qBefore), shares, market_id]
        );
        // Deduct trader capital + bump trades_total
        this.db.run(
          `UPDATE traders SET capital = capital - ?, trades_total = trades_total + 1, last_active = CURRENT_TIMESTAMP WHERE id = ?`,
          [cost, trader_id]
        );
        // Append trade
        this.db.run(
          `INSERT INTO trades (market_id, trader_id, outcome_idx, shares, cost) VALUES (?, ?, ?, ?, ?)`,
          [market_id, trader_id, outcome, shares, cost]
        );
        // Upsert position
        this.db.run(
          `INSERT INTO positions (market_id, trader_id, outcome_idx, shares) VALUES (?, ?, ?, ?)
           ON CONFLICT(market_id, trader_id, outcome_idx) DO UPDATE SET shares = shares + ?`,
          [market_id, trader_id, outcome, shares, shares],
          (err) => {
            if (err) {
              this.db.run('ROLLBACK');
              return reject(err);
            }
            this.db.run('COMMIT', async () => {
              const updated = await this.getMarket(market_id);
              this.broadcast({ type: 'gs_trade', data: { market_id, trader_id, outcome, shares, cost, prices: updated.prices } });
              resolve({ cost, prices: updated.prices, market: updated });
            });
          }
        );
      });
    });
  }

  /**
   * Resolve a market. Pays out all winning positions at $1/share to their
   * traders, then updates each participating trader's reputation via
   * brier scoring.
   */
  resolveMarket({ market_id, winning_outcome, method = 'manual' }) {
    return new Promise((resolve, reject) => {
      this.getMarket(market_id).then(market => {
        if (!market) return reject(new Error('market not found'));
        if (market.resolved) return reject(new Error('already resolved'));
        if (winning_outcome < 0 || winning_outcome >= market.outcomes.length) {
          return reject(new Error('winning_outcome out of range'));
        }
        const finalPrices = market.prices.slice();
        this.db.serialize(() => {
          this.db.run('BEGIN');
          this.db.run(
            `UPDATE markets SET resolved = 1, resolved_outcome = ?, resolved_at = CURRENT_TIMESTAMP, resolution_method = ? WHERE id = ?`,
            [winning_outcome, method, market_id]
          );
          // Pay out winning shares + update reputation for every participant
          this.db.all(
            `SELECT trader_id, outcome_idx, shares FROM positions WHERE market_id = ?`,
            [market_id],
            (err, positions) => {
              if (err) { this.db.run('ROLLBACK'); return reject(err); }
              const traders = new Map();
              for (const p of positions) {
                if (!traders.has(p.trader_id)) traders.set(p.trader_id, { yes: 0, no: 0, totalShares: 0 });
                const t = traders.get(p.trader_id);
                t.totalShares += p.shares;
                if (p.outcome_idx === winning_outcome) t.yes += p.shares;
                else t.no += p.shares;
              }
              const tasks = [];
              for (const [trader_id, t] of traders.entries()) {
                // Payout = winning shares × $1
                const payout = t.yes;
                // Compute brier-style accuracy update from this trader's
                // implied predicted probability (their share allocation
                // toward the winning outcome).
                const impliedYes = t.totalShares > 0 ? t.yes / t.totalShares : 0.5;
                const accuracy = brierAccuracy(impliedYes, 1);
                tasks.push(new Promise((ok, fail) => {
                  this.db.run(
                    `UPDATE traders SET
                       capital = capital + ?,
                       trades_won = trades_won + ?,
                       reputation = reputation * 0.95 + ? * 0.05,
                       last_active = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [payout, t.yes > 0 ? 1 : 0, accuracy, trader_id],
                    (e) => e ? fail(e) : ok()
                  );
                }));
              }
              Promise.all(tasks).then(() => {
                this.db.run('COMMIT', () => {
                  this.getMarket(market_id).then(m => {
                    this.broadcast({ type: 'gs_market_resolved', data: { ...m, finalPrices } });
                    resolve(m);
                  });
                });
              }).catch(e => { this.db.run('ROLLBACK'); reject(e); });
            }
          );
        });
      }).catch(reject);
    });
  }

  /**
   * Auto-resolve markets whose TTL expired. Winner is whichever outcome
   * had the higher final price. Called by the resolver loop.
   */
  async _resolveExpiredMarkets() {
    return new Promise((resolve) => {
      this.db.all(
        `SELECT * FROM markets WHERE resolved = 0 AND expires_at < datetime('now')`,
        async (err, rows) => {
          if (err) return resolve();
          for (const row of rows) {
            try {
              const m = this._enrichMarket(row);
              const winner = m.prices.indexOf(Math.max(...m.prices));
              await this.resolveMarket({ market_id: m.id, winning_outcome: winner, method: 'ttl' });
            } catch (_e) { /* silent */ }
          }
          resolve();
        }
      );
    });
  }

  // ── Stats ────────────────────────────────────────────────────────
  getHubStats() {
    return new Promise((resolve, reject) => {
      const stats = {};
      this.db.serialize(() => {
        this.db.get('SELECT COUNT(*) AS c FROM traders WHERE id != "system"', (e, r) => { stats.traders = r ? r.c : 0; });
        this.db.get('SELECT COUNT(*) AS c FROM markets', (e, r) => { stats.markets_total = r ? r.c : 0; });
        this.db.get('SELECT COUNT(*) AS c FROM markets WHERE resolved = 0', (e, r) => { stats.markets_active = r ? r.c : 0; });
        this.db.get('SELECT COUNT(*) AS c FROM trades', (e, r) => {
          stats.trades_total = r ? r.c : 0;
          resolve(stats);
        });
      });
    });
  }
}

module.exports = { GhostSignalsHub, lmsrCost, lmsrPrices };
