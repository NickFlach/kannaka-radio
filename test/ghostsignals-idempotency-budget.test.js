'use strict';

// ADR-0041 hardening (adversarial review 2026-08-12):
//   #10 hub market creation is idempotent per predictionId — a retry after an
//       ambiguous observatory-side timeout returns the SAME market and does NOT
//       escrow a second subsidy or strand an orphan.
//   #9  a hub-side rolling escrow BUDGET bounds the mint rate (the `house`
//       account is a mint and cannot be "floored"; the rate is what matters).
// Arms the KAX surfaces via env + the in-memory fake ledger, same harness as
// kax-ledger-wiring.test.js.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.KAX_LEDGER_BASE = 'http://kax.test';
process.env.KAX_LEDGER_MINT_TOKEN = 'mint-tok';
process.env.KAX_LEDGER_TRADE_TOKEN = 'trade-tok';
process.env.KAX_SERVICE_TOKEN = 'read-tok';

// Skip locally without sqlite3, FAIL under CI (#277): see test/lib/sqlite3-guard.js.
require('./lib/sqlite3-guard')('ghostsignals-idempotency-budget');
const { GhostSignalsHub } = require('../server/ghostsignals-hub');

function tmpDbPath() {
  const dir = path.join(os.tmpdir(), 'gshub-idem-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

// Minimal fake KAX ledger — records escrow calls; conserved + house-exempt.
function makeFakeLedger() {
  const balances = new Map();
  const txs = new Map();
  const calls = [];
  const bal = (a) => balances.get(a) || 0n;
  function apply(txId, postings) {
    if (txs.has(txId)) return { replay: true };
    for (const p of postings) balances.set(p.account, bal(p.account) + p.amount);
    txs.set(txId, { count: postings.length });
    return { replay: false };
  }
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ path: u.pathname, body });
    const S = (v) => BigInt(v);
    if (u.pathname === '/api/ledger/escrow') {
      const r = apply(body.txId, [{ account: 'house', amount: -S(body.amount) }, { account: `amm:${body.marketId}`, amount: S(body.amount) }]);
      return { ok: true, status: r.replay ? 200 : 201, json: async () => ({ ok: true, idempotentReplay: r.replay }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'no route' }) };
  };
  return { balances, txs, calls, bal };
}

async function run() {
  const led = makeFakeLedger();
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
  await hub.init();

  // ── #10 Idempotency ──────────────────────────────────────────────────
  const meta = { proposedBy: 'obc:some-bot', predictionId: 'pred-idem-1' };
  const m1 = await hub.createMarket({ question: 'idempotent?', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs', metadata: meta });
  assert.strictEqual(m1.state, 'open', 'first create opens after escrow');
  const escrowsAfterFirst = led.calls.filter((c) => c.path === '/api/ledger/escrow').length;
  assert.strictEqual(escrowsAfterFirst, 1, 'exactly one escrow on first create');
  const houseAfterFirst = led.bal('house');

  // Retry with the SAME predictionId (simulates the observatory re-driving after
  // an ambiguous timeout, or an overlapping sweep re-filing the same DM).
  const m2 = await hub.createMarket({ question: 'idempotent?', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs', metadata: meta });
  assert.strictEqual(m2.id, m1.id, 'retry returns the SAME market id (deterministic on predictionId)');
  const escrowsAfterRetry = led.calls.filter((c) => c.path === '/api/ledger/escrow').length;
  assert.strictEqual(escrowsAfterRetry, 1, 'retry does NOT escrow a second subsidy');
  assert.strictEqual(led.bal('house'), houseAfterFirst, 'house debited only once — no double-funding');
  // Exactly one market row exists for this prediction.
  const rows = await new Promise((res, rej) => hub.db.all('SELECT id FROM markets', [], (e, r) => e ? rej(e) : res(r)));
  assert.strictEqual(rows.length, 1, 'only one market row for the prediction (no orphan)');
  console.log('ok  #10 idempotent create: retry returns same market, no second escrow, no orphan');

  // A DIFFERENT prediction still gets its own market + escrow.
  await hub.createMarket({ question: 'other', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs', metadata: { predictionId: 'pred-idem-2' } });
  assert.strictEqual(led.calls.filter((c) => c.path === '/api/ledger/escrow').length, 2, 'distinct prediction escrows separately');
  console.log('ok  distinct predictions still escrow independently');

  // ── #9 Escrow budget backstop ────────────────────────────────────────
  // Two labs markets already escrowed ~2×6.93 credits ≈ 13.86 credits. Set a
  // budget BELOW the next market's marginal subsidy so the next create is refused.
  process.env.GSHUB_ESCROW_BUDGET_MINOR = '14000000'; // 14 credits; window default 24h
  await assert.rejects(
    () => hub.createMarket({ question: 'over budget', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs', metadata: { predictionId: 'pred-idem-3' } }),
    /escrow budget/,
    'a create that would exceed the rolling escrow budget is refused',
  );
  assert.strictEqual(led.calls.filter((c) => c.path === '/api/ledger/escrow').length, 2, 'refused create did NOT escrow');
  console.log('ok  #9 escrow budget refuses an over-budget create before minting');

  // A window that has already elapsed forgets past spend → create allowed again.
  process.env.GSHUB_ESCROW_WINDOW_MS = '1';
  await new Promise((r) => setTimeout(r, 5));
  const mAfter = await hub.createMarket({ question: 'fresh window', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs', metadata: { predictionId: 'pred-idem-4' } });
  assert.strictEqual(mAfter.state, 'open', 'past-window spend no longer counts against budget');
  console.log('ok  budget window is rolling (elapsed spend no longer counts)');

  delete process.env.GSHUB_ESCROW_BUDGET_MINOR;
  delete process.env.GSHUB_ESCROW_WINDOW_MS;
  console.log('\nPASSED ghostsignals-idempotency-budget.test.js');
}

run().catch((e) => { console.error('\nFAILED ghostsignals-idempotency-budget.test.js:', e.stack || e.message); process.exitCode = 1; });
