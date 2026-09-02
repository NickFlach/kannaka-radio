'use strict';

// ghostsignals-ledger-hardening.test.js — the labs-tier LEDGER path attacked
// as a market engine, against the in-memory fake KAX ledger (same harness as
// kax-ledger-reconcile.test.js). Each block failed on the pre-hardening hub:
//
//   A. config drift: a market created ledger-backed must NOT degrade into a
//      play-capital market when the KAX env is later unset — trades and
//      resolution are refused loudly instead of moving SQLite capital while
//      the real pool sits escrowed on KAX.
//   B. idempotency_key on the ledger path: a retried trade is applied once
//      (one /ledger/trade POST), and a retry whose first attempt is still
//      pending reconciliation is refused rather than debited twice.
//   C. a market whose escrow never landed (pending_escrow) cannot be resolved
//      — there is no funded pool to pay from.
//   D. conservation property over a random trade/resolve sequence on the
//      fake ledger: Σ all postings == 0, no trader negative, every settled
//      pool drained to exactly 0, winners paid exactly their share_ticks.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
require('./lib/sqlite3-guard')('ghostsignals-ledger-hardening');

process.env.KAX_LEDGER_BASE = 'http://kax.test';
process.env.KAX_LEDGER_MINT_TOKEN = 'mint-tok';
process.env.KAX_LEDGER_TRADE_TOKEN = 'trade-tok';
process.env.KAX_SERVICE_TOKEN = 'read-tok';
process.env.KAX_RECONCILE_GRACE_MS = '0';

const { GhostSignalsHub } = require('../server/ghostsignals-hub');
const kax = require('../server/kax-ledger');

function tmpDbPath(tag) {
  const dir = path.join(os.tmpdir(), `gshub-ledger-hard-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

function makeFakeLedger() {
  const balances = new Map();
  const txs = new Map();
  const calls = [];
  const led = { mode: 'normal', balances, txs, calls };
  const bal = (a) => balances.get(a) || 0n;
  led.bal = bal;
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
    const body = JSON.parse(opts.body);
    calls.push({ path: u.pathname, body });
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
      if (led.mode === 'failBeforeApply') throw Object.assign(new Error('simulated 503'), { status: 503 });
      const r = apply(body.txId, postings);
      if (led.mode === 'applyThenFail') return { ok: false, status: 500, json: async () => ({ ok: false, error: 'simulated 5xx after apply' }) };
      return { ok: true, status: r.replay ? 200 : 201, json: async () => ({ ok: true, ...r, idempotentReplay: r.replay }) };
    } catch (e) {
      return { ok: false, status: e.status || 500, json: async () => ({ ok: false, error: e.message }) };
    }
  };
  return led;
}

let seed = 0xbeef;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; }
const posts = (led, p) => led.calls.filter((c) => c.path === p).length;

let failed = 0;
async function run(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}

async function armedHub(tag) {
  const led = makeFakeLedger();
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(tag), defaultLiquidity: 10, startingCapital: 100 });
  await hub.init();
  return { led, hub };
}
async function fundTrader(hub, id, minor = '100000000') {
  await hub.registerTrader({ id, display_name: id, kind: 'agent' });
  await kax.grant({ principal: id, amountMinor: minor, txId: 'grant:register:' + id });
}

async function main() {
  console.log('ghostsignals-ledger-hardening.test.js');

  // ── A. config drift ──────────────────────────────────────────────────
  await run('A  a ledger-backed market refuses to trade / settle as play capital when KAX is disarmed', async () => {
    const { led, hub } = await armedHub('a');
    const alice = 'kax:agent:alice';
    await fundTrader(hub, alice);
    const m = await hub.createMarket({ question: 'drift', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs' });
    assert.strictEqual(m.ledger_backed, true);
    await hub.placeTrade({ market_id: m.id, trader_id: alice, outcome: 0, shares: 3 });
    const capBefore = (await hub.getTrader(alice)).capital;
    const tradesBefore = (await hub._all('SELECT COUNT(*) AS c FROM trades'))[0].c;
    const saved = process.env.KAX_LEDGER_TRADE_TOKEN;
    delete process.env.KAX_LEDGER_TRADE_TOKEN;           // disarm the trade surface
    try {
      await assert.rejects(() => hub.placeTrade({ market_id: m.id, trader_id: alice, outcome: 0, shares: 3 }), /ledger-backed.*not configured/);
      assert.strictEqual((await hub.getTrader(alice)).capital, capBefore, 'SQLite play capital was debited for a real-pool market');
      assert.strictEqual((await hub._all('SELECT COUNT(*) AS c FROM trades'))[0].c, tradesBefore, 'a trade row was written without a ledger debit');
      await assert.rejects(() => hub.resolveMarket({ market_id: m.id, winning_outcome: 0, method: 'manual' }), /ledger-backed.*not configured/);
      assert.strictEqual((await hub.getMarket(m.id)).resolved, false, 'market was settled out of play capital');
      assert.strictEqual((await hub.getTrader(alice)).capital, capBefore);
    } finally {
      process.env.KAX_LEDGER_TRADE_TOKEN = saved;
    }
    // Re-armed: the same calls go through on the ledger.
    await hub.placeTrade({ market_id: m.id, trader_id: alice, outcome: 0, shares: 3 });
    assert.strictEqual(posts(led, '/api/ledger/trade'), 2);
    await hub.resolveMarket({ market_id: m.id, winning_outcome: 0, method: 'manual' });
    assert.strictEqual((await hub.getMarket(m.id)).state, 'settled');
  });

  // ── B. idempotency on the ledger path ───────────────────────────────
  await run('B1 a retried ledger trade with the same idempotency_key posts ONE debit and replays the result', async () => {
    const { led, hub } = await armedHub('b1');
    const bob = 'kax:agent:bob';
    await fundTrader(hub, bob);
    const m = await hub.createMarket({ question: 'idem', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs' });
    const a = await hub.placeTrade({ market_id: m.id, trader_id: bob, outcome: 1, shares: 4, idempotency_key: 'k-1' });
    const balAfterFirst = led.bal(`trader:${bob}`);
    const b = await hub.placeTrade({ market_id: m.id, trader_id: bob, outcome: 1, shares: 4, idempotency_key: 'k-1' });
    assert.strictEqual(b.replay, true);
    assert.strictEqual(b.cost_minor, a.cost_minor);
    assert.strictEqual(posts(led, '/api/ledger/trade'), 1, 'second submit posted a second debit');
    assert.strictEqual(led.bal(`trader:${bob}`), balAfterFirst, 'trader debited twice');
    assert.strictEqual((await hub.getMarket(m.id)).q[1], 4, 'q moved twice');
    // Concurrent double-submit under the per-market mutex: still one debit.
    const pair = await Promise.allSettled([
      hub.placeTrade({ market_id: m.id, trader_id: bob, outcome: 0, shares: 2, idempotency_key: 'k-2' }),
      hub.placeTrade({ market_id: m.id, trader_id: bob, outcome: 0, shares: 2, idempotency_key: 'k-2' }),
    ]);
    assert.ok(pair.every((r) => r.status === 'fulfilled'), `concurrent replay rejected: ${pair.map((r) => r.reason && r.reason.message)}`);
    assert.strictEqual(posts(led, '/api/ledger/trade'), 2);
  });

  await run('B2 a retry whose first attempt is still pending reconciliation is refused, not debited again', async () => {
    const { led, hub } = await armedHub('b2');
    const carol = 'kax:agent:carol';
    await fundTrader(hub, carol);
    const m = await hub.createMarket({ question: 'pending', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs' });
    led.mode = 'applyThenFail';                            // debit lands, client sees 5xx → 'reconcile'
    await assert.rejects(() => hub.placeTrade({ market_id: m.id, trader_id: carol, outcome: 0, shares: 2, idempotency_key: 'k-p' }), /ambiguous/);
    led.mode = 'normal';
    const balAfter = led.bal(`trader:${carol}`);
    await assert.rejects(() => hub.placeTrade({ market_id: m.id, trader_id: carol, outcome: 0, shares: 2, idempotency_key: 'k-p' }), /pending reconciliation/);
    assert.strictEqual(led.bal(`trader:${carol}`), balAfter, 'retry debited the trader a second time');
    assert.strictEqual(posts(led, '/api/ledger/trade'), 1);
    // Reconcile settles the orphan (landed & !committed → refund); then the key is free again.
    await hub.reconcile();
    const pend = await hub._get(`SELECT state FROM pending_trades WHERE idempotency_key = ?`, ['k-p']);
    assert.strictEqual(pend.state, 'refunded');
    const r = await hub.placeTrade({ market_id: m.id, trader_id: carol, outcome: 0, shares: 2, idempotency_key: 'k-p' });
    assert.notStrictEqual(r.replay, true);
  });

  // ── C. unfunded pool ────────────────────────────────────────────────
  await run('C  a pending_escrow market (escrow never landed) cannot be resolved', async () => {
    const { led, hub } = await armedHub('c');
    led.mode = 'failBeforeApply';                          // escrow POST 503s, nothing applied
    await assert.rejects(() => hub.createMarket({ question: 'unfunded', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs' }), /ambiguous/);
    led.mode = 'normal';
    const row = (await hub._all(`SELECT id, state FROM markets`))[0];
    assert.strictEqual(row.state, 'pending_escrow');
    assert.strictEqual(led.bal(`amm:${row.id}`), 0n, 'pool is empty');
    await assert.rejects(() => hub.resolveMarket({ market_id: row.id, winning_outcome: 0, method: 'manual' }), /not settleable|pending_escrow/);
    const after = await hub.getMarket(row.id);
    assert.strictEqual(after.resolved, false, 'unfunded market was flipped to resolved');
    assert.strictEqual(after.state, 'pending_escrow');
    assert.strictEqual(posts(led, '/api/ledger/payout'), 0, 'a payout was posted from an empty pool');
  });

  // ── D. conservation property ────────────────────────────────────────
  await run('D  random ledger trade/resolve sequence: Σ postings = 0, no trader negative, pools drain to 0, winners paid share_ticks', async () => {
    const { led, hub } = await armedHub('d');
    const traders = ['kax:agent:d1', 'kax:agent:d2', 'kax:agent:d3'];
    for (const t of traders) await fundTrader(hub, t, '50000000'); // 50 credits each
    const markets = [];
    for (let i = 0; i < 3; i++) {
      markets.push(await hub.createMarket({ question: `prop ${i}`, ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs', outcomes: i === 1 ? ['A', 'B', 'C'] : ['Yes', 'No'], liquidity: 5 + i * 5 }));
    }
    const conserved = () => [...led.balances.values()].reduce((a, b) => a + b, 0n);
    let accepted = 0;
    for (let i = 0; i < 60; i++) {
      const m = markets[Math.floor(rnd() * markets.length)];
      const t = traders[Math.floor(rnd() * traders.length)];
      const outcome = Math.floor(rnd() * m.outcomes.length);
      const shares = Math.round((rnd() * 12 + 0.25) * 100) / 100;
      try { await hub.placeTrade({ market_id: m.id, trader_id: t, outcome, shares }); accepted++; }
      catch (e) { assert.ok(/rejected \(409\)/.test(e.message), `unexpected rejection: ${e.message}`); }
      assert.strictEqual(conserved(), 0n, 'ledger not conserved mid-sequence');
      for (const x of traders) assert.ok(led.bal(`trader:${x}`) >= 0n, `${x} negative`);
    }
    assert.ok(accepted >= 20, `too few trades accepted (${accepted})`);
    for (const m of markets) {
      // Pool must hold exactly subsidy + Σ cost_minor before settlement.
      const expected = await hub._poolValueMinor(m.id, m.subsidy_minor);
      assert.strictEqual(led.bal(`amm:${m.id}`), expected, `pool ${m.id} != subsidy + Σcost_minor`);
      const win = Math.floor(rnd() * m.outcomes.length);
      const ticks = await hub._all(`SELECT trader_id, SUM(share_ticks) AS t FROM trades WHERE market_id = ? AND outcome_idx = ? GROUP BY trader_id`, [m.id, win]);
      const before = new Map(traders.map((x) => [x, led.bal(`trader:${x}`)]));
      const houseBefore = led.bal('house');
      await hub.resolveMarket({ market_id: m.id, winning_outcome: win, method: 'manual' });
      assert.strictEqual((await hub.getMarket(m.id)).state, 'settled');
      assert.strictEqual(led.bal(`amm:${m.id}`), 0n, `pool ${m.id} not drained after settlement`);
      let paid = 0n;
      for (const x of traders) {
        const won = ticks.find((r) => r.trader_id === x);
        const delta = led.bal(`trader:${x}`) - before.get(x);
        assert.strictEqual(delta, BigInt(won ? won.t : 0), `${x} paid ${delta}, holds ${won ? won.t : 0} winning ticks`);
        paid += delta;
      }
      assert.strictEqual(led.bal('house') - houseBefore, expected - paid, 'residual (dust + losers) did not all reach house');
      assert.ok(expected - paid >= 0n, 'pool paid out more than it held');
      assert.strictEqual(conserved(), 0n);
    }
    // Trading a settled market is refused, and a second resolve pays nothing.
    await assert.rejects(() => hub.placeTrade({ market_id: markets[0].id, trader_id: traders[0], outcome: 0, shares: 1 }), /already resolved/);
    const payoutsBefore = posts(led, '/api/ledger/payout');
    await assert.rejects(() => hub.resolveMarket({ market_id: markets[0].id, winning_outcome: 0, method: 'manual' }), /already resolved/);
    assert.strictEqual(posts(led, '/api/ledger/payout'), payoutsBefore);
  });

  if (failed) { console.error(`\n${failed} ledger-hardening test(s) FAILED`); process.exitCode = 1; }
  else console.log('\nAll ghostsignals-ledger-hardening tests passed');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
