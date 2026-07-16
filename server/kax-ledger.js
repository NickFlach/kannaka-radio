'use strict';

/**
 * kax-ledger.js — client + economic math for the KAX double-entry credit
 * ledger (ADR-0041 Phase 2, funded-AMM PR 2).
 *
 * Labs-tier GhostSignals markets move REAL conserved credits on the KAX ledger
 * (Agent-Kax, Postgres) instead of unbacked local SQLite capital. This module
 * is (a) the integer economic math that keeps the funded AMM provably solvent
 * and (b) the thin HTTP client that posts server-built transactions to the
 * typed KAX endpoints (/api/ledger/grant|escrow|trade|payout, GET /tx/:txId).
 *
 * INERT UNTIL CONFIGURED. The mint / trade / read surfaces are each "enabled"
 * only when KAX_LEDGER_BASE and the corresponding token are set, so the hub
 * behaves EXACTLY as today until Nick arms the env in prod. Nothing here runs
 * on the non-labs / ambient TTL path — those keep SQLite capital untouched.
 *
 * Two adversarial-review blockers live here and are unit-tested without a
 * network (see test/kax-ledger.test.js):
 *   #10 rounding in the POOL's favor — costMinor = ceil, payoutMinor = floor —
 *       so amm = subsidy + Σceil(cost) − Σfloor(payout) ≥ 0; a split-buy can't
 *       drain the pool via accumulated sub-unit dust.
 *   #12 ambiguous ≠ failed — only a definitive 4xx means "not posted". A
 *       timeout / 5xx stays ambiguous (the tx MAY have committed) and the
 *       caller must reconcile via getTx before telling the trader anything.
 */

const crypto = require('crypto');

// Integer minor units per credit. 6 dp (like USDC) keeps small LMSR costs from
// being swamped by the ceil rounding, while staying well inside 2^53 for the
// float→int multiply: credits stay < ~10^6, so credits*MINOR < ~10^12 << 2^53.
const MINOR = 1_000_000;

/** Env-derived config, read fresh each call so tests / redeploys pick up changes. */
function cfg() {
  return {
    base: (process.env.KAX_LEDGER_BASE || '').replace(/\/+$/, ''),
    mintToken: process.env.KAX_LEDGER_MINT_TOKEN || '',
    tradeToken: process.env.KAX_LEDGER_TRADE_TOKEN || '',
    readToken: process.env.KAX_SERVICE_TOKEN || process.env.KAX_LEDGER_READ_TOKEN || '',
    asset: process.env.KAX_LEDGER_ASSET || 'play_credit',
    timeoutMs: Number(process.env.KAX_LEDGER_TIMEOUT_MS || 8000),
  };
}

function tradeEnabled() { const c = cfg(); return !!(c.base && c.tradeToken); }
function mintEnabled() { const c = cfg(); return !!(c.base && c.mintToken); }
function readEnabled() { const c = cfg(); return !!(c.base && c.readToken); }

// ── Economic math (pure, exported for tests) ─────────────────────────────

/** ceil(credits · MINOR) as a decimal integer STRING of minor units. */
function toMinorCeil(credits) {
  if (!Number.isFinite(credits) || credits < 0) throw new Error('credits must be a finite number >= 0');
  return String(Math.ceil(credits * MINOR));
}

/** floor(credits · MINOR) as a decimal integer STRING of minor units. */
function toMinorFloor(credits) {
  if (!Number.isFinite(credits) || credits < 0) throw new Error('credits must be a finite number >= 0');
  return String(Math.floor(credits * MINOR));
}

/**
 * The LMSR worst-case subsidy the pool must be funded with before it opens:
 * ceil(b · ln(n) · MINOR). This is the maximum the market maker can lose across
 * all outcomes, so escrowing it guarantees every payout is backed.
 */
function subsidyMinor(b, n) {
  if (!(b > 0) || !Number.isInteger(n) || n < 2) throw new Error('b>0 and integer n>=2 required');
  return toMinorCeil(b * Math.log(n));
}

/**
 * A trade's cost rounded UP into minor units (charge the trader the ceil), and
 * a rejection of dust trades that round to 0 — a free share is a mint. Returns a
 * decimal integer string; throws on cost that rounds to <= 0.
 */
function tradeCostMinor(costCredits) {
  if (!Number.isFinite(costCredits)) throw new Error('cost must be finite');
  const m = Math.ceil(costCredits * MINOR);
  if (!(m > 0)) throw new Error('trade cost rounds to <= 0 minor units (dust)');
  return String(m);
}

/** A winning position's payout rounded DOWN into minor units (floor toward the pool). */
function payoutMinor(shares) {
  return toMinorFloor(shares);
}

// ── Deterministic transaction ids (idempotency keys) ─────────────────────
// Same logical event → same txId → the KAX idempotency registry applies it at
// most once, so a retry after an ambiguous outcome is always safe.
const txid = {
  escrow: (m) => `escrow:${m}`,
  resolve: (m) => `resolve:${m}`,
  voidMarket: (m) => `void:${m}`,
  grantRegister: (p) => `grant:register:${p}`,
  trade: (uuid) => `trade:${uuid}`,
  refund: (orig) => `refund:${orig}`,
  sweep: (m) => `sweep:${m}`,
};

/** A fresh trade uuid to persist in the pending_trades journal BEFORE posting. */
function newTradeUuid() { return crypto.randomUUID(); }

// Ledger principal grammar mirror (KAX PRINCIPAL_RE). A labs trader_id is the
// KAX token subject (e.g. "kax:agent:<bot>"); the ledger account is
// `trader:<principal>`. Reject anything that wouldn't validate server-side so we
// fail locally with a clear error instead of a 400.
const PRINCIPAL_RE = /^[a-z0-9][a-z0-9:_.-]{2,127}$/i;
function principalFor(traderId) {
  if (typeof traderId !== 'string' || !PRINCIPAL_RE.test(traderId)) {
    throw new Error(`trader_id "${traderId}" is not a valid ledger principal`);
  }
  return traderId;
}

// ── HTTP core ────────────────────────────────────────────────────────────

/**
 * POST/GET JSON with a bounded timeout and the review's ambiguity contract:
 *   { ok:true,  definitive:true,  status, result }   — committed (2xx)
 *   { ok:false, definitive:true,  status, error }    — NOT posted (4xx: bad
 *       request / auth / 409 conflict / 429 cap); retrying the same body won't help
 *   { ok:false, definitive:false, status, error }    — AMBIGUOUS (5xx / timeout /
 *       network): the tx MAY have committed — reconcile via getTx, do not assume
 */
async function httpJson(method, pathname, token, body) {
  if (typeof fetch !== 'function') {
    return { ok: false, definitive: false, status: 0, error: 'global fetch unavailable (need Node >= 18)' };
  }
  const c = cfg();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  try {
    const res = await fetch(c.base + pathname, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    if (res.ok) return { ok: true, definitive: true, status: res.status, result: json };
    if (res.status >= 400 && res.status < 500) {
      return { ok: false, definitive: true, status: res.status, error: (json && json.error) || `http ${res.status}` };
    }
    return { ok: false, definitive: false, status: res.status, error: (json && json.error) || `http ${res.status}` };
  } catch (err) {
    // AbortError (timeout) and network failures are ambiguous, never "not posted".
    return { ok: false, definitive: false, status: 0, error: (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Typed transaction methods ────────────────────────────────────────────

/** Fund a market's AMM pool with its LMSR subsidy (house → amm). Mint surface. */
async function escrow({ marketId, subsidyMinor: sub, ref }) {
  if (!mintEnabled()) throw new Error('kax mint surface not configured');
  const c = cfg();
  return httpJson('POST', '/api/ledger/escrow', c.mintToken, {
    txId: txid.escrow(marketId), marketId, amount: String(sub), asset: c.asset, ref: ref || null,
  });
}

/** Grant play credits to a trader (house → trader). Mint surface. Idempotent on txId. */
async function grant({ principal, amountMinor, txId: id, ref }) {
  if (!mintEnabled()) throw new Error('kax mint surface not configured');
  const c = cfg();
  return httpJson('POST', '/api/ledger/grant', c.mintToken, {
    txId: id || txid.grantRegister(principal), principal, amount: String(amountMinor), asset: c.asset, ref: ref || null,
  });
}

/** Move a trade's cost between a trader and a pool (buy: trader→amm; sell: amm→trader). Trade surface. */
async function trade({ txId: id, principal, marketId, amountMinor, side, ref }) {
  if (!tradeEnabled()) throw new Error('kax trade surface not configured');
  const c = cfg();
  return httpJson('POST', '/api/ledger/trade', c.tradeToken, {
    txId: id, principal, marketId, amount: String(amountMinor), side: side === 'sell' ? 'sell' : 'buy', asset: c.asset, ref: ref || null,
  });
}

/** Pay all winners out of a pool + sweep residual to house, in ONE balanced tx. Trade surface. */
async function payout({ marketId, winners, residualMinor, ref }) {
  if (!tradeEnabled()) throw new Error('kax trade surface not configured');
  const c = cfg();
  return httpJson('POST', '/api/ledger/payout', c.tradeToken, {
    txId: txid.resolve(marketId),
    marketId,
    winners: (winners || []).map((w) => ({ principal: w.principal, amount: String(w.amountMinor) })),
    residual: String(residualMinor || '0'),
    asset: c.asset,
    ref: ref || null,
  });
}

/** Look up a committed tx by id for reconciliation of an ambiguous outcome. Read surface. */
async function getTx(txId) {
  if (!readEnabled()) throw new Error('kax read surface not configured');
  const c = cfg();
  return httpJson('GET', `/api/ledger/tx/${encodeURIComponent(txId)}`, c.readToken, null);
}

/**
 * Derived balance (minor units) of an account for the audit — the pool-solvency
 * check compares balance(amm:<m>) against subsidy + Σ cost_minor. Read surface.
 * On a 2xx returns { ok:true, balance: bigint }; otherwise passes the httpJson
 * result through (definitive/ambiguous) so a failed read never reads as zero.
 */
async function balance(account, asset) {
  if (!readEnabled()) throw new Error('kax read surface not configured');
  const c = cfg();
  const r = await httpJson('GET', `/api/ledger/balance?account=${encodeURIComponent(account)}&asset=${encodeURIComponent(asset || c.asset)}`, c.readToken, null);
  if (r.ok && r.result && typeof r.result.balance === 'string') {
    return { ok: true, definitive: true, status: r.status, balance: BigInt(r.result.balance) };
  }
  return r;
}

module.exports = {
  MINOR,
  cfg,
  tradeEnabled,
  mintEnabled,
  readEnabled,
  // math
  toMinorCeil,
  toMinorFloor,
  subsidyMinor,
  tradeCostMinor,
  payoutMinor,
  // ids
  txid,
  newTradeUuid,
  principalFor,
  // http
  httpJson,
  escrow,
  grant,
  trade,
  payout,
  getTx,
  balance,
};
