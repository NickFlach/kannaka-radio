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
const os = require('os');
// ADR-0041 Phase 2 (funded-AMM PR 2): labs-tier markets move REAL conserved
// credits on the KAX ledger. INERT until KAX_LEDGER_BASE + tokens are set —
// kax.mintEnabled()/tradeEnabled() gate everything, so with no env every market
// is ledger_backed=0 and the existing SQLite economy runs exactly as before.
const kax = require('./kax-ledger');

// Integer share ticks per share (mirror of kax.MINOR). A winning position pays
// $1/share, so its payout in ledger minor units is exactly its share_ticks.
const SHARE_TICK = kax.MINOR;

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
    // Resolve the DB under the canonical Kannaka data dir. `KANNAKA_DATA_DIR`
    // wins (matches the rest of the constellation); otherwise fall back to
    // `~/.kannaka` via os.homedir() so Windows hosts without $HOME land in the
    // user profile instead of a bogus `\home\opc` root path. (#47)
    this.dbPath = opts.dbPath || path.join(
      process.env.KANNAKA_DATA_DIR || path.join(os.homedir(), '.kannaka'),
      'ghostsignals.db',
    );
    this.startingCapital = opts.startingCapital || 100;
    this.defaultLiquidity = opts.defaultLiquidity || 10;
    this.broadcast = opts.broadcast || (() => {});
    this.db = null;
    this._resolverInterval = null;
    // Serializes write-transactions (see _serializeTx). The whole hub shares
    // ONE sqlite connection, so two overlapping BEGIN…COMMIT blocks error with
    // "cannot start a transaction within a transaction". This chain guarantees
    // one at a time.
    this._txChain = Promise.resolve();
    // Per-market serialization for the ledger path (ADR-0041 PR 2). A labs
    // market's trade unit is price → POST /ledger/trade → q-CAS → position; all
    // of it must be serialized PER MARKET so the q we priced against is still
    // current when we commit (the q-CAS then becomes a should-never-fire assert)
    // and two trades can't both be mid-flight against the same pool.
    this._marketChains = new Map();
  }

  /** Serialize `work` against a single market id (see _marketChains). */
  _serializeMarket(marketId, work) {
    const prev = this._marketChains.get(marketId) || Promise.resolve();
    const result = prev.then(() => work(), () => work());
    // Keep the chain alive regardless of outcome; prune when it drains.
    const link = result.then(() => {}, () => {});
    this._marketChains.set(marketId, link);
    link.then(() => {
      if (this._marketChains.get(marketId) === link) this._marketChains.delete(marketId);
    });
    return result;
  }

  /**
   * A market is ledger-backed iff it was created as labs-tier WHILE the KAX
   * mint+trade surfaces were configured. Dormant by default: with no env, no
   * market is ever ledger_backed, so the SQLite path below is untouched.
   */
  _isLabsLedger(marketRow) {
    return !!(marketRow && marketRow.ledger_backed) && kax.tradeEnabled();
  }

  /**
   * Run a write-transaction with exclusive access to the shared connection.
   * The in-SQL guards (single-flip resolve, guarded debit, q compare-and-swap)
   * provide correctness under contention; this just prevents two transactions
   * from physically interleaving on the one connection (which sqlite rejects).
   * `work` is a thunk returning a Promise for one BEGIN…COMMIT unit.
   */
  _serializeTx(work) {
    const result = this._txChain.then(() => work(), () => work());
    // Keep the chain alive regardless of this unit's outcome.
    this._txChain = result.then(() => {}, () => {});
    return result;
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
        // ── ADR-0041 Phase 2 (funded-AMM PR 2) additive migration ──────────
        // Ledger-backed labs markets carry a lifecycle state + funded subsidy;
        // trades carry audit-grade integer minor units alongside the float; a
        // pending_trades journal records intent BEFORE each ledger POST so an
        // ambiguous outcome is reconcilable. Run unconditionally and swallow the
        // "duplicate column" error so the migration is idempotent across boots.
        const addCol = (sql) => this.db.run(sql, (e) => {
          if (e && !/duplicate column/i.test(e.message)) console.error('gshub migrate:', e.message);
        });
        addCol(`ALTER TABLE markets ADD COLUMN state TEXT NOT NULL DEFAULT 'open'`);
        addCol(`ALTER TABLE markets ADD COLUMN subsidy_minor TEXT`);
        addCol(`ALTER TABLE markets ADD COLUMN ledger_backed INTEGER NOT NULL DEFAULT 0`);
        addCol(`ALTER TABLE trades ADD COLUMN cost_minor TEXT`);
        addCol(`ALTER TABLE trades ADD COLUMN share_ticks INTEGER`);
        // tx_id correlates a committed trade row with its ledger debit, so the
        // reconciler can tell "debit landed AND shares committed" (row exists)
        // from "debit landed, shares did NOT commit" (needs refund).
        addCol(`ALTER TABLE trades ADD COLUMN tx_id TEXT`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_trades_txid ON trades(tx_id)`);
        this.db.run(`CREATE TABLE IF NOT EXISTS pending_trades (
          tx_id TEXT PRIMARY KEY,
          market_id TEXT NOT NULL,
          trader_id TEXT NOT NULL,
          outcome_idx INTEGER NOT NULL,
          shares REAL NOT NULL,
          cost_minor TEXT NOT NULL,
          share_ticks INTEGER NOT NULL,
          q_before TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'posting',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_pending_trades_state ON pending_trades(state)`);
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
    // Boot crash-recovery pass for the ledger path (no-op when KAX unarmed).
    this.reconcile().catch(() => {});
    let tick = 0;
    this._resolverInterval = setInterval(() => {
      this._resolveExpiredMarkets().catch(() => {});
      // Piggyback the ledger reconcile+audit every ~6th tick (≈60s by default).
      if (++tick % 6 === 0) this.reconcile().catch(() => {});
    }, intervalMs);
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
  async createMarket({ question, outcomes = ['Yes', 'No'], ttl_sec = 3600, liquidity, tag = 'custom', source = 'system', source_app, metadata }) {
    const id = 'm_' + crypto.randomBytes(6).toString('hex');
    const lq = liquidity || this.defaultLiquidity;
    const q = new Array(outcomes.length).fill(0);
    const expiresAt = new Date(Date.now() + ttl_sec * 1000).toISOString();
    // Ledger-backed ONLY when created labs-tier AND the KAX mint+trade surfaces
    // are both armed. Dormant otherwise → a plain SQLite market, unchanged.
    const labsLedger = (tag === 'labs' || source === 'kannaka-labs') && kax.mintEnabled() && kax.tradeEnabled();
    const subsidyMinor = labsLedger ? kax.subsidyMinor(lq, outcomes.length) : null;
    const state = labsLedger ? 'pending_escrow' : 'open';

    await this._run(
      `INSERT INTO markets
        (id, question, outcomes, liquidity, q, source, source_app, tag, metadata, expires_at, state, subsidy_minor, ledger_backed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, question, JSON.stringify(outcomes), lq, JSON.stringify(q),
        source, source_app || null, tag, metadata ? JSON.stringify(metadata) : null,
        expiresAt, state, subsidyMinor, labsLedger ? 1 : 0,
      ],
    );

    if (labsLedger) {
      // Fund the LMSR subsidy into the pool BEFORE opening (idempotent escrow:<id>).
      // A definitive rejection voids the market; an ambiguous outcome leaves it
      // pending_escrow for the reconciler — either way it never opens unfunded.
      let r;
      try { r = await kax.escrow({ marketId: id, subsidyMinor, ref: `market:${id}` }); }
      catch (e) { await this._setMarketState(id, 'voided'); throw new Error(`escrow failed to send: ${e.message}`); }
      if (r.ok) {
        await this._setMarketState(id, 'open');
      } else if (r.definitive) {
        await this._setMarketState(id, 'voided');
        throw new Error(`escrow rejected (${r.status}): ${r.error}`);
      } else {
        throw new Error(`escrow ambiguous (${r.status}): ${r.error} — market ${id} pending reconciliation`);
      }
    }

    const m = await this.getMarket(id);
    this.broadcast({ type: 'gs_market_created', data: m });
    return m;
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
      // ADR-0041 PR 2: ledger lifecycle. Defaults ('open'/0/null) mean the
      // pre-ledger SQLite economy, so existing markets read back unchanged.
      state: row.state || 'open',
      ledger_backed: !!row.ledger_backed,
      subsidy_minor: row.subsidy_minor || null,
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

    // ADR-0041 PR 2: labs-tier ledger markets move real credits on KAX instead
    // of SQLite capital. Dormant unless the market was created ledger-backed.
    if (this._isLabsLedger(market)) {
      return this._placeTradeLedger({ market, trader_id, outcome, shares });
    }

    // The q we read is the state our cost is priced against. The write below
    // is a compare-and-swap on exactly this value (`WHERE q = qBeforeJson`),
    // so a concurrent trade that moved q first makes THIS write a no-op and we
    // roll back — otherwise two trades computed from the same stale snapshot
    // would each overwrite q absolutely (last-writer-wins), silently dropping
    // one trade's shares from the market while both traders keep their credited
    // positions, so total payouts could exceed collected cost (a mint).
    const qBefore = market.q.slice();
    const qBeforeJson = JSON.stringify(qBefore);
    const qAfter = qBefore.slice();
    const costBefore = lmsrCost(qBefore, market.liquidity);
    qAfter[outcome] += shares;
    const costAfter = lmsrCost(qAfter, market.liquidity);
    const cost = costAfter - costBefore;

    if (cost > trader.capital) {
      throw new Error(`insufficient capital: cost ${cost.toFixed(2)}, available ${trader.capital.toFixed(2)}`);
    }

    const self = this;
    return this._serializeTx(() => new Promise((resolve, reject) => {
      self.db.serialize(() => {
        self.db.run('BEGIN');
        // Compare-and-swap the market q. `AND resolved = 0` also blocks a trade
        // that races a resolve. changes()===0 => someone moved q (or resolved)
        // between our read and now; roll back and let the caller retry.
        self.db.run(
          `UPDATE markets SET q = ?, volume = volume + ? WHERE id = ? AND q = ? AND resolved = 0`,
          [JSON.stringify(qAfter), shares, market_id, qBeforeJson],
          function (qErr) {
            if (qErr) { self.db.run('ROLLBACK'); return reject(qErr); }
            if (this.changes === 0) {
              self.db.run('ROLLBACK');
              return reject(new Error('market state changed concurrently; retry'));
            }
            // Guarded debit: the `AND capital >= ?` makes overdraft impossible
            // even if two concurrent trades both passed the JS precheck above —
            // the second sees the already-reduced balance and fails here rather
            // than driving capital negative (a double-spend).
            self.db.run(
              `UPDATE traders SET capital = capital - ?, trades_total = trades_total + 1, last_active = CURRENT_TIMESTAMP WHERE id = ? AND capital >= ?`,
              [cost, trader_id, cost],
              function (dErr) {
                if (dErr) { self.db.run('ROLLBACK'); return reject(dErr); }
                if (this.changes === 0) {
                  self.db.run('ROLLBACK');
                  return reject(new Error('insufficient capital'));
                }
                // Append trade
                self.db.run(
                  `INSERT INTO trades (market_id, trader_id, outcome_idx, shares, cost) VALUES (?, ?, ?, ?, ?)`,
                  [market_id, trader_id, outcome, shares, cost]
                );
                // Upsert position
                self.db.run(
                  `INSERT INTO positions (market_id, trader_id, outcome_idx, shares) VALUES (?, ?, ?, ?)
                   ON CONFLICT(market_id, trader_id, outcome_idx) DO UPDATE SET shares = shares + ?`,
                  [market_id, trader_id, outcome, shares, shares],
                  (err) => {
                    if (err) {
                      self.db.run('ROLLBACK');
                      return reject(err);
                    }
                    self.db.run('COMMIT', async () => {
                      const updated = await self.getMarket(market_id);
                      self.broadcast({ type: 'gs_trade', data: { market_id, trader_id, outcome, shares, cost, prices: updated.prices } });
                      resolve({ cost, prices: updated.prices, market: updated });
                    });
                  }
                );
              }
            );
          }
        );
      });
    }));
  }

  /**
   * Resolve a market. Pays out all winning positions at $1/share to their
   * traders, then updates each participating trader's reputation via
   * brier scoring.
   */
  async resolveMarket({ market_id, winning_outcome, method = 'manual' }) {
    const self = this;
    const market = await this.getMarket(market_id);
    if (!market) throw new Error('market not found');
    if (market.resolved) throw new Error('already resolved');
    if (winning_outcome < 0 || winning_outcome >= market.outcomes.length) {
      throw new Error('winning_outcome out of range');
    }
    // ADR-0041 PR 2: ledger-backed markets settle on KAX (batched payout).
    if (this._isLabsLedger(market)) {
      return this._resolveMarketLedger({ market, winning_outcome, method });
    }
    const finalPrices = market.prices.slice();
    return this._serializeTx(() => new Promise((resolve, reject) => {
        self.db.serialize(() => {
          self.db.run('BEGIN');
          // Single-flip guard: only the transaction that actually changes
          // resolved 0->1 proceeds to pay out. A concurrent resolve (the manual
          // /resolve racing the 10s TTL sweep, or two callers) reads resolved=0
          // in the async gap before this UPDATE, but only ONE of them flips the
          // flag; the loser sees changes()===0 and rolls back WITHOUT paying, so
          // winning positions can never be paid twice (which would mint credits).
          // The `market.resolved` precheck above is only a fast path; THIS is the
          // real guard.
          self.db.run(
            `UPDATE markets SET resolved = 1, resolved_outcome = ?, resolved_at = CURRENT_TIMESTAMP, resolution_method = ? WHERE id = ? AND resolved = 0`,
            [winning_outcome, method, market_id],
            function (uErr) {
              if (uErr) { self.db.run('ROLLBACK'); return reject(uErr); }
              if (this.changes === 0) { self.db.run('ROLLBACK'); return reject(new Error('already resolved')); }
              // Pay out winning shares + update reputation for every participant
              self.db.all(
                `SELECT trader_id, outcome_idx, shares FROM positions WHERE market_id = ?`,
                [market_id],
                (err, positions) => {
                  if (err) { self.db.run('ROLLBACK'); return reject(err); }
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
                      self.db.run(
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
                    self.db.run('COMMIT', () => {
                      self.getMarket(market_id).then(m => {
                        self.broadcast({ type: 'gs_market_resolved', data: { ...m, finalPrices } });
                        resolve(m);
                      });
                    });
                  }).catch(e => { self.db.run('ROLLBACK'); reject(e); });
                }
              );
            }
          );
        });
      }));
  }

  // ── Ledger-path helpers (ADR-0041 PR 2) ─────────────────────────────
  // Small promisified sqlite wrappers keep the money-path code readable; the
  // shared-connection ordering guarantees still hold (calls queue in order, and
  // _serializeTx prevents two BEGIN…COMMIT units from interleaving).
  _run(sql, params = []) { return new Promise((res, rej) => this.db.run(sql, params, function (e) { e ? rej(e) : res(this); })); }
  _get(sql, params = []) { return new Promise((res, rej) => this.db.get(sql, params, (e, row) => e ? rej(e) : res(row))); }
  _all(sql, params = []) { return new Promise((res, rej) => this.db.all(sql, params, (e, rows) => e ? rej(e) : res(rows))); }

  _setMarketState(id, state) { return this._run(`UPDATE markets SET state = ? WHERE id = ?`, [state, id]); }
  _setPendingState(txId, state) {
    return this._run(`UPDATE pending_trades SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE tx_id = ?`, [state, txId]);
  }
  _journalPending(r) {
    return this._run(
      `INSERT INTO pending_trades (tx_id, market_id, trader_id, outcome_idx, shares, cost_minor, share_ticks, q_before, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.txId, r.market_id, r.trader_id, r.outcome, r.shares, r.costMinor, r.shareTicks, r.qBeforeJson, r.state],
    );
  }

  /**
   * Place a labs-tier trade against the KAX ledger. Serialized PER MARKET:
   * re-price under the mutex, journal intent, POST the debit (money first),
   * then commit the shares (q-CAS + position). Ledger-backed traders never
   * touch SQLite capital.
   */
  async _placeTradeLedger({ market, trader_id, outcome, shares }) {
    const market_id = market.id;
    const principal = kax.principalFor(trader_id);
    return this._serializeMarket(market_id, async () => {
      // Re-read INSIDE the mutex so the q we price against is current.
      const m = await this.getMarket(market_id);
      if (!m || m.resolved) throw new Error('market already resolved');
      if (m.state !== 'open') throw new Error(`market not open for trading (state=${m.state})`);
      if (outcome >= m.outcomes.length) throw new Error('outcome out of range');
      const qBefore = m.q.slice();
      const qBeforeJson = JSON.stringify(qBefore);
      const qAfter = qBefore.slice();
      qAfter[outcome] += shares;
      const cost = lmsrCost(qAfter, m.liquidity) - lmsrCost(qBefore, m.liquidity);
      const costMinor = kax.tradeCostMinor(cost);           // ceil, rejects dust <= 0
      const shareTicks = Math.floor(shares * SHARE_TICK);    // floor — pool's favor
      if (!(shareTicks > 0)) throw new Error('shares round to zero ticks');
      const txId = kax.txid.trade(kax.newTradeUuid());

      // 1) Journal intent BEFORE the POST (so an ambiguous outcome is recoverable).
      await this._journalPending({ txId, market_id, trader_id, outcome, shares, costMinor, shareTicks, qBeforeJson, state: 'posting' });

      // 2) Money FIRST — debit trader, credit pool. (q-first would mint free
      //    shares on a crash between shares and money.)
      const r = await kax.trade({ txId, principal, marketId: market_id, amountMinor: costMinor, side: 'buy', ref: `trade:${market_id}` });
      if (!r.ok) {
        if (r.definitive) { await this._setPendingState(txId, 'failed'); throw new Error(`ledger trade rejected (${r.status}): ${r.error}`); }
        await this._setPendingState(txId, 'reconcile');
        throw new Error(`ledger trade ambiguous (${r.status}): ${r.error} — pending reconciliation`);
      }

      // 3) Shares AFTER money: q-CAS + audit-grade trade row + position, one tx.
      //    Under the per-market mutex the CAS should never fail; if it does, the
      //    debit already landed, so flag for refund reconciliation (PR 2c).
      try {
        await this._commitLedgerTradeShares({ txId, market_id, trader_id, outcome, shares, cost, costMinor, shareTicks, qAfterJson: JSON.stringify(qAfter), qBeforeJson });
      } catch (e) {
        await this._setPendingState(txId, 'refund');
        throw new Error(`shares commit failed after ledger debit (refund queued, tx ${txId}): ${e.message}`);
      }
      await this._setPendingState(txId, 'posted');
      const updated = await this.getMarket(market_id);
      this.broadcast({ type: 'gs_trade', data: { market_id, trader_id, outcome, shares, cost, cost_minor: costMinor, ledger: true, prices: updated.prices } });
      return { cost, cost_minor: costMinor, prices: updated.prices, market: updated };
    });
  }

  /** The SQLite side of a ledger trade: q-CAS + trade row + position. No capital. */
  _commitLedgerTradeShares({ txId, market_id, trader_id, outcome, shares, cost, costMinor, shareTicks, qAfterJson, qBeforeJson }) {
    const self = this;
    return this._serializeTx(async () => {
      await self._run('BEGIN');
      try {
        const q = await self._run(
          `UPDATE markets SET q = ?, volume = volume + ? WHERE id = ? AND q = ? AND resolved = 0 AND state = 'open'`,
          [qAfterJson, shares, market_id, qBeforeJson],
        );
        if (q.changes === 0) throw new Error('market state changed concurrently (q-CAS)');
        await self._run(`UPDATE traders SET trades_total = trades_total + 1, last_active = CURRENT_TIMESTAMP WHERE id = ?`, [trader_id]);
        await self._run(
          `INSERT INTO trades (market_id, trader_id, outcome_idx, shares, cost, cost_minor, share_ticks, tx_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [market_id, trader_id, outcome, shares, cost, costMinor, shareTicks, txId],
        );
        await self._run(
          `INSERT INTO positions (market_id, trader_id, outcome_idx, shares) VALUES (?, ?, ?, ?)
           ON CONFLICT(market_id, trader_id, outcome_idx) DO UPDATE SET shares = shares + ?`,
          [market_id, trader_id, outcome, shares, shares],
        );
        await self._run('COMMIT');
      } catch (e) {
        await self._run('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  }

  /** Winning payouts for a ledger market: Σ share_ticks per trader, in minor units. */
  async _winningPayouts(market_id, winning_outcome) {
    const rows = await this._all(
      `SELECT trader_id, COALESCE(SUM(share_ticks), 0) AS ticks
         FROM trades WHERE market_id = ? AND outcome_idx = ? AND share_ticks IS NOT NULL
         GROUP BY trader_id HAVING ticks > 0`,
      [market_id, winning_outcome],
    );
    return rows.map((r) => ({ principal: kax.principalFor(r.trader_id), amountMinor: String(r.ticks) }));
  }

  /** Pool value in minor units = subsidy + Σ cost_minor collected on this market. */
  async _poolValueMinor(market_id, subsidyMinor) {
    const rows = await this._all(`SELECT cost_minor FROM trades WHERE market_id = ? AND cost_minor IS NOT NULL`, [market_id]);
    let sum = BigInt(subsidyMinor || '0');
    for (const r of rows) sum += BigInt(r.cost_minor);
    return sum;
  }

  /**
   * Resolve a ledger-backed market. Freeze trading (single-flip resolved=1)
   * FIRST, then pay all winners out of the pool + sweep residual to house in ONE
   * balanced KAX transaction (txId=resolve:<id>, idempotent). Payout progress is
   * decoupled from the resolved flag: a definitive rejection or ambiguity leaves
   * the (frozen) market for the PR-2c reconciler rather than paying twice.
   */
  async _resolveMarketLedger({ market, winning_outcome, method }) {
    const market_id = market.id;
    const finalPrices = market.prices.slice();
    return this._serializeMarket(market_id, async () => {
      // Freeze — only the transaction that flips 0->1 proceeds.
      const flip = await this._serializeTx(async () => {
        const u = await this._run(
          `UPDATE markets SET resolved = 1, resolved_outcome = ?, resolved_at = CURRENT_TIMESTAMP, resolution_method = ? WHERE id = ? AND resolved = 0`,
          [winning_outcome, method, market_id],
        );
        return u.changes;
      });
      if (flip === 0) throw new Error('already resolved');

      // Trading is frozen. Compute + POST the batched payout (an HTTP call, so
      // OUTSIDE any SQLite transaction).
      const winners = await this._winningPayouts(market_id, winning_outcome);
      const totalPayout = winners.reduce((a, w) => a + BigInt(w.amountMinor), 0n);
      const poolValue = await this._poolValueMinor(market_id, market.subsidy_minor);
      let residual = poolValue - totalPayout;
      if (residual < 0n) {
        // Should be impossible under pool-favor rounding. Never sweep-then-assert:
        // alert, sweep nothing, and let the KAX overdraft guard 409 if truly short.
        console.error(`gshub SOLVENCY ALERT market ${market_id}: payout ${totalPayout} > pool ${poolValue}`);
        residual = 0n;
      }
      if (winners.length > 0) {
        const r = await kax.payout({ marketId: market_id, winners, residualMinor: residual.toString(), ref: `resolve:${market_id}` });
        if (!r.ok && r.definitive) {
          console.error(`gshub payout rejected market ${market_id} (${r.status}): ${r.error} — frozen, awaiting reconciliation`);
        } else if (!r.ok) {
          console.error(`gshub payout ambiguous market ${market_id} (${r.status}): ${r.error} — will reconcile (idempotent resolve:${market_id})`);
        }
      }
      await this._updateLedgerReputation(market_id, winning_outcome).catch(() => {});
      const m = await this.getMarket(market_id);
      this.broadcast({ type: 'gs_market_resolved', data: { ...m, finalPrices, ledger: true } });
      return m;
    });
  }

  /** Non-monetary reputation/accuracy update for a resolved ledger market. */
  async _updateLedgerReputation(market_id, winning_outcome) {
    const positions = await this._all(`SELECT trader_id, outcome_idx, shares FROM positions WHERE market_id = ?`, [market_id]);
    const traders = new Map();
    for (const p of positions) {
      if (!traders.has(p.trader_id)) traders.set(p.trader_id, { yes: 0, total: 0 });
      const t = traders.get(p.trader_id);
      t.total += p.shares;
      if (p.outcome_idx === winning_outcome) t.yes += p.shares;
    }
    for (const [trader_id, t] of traders.entries()) {
      const impliedYes = t.total > 0 ? t.yes / t.total : 0.5;
      const accuracy = brierAccuracy(impliedYes, 1);
      await this._run(
        `UPDATE traders SET trades_won = trades_won + ?, reputation = reputation * 0.95 + ? * 0.05, last_active = CURRENT_TIMESTAMP WHERE id = ?`,
        [t.yes > 0 ? 1 : 0, accuracy, trader_id],
      );
    }
  }

  // ── Reconciliation & solvency audit (ADR-0041 PR 2c) ────────────────
  /**
   * Crash-recovery + pool-solvency audit for the ledger path. Idempotent and
   * safe to run repeatedly (once at boot + piggybacked on the resolver loop).
   * A no-op when the KAX surfaces aren't armed, so dev is unaffected. Runs the
   * three passes in order: escrow (open funded markets), trades (settle/refund
   * ambiguous debits) THEN the audit (so transient debits are resolved first).
   */
  async reconcile() {
    if (!kax.tradeEnabled() || !kax.readEnabled()) return { skipped: true };
    if (this._reconciling) return { skipped: 'in-flight' };
    this._reconciling = true;
    const report = { escrow: 0, trades: 0, audited: 0, alerts: 0 };
    try {
      await this._reconcilePendingEscrow(report);
      await this._reconcilePendingTrades(report);
      await this._auditOpenPools(report);
    } catch (e) {
      console.error('gshub reconcile error:', e.message);
    } finally {
      this._reconciling = false;
    }
    return report;
  }

  /** Open markets whose escrow actually landed; retry (idempotent) the absent ones. */
  async _reconcilePendingEscrow(report) {
    const rows = await this._all(`SELECT id, subsidy_minor FROM markets WHERE ledger_backed = 1 AND state = 'pending_escrow'`);
    for (const row of rows) {
      const g = await kax.getTx(kax.txid.escrow(row.id));
      if (g.ok && g.result && g.result.found === true) { await this._setMarketState(row.id, 'open'); report.escrow++; continue; }
      if (g.ok && g.result && g.result.found === false) {
        // Definitively absent → retry the idempotent escrow.
        try {
          const r = await kax.escrow({ marketId: row.id, subsidyMinor: row.subsidy_minor, ref: `market:${row.id}` });
          if (r.ok) { await this._setMarketState(row.id, 'open'); report.escrow++; }
          else if (r.definitive) { await this._setMarketState(row.id, 'voided'); }
        } catch (_) { /* ambiguous send — leave for next cycle */ }
      }
      // getTx ambiguous → leave pending for next cycle.
    }
  }

  /**
   * Settle ambiguous / crashed trades using the ledger as the source of truth.
   * tx_id on the committed trade row lets us distinguish the four cases exactly:
   *   landed + committed  → mark posted (the state update was what crashed)
   *   absent + !committed → mark failed  (no money moved)
   *   landed + !committed → REFUND (reverse the debit via a same-cost 'sell')
   *   absent + committed  → impossible (we only commit after a 2xx) → alert
   */
  async _reconcilePendingTrades(report) {
    const rows = await this._all(
      `SELECT tx_id, market_id, trader_id, outcome_idx, cost_minor FROM pending_trades
        WHERE state IN ('posting', 'reconcile', 'refund')`,
    );
    for (const p of rows) {
      const g = await kax.getTx(p.tx_id);
      if (!(g.ok && g.result)) continue; // read ambiguous → next cycle
      const landed = g.result.found === true;
      const absent = g.result.found === false;
      const committed = !!(await this._get(`SELECT 1 AS x FROM trades WHERE tx_id = ? LIMIT 1`, [p.tx_id]));

      if (landed && committed) { await this._setPendingState(p.tx_id, 'posted'); report.trades++; continue; }
      if (absent && !committed) { await this._setPendingState(p.tx_id, 'failed'); report.trades++; continue; }
      if (landed && !committed) {
        // Reverse the orphaned debit: a 'sell' of the same cost moves amm→trader.
        const principal = kax.principalFor(p.trader_id);
        const r = await kax.trade({ txId: kax.txid.refund(p.tx_id), principal, marketId: p.market_id, amountMinor: p.cost_minor, side: 'sell', ref: `refund:${p.tx_id}` });
        if (r.ok) { await this._setPendingState(p.tx_id, 'refunded'); report.trades++; }
        else if (r.definitive) { console.error(`gshub refund rejected ${p.tx_id}: ${r.error}`); }
        continue;
      }
      if (absent && committed) { console.error(`gshub INCONSISTENCY ${p.tx_id}: shares committed but ledger has no debit`); report.alerts++; }
    }
  }

  /**
   * Solvency audit: each open ledger market's pool must hold AT LEAST what its
   * committed trades funded (subsidy + Σ committed cost_minor). Only UNDER-
   * funding is dangerous (can't cover payouts); an over-funded pool is a benign
   * in-flight / pending-refund transient, so we never false-alarm on it. On a
   * shortfall, halt trading (placeTrade requires state='open') and alert.
   */
  async _auditOpenPools(report) {
    const rows = await this._all(`SELECT id, subsidy_minor FROM markets WHERE ledger_backed = 1 AND state = 'open' AND resolved = 0`);
    for (const row of rows) {
      const b = await kax.balance(`amm:${row.id}`);
      if (!b.ok) continue; // read failed — skip rather than false-alarm
      report.audited++;
      const expected = await this._poolValueMinor(row.id, row.subsidy_minor);
      if (b.balance < expected) {
        console.error(`gshub POOL AUDIT SHORTFALL ${row.id}: ledger ${b.balance} < committed ${expected} — halting trading`);
        await this._setMarketState(row.id, 'halted');
        report.alerts++;
      }
    }
  }

  /**
   * Auto-resolve markets whose TTL expired. Winner is whichever outcome
   * had the higher final price. Called by the resolver loop.
   */
  async _resolveExpiredMarkets() {
    // Re-entrancy guard. The 10s resolver interval does NOT await the previous
    // run, so a slow sweep (many expired markets / payouts overrunning 10s)
    // would overlap the next tick — which re-SELECTs the same still
    // `resolved = 0` rows (resolveMarket is async, spanning event-loop turns)
    // and pays out every winning position a SECOND time, corrupting the ledger.
    // Skip if a sweep is already in flight.
    if (this._resolving) return;
    this._resolving = true;
    try {
      return await this._resolveExpiredMarketsInner();
    } finally {
      this._resolving = false;
    }
  }

  async _resolveExpiredMarketsInner() {
    return new Promise((resolve) => {
      // expires_at is stored as ISO-8601 from `new Date().toISOString()`
      // (e.g. "2026-05-22T14:00:00.000Z"). datetime('now') returns
      // "2026-05-22 15:00:00" (space, no millis, no Z). Lex comparison
      // between those two formats is wrong on the same day — at char 11
      // the space sorts before 'T', so a market that expired earlier
      // today compares as NOT less than `datetime('now')` and never
      // gets resolved (#43). Fix: pass an identically-formatted ISO
      // string from JS so the lex comparison is consistent.
      const nowIso = new Date().toISOString();
      // ADR-0041: oracle-authoritative (labs-tier) markets must NEVER be
      // price-resolved by TTL. Their outcome is decided by the Labs oracle's
      // measurement (observatory settlement -> /resolve with the oracle
      // token), not by whichever side traders — including sybils — pumped
      // the price to before expiry. Excluding them here closes the gap where
      // the Phase-0 HTTP-endpoint gate is bypassed by this internal loop. An
      // oracle market that outlives its TTL simply stays open until the
      // oracle resolves it (or is voided by an operator), which is correct:
      // no payout is better than a payout on the wrong, manufactured side.
      this.db.all(
        `SELECT * FROM markets
           WHERE resolved = 0 AND expires_at < ?
             AND tag != 'labs' AND (source IS NULL OR source != 'kannaka-labs')`,
        [nowIso],
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
