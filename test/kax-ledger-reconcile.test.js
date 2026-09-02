'use strict';

// Crash-recovery + audit tests for the ledger path (ADR-0041 Phase 2, PR 2c).
// Drives hub.reconcile() through its four exact cases against an in-memory fake
// KAX ledger that supports getTx + balance and can simulate an
// "applied-but-client-saw-5xx" ambiguous outcome.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.KAX_LEDGER_BASE = 'http://kax.test';
process.env.KAX_LEDGER_MINT_TOKEN = 'mint-tok';
process.env.KAX_LEDGER_TRADE_TOKEN = 'trade-tok';
process.env.KAX_SERVICE_TOKEN = 'read-tok';
// No grace window in the test so a just-journaled orphan is reconciled at once
// (in prod the grace period protects live in-flight trades from false refunds).
process.env.KAX_RECONCILE_GRACE_MS = '0';

// Skip locally without sqlite3, FAIL under CI (#277): see test/lib/sqlite3-guard.js.
require('./lib/sqlite3-guard')('kax-ledger-reconcile');
const { GhostSignalsHub } = require('../server/ghostsignals-hub');
const kax = require('../server/kax-ledger');

function tmpDbPath() {
  const dir = path.join(os.tmpdir(), 'gshub-recon-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

function makeFakeLedger() {
  const balances = new Map();
  const txs = new Map();
  const led = { mode: 'normal', balances, txs };
  const bal = (a) => balances.get(a) || 0n;
  led.bal = bal;
  led.drain = (a, amt) => balances.set(a, bal(a) - BigInt(amt));

  function apply(txId, postings) {
    if (txs.has(txId)) return { replay: true, ...txs.get(txId) };
    for (const p of postings) {
      if (p.amount < 0n && p.account !== 'house' && bal(p.account) + p.amount < 0n) { const e = new Error('insufficient'); e.status = 409; throw e; }
    }
    if (postings.reduce((a, p) => a + p.amount, 0n) !== 0n) { const e = new Error('unbalanced'); e.status = 400; throw e; }
    for (const p of postings) balances.set(p.account, bal(p.account) + p.amount);
    const rec = { head: 'h' + txs.size, count: postings.length };
    txs.set(txId, rec);
    return { replay: false, ...rec };
  }

  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const S = (v) => BigInt(v);
    // GET reads
    if ((opts.method || 'GET') === 'GET') {
      if (u.pathname.startsWith('/api/ledger/tx/')) {
        const txId = decodeURIComponent(u.pathname.slice('/api/ledger/tx/'.length));
        const rec = txs.get(txId);
        return { ok: true, status: 200, json: async () => (rec ? { found: true, txId, ...rec } : { found: false, txId }) };
      }
      if (u.pathname === '/api/ledger/balance') {
        const acct = u.searchParams.get('account');
        return { ok: true, status: 200, json: async () => ({ account: acct, asset: 'play_credit', balance: bal(acct).toString() }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'no route' }) };
    }
    // POST writes
    const body = JSON.parse(opts.body);
    // Optional gate: block a trade POST mid-flight (to test the reconcile race).
    if (u.pathname === '/api/ledger/trade' && led.tradeGate) await led.tradeGate;
    let postings = null;
    if (u.pathname === '/api/ledger/escrow') postings = [{ account: 'house', amount: -S(body.amount) }, { account: `amm:${body.marketId}`, amount: S(body.amount) }];
    else if (u.pathname === '/api/ledger/grant') postings = [{ account: 'house', amount: -S(body.amount) }, { account: `trader:${body.principal}`, amount: S(body.amount) }];
    else if (u.pathname === '/api/ledger/trade') {
      postings = body.side === 'sell'
        ? [{ account: `amm:${body.marketId}`, amount: -S(body.amount) }, { account: `trader:${body.principal}`, amount: S(body.amount) }]
        : [{ account: `trader:${body.principal}`, amount: -S(body.amount) }, { account: `amm:${body.marketId}`, amount: S(body.amount) }];
    } else if (u.pathname === '/api/ledger/payout') {
      const total = (body.winners || []).reduce((a, w) => a + S(w.amount), 0n) + S(body.residual || '0');
      postings = [{ account: `amm:${body.marketId}`, amount: -total }];
      for (const w of (body.winners || [])) postings.push({ account: `trader:${w.principal}`, amount: S(w.amount) });
      if (S(body.residual || '0') > 0n) postings.push({ account: 'house', amount: S(body.residual) });
    }
    try {
      const r = apply(body.txId, postings);
      if (led.mode === 'applyThenFail') return { ok: false, status: 500, json: async () => ({ ok: false, error: 'simulated 5xx after apply' }) };
      return { ok: true, status: r.replay ? 200 : 201, json: async () => ({ ok: true, ...r, idempotentReplay: r.replay }) };
    } catch (e) {
      return { ok: false, status: e.status || 500, json: async () => ({ ok: false, error: e.message }) };
    }
  };
  return led;
}

async function run() {
  const led = makeFakeLedger();
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
  await hub.init();
  const alice = 'kax:agent:alice';
  await hub.registerTrader({ id: alice, display_name: 'Alice', kind: 'ai' });
  await kax.grant({ principal: alice, amountMinor: '100000000', txId: 'grant:register:' + alice });

  // ── A) Escrow reconcile: escrow lands but client sees 5xx → market stuck
  //       pending_escrow → reconcile() finds the debit and opens it. ──────────
  led.mode = 'applyThenFail';
  let stuckId;
  try {
    await hub.createMarket({ question: 'stuck escrow', outcomes: ['Y', 'N'], tag: 'labs', source: 'kannaka-labs' });
    assert.fail('createMarket should throw on ambiguous escrow');
  } catch (e) { assert.ok(/ambiguous/.test(e.message), 'ambiguous escrow surfaced'); }
  stuckId = (await hub._all(`SELECT id FROM markets WHERE state = 'pending_escrow'`))[0].id;
  assert.ok(led.bal(`amm:${stuckId}`) > 0n, 'escrow actually landed on the ledger');
  led.mode = 'normal';
  const repA = await hub.reconcile();
  assert.strictEqual((await hub.getMarket(stuckId)).state, 'open', 'reconcile opened the funded market');
  assert.ok(repA.escrow >= 1, 'escrow pass acted');
  console.log('ok  escrow reconcile (ambiguous→landed→opened)');

  // ── B) Orphaned-debit refund: a debit landed but shares never committed →
  //       reconcile() refunds it (amm→trader) and marks 'refunded'. ──────────
  const orphanTx = kax.txid.trade('orphan-uuid');
  const traderBalBefore = led.bal(`trader:${alice}`);
  await kax.trade({ txId: orphanTx, principal: alice, marketId: stuckId, amountMinor: '250000', side: 'buy' }); // debit lands
  await hub._journalPending({ txId: orphanTx, market_id: stuckId, trader_id: alice, outcome: 0, shares: 1, costMinor: '250000', shareTicks: 1000000, qBeforeJson: '[0,0]', state: 'posting' });
  // no trades row committed for orphanTx → landed && !committed
  const repB = await hub.reconcile();
  const pend = await hub._get(`SELECT state FROM pending_trades WHERE tx_id = ?`, [orphanTx]);
  assert.strictEqual(pend.state, 'refunded', 'orphaned debit was refunded');
  assert.strictEqual(led.bal(`trader:${alice}`), traderBalBefore, 'trader made whole by the refund');
  console.log('ok  orphaned-debit refund (landed & !committed → reversed)');

  // ── C) Never-posted trade: pending row whose debit is absent → 'failed'. ──
  const ghostTx = kax.txid.trade('ghost-uuid');
  await hub._journalPending({ txId: ghostTx, market_id: stuckId, trader_id: alice, outcome: 0, shares: 1, costMinor: '250000', shareTicks: 1000000, qBeforeJson: '[0,0]', state: 'reconcile' });
  await hub.reconcile();
  const ghost = await hub._get(`SELECT state FROM pending_trades WHERE tx_id = ?`, [ghostTx]);
  assert.strictEqual(ghost.state, 'failed', 'never-posted trade marked failed (no money moved)');
  console.log('ok  never-posted trade → failed');

  // ── D) Pool audit shortfall: drain the pool below its committed backing →
  //       audit halts trading on that market. ────────────────────────────────
  led.drain(`amm:${stuckId}`, '999999999'); // force ledger balance < expected
  const repD = await hub.reconcile();
  assert.strictEqual((await hub.getMarket(stuckId)).state, 'halted', 'shortfall halted the market');
  assert.ok(repD.alerts >= 1, 'audit raised an alert');
  // A halted market rejects new trades.
  await assert.rejects(() => hub.placeTrade({ market_id: stuckId, trader_id: alice, outcome: 0, shares: 1 }), /not open/);
  console.log('ok  pool audit shortfall → halted + trading blocked');

  // ── E) BLOCKER-1 regression: reconcile must NOT refund a LIVE in-flight trade.
  //       Hold a trade's ledger POST open, fire reconcile() concurrently, then
  //       release — the trade must complete and never be refunded. ────────────
  const led2 = makeFakeLedger();
  const hub2 = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
  await hub2.init();
  const carol = 'kax:agent:carol';
  await hub2.registerTrader({ id: carol, display_name: 'Carol', kind: 'ai' });
  await kax.grant({ principal: carol, amountMinor: '100000000', txId: 'grant:register:' + carol });
  const mk = await hub2.createMarket({ question: 'race', outcomes: ['Y', 'N'], tag: 'labs', source: 'kannaka-labs' });
  let releaseGate;
  led2.tradeGate = new Promise((res) => { releaseGate = res; });
  const tradeP = hub2.placeTrade({ market_id: mk.id, trader_id: carol, outcome: 0, shares: 3 }); // holds mutex on the gated POST
  await new Promise((r) => setTimeout(r, 20)); // let it reach the gated POST
  const reconcileP = hub2.reconcile();          // queues behind the market mutex
  await new Promise((r) => setTimeout(r, 20));
  releaseGate();                                // let the trade finish
  await Promise.all([tradeP, reconcileP]);
  const pk = await hub2._get(`SELECT state FROM pending_trades WHERE market_id = ?`, [mk.id]);
  assert.strictEqual(pk.state, 'posted', 'in-flight trade committed, not refunded');
  const refundLanded = (await kax.getTx(kax.txid.refund((await hub2._get(`SELECT tx_id FROM pending_trades WHERE market_id = ?`, [mk.id])).tx_id)));
  assert.ok(refundLanded.ok && refundLanded.result.found === false, 'no refund was posted for the live trade');
  console.log('ok  reconcile does NOT refund a live in-flight trade (blocker-1)');

  // ── F) BLOCKER-2 regression: a payout that the client saw fail is re-driven
  //       by reconcile until settled (funds not stranded). ─────────────────────
  await hub2.placeTrade({ market_id: mk.id, trader_id: carol, outcome: 1, shares: 2 });
  led2.mode = 'applyThenFail'; // payout lands on the ledger but client sees 5xx
  await hub2.resolveMarket({ market_id: mk.id, winning_outcome: 0, method: 'manual' });
  assert.strictEqual((await hub2.getMarket(mk.id)).state, 'resolving', 'failed payout leaves market resolving');
  led2.mode = 'normal';
  const repF = await hub2.reconcile();
  assert.strictEqual((await hub2.getMarket(mk.id)).state, 'settled', 'reconcile settled the resolving market');
  assert.ok(repF.resolves >= 1, 'payout reconcile pass acted');
  console.log('ok  failed payout re-driven to settled (blocker-2)');

  console.log('\nPASSED kax-ledger-reconcile.test.js');
}

run().catch((e) => { console.error('\nFAILED kax-ledger-reconcile.test.js:', e.stack || e.message); process.exitCode = 1; });
