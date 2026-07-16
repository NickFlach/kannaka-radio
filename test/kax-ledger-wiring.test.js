'use strict';

// Integration test for the labs-tier LEDGER PATH in the GhostSignals hub
// (ADR-0041 Phase 2, funded-AMM PR 2b). Arms the KAX surfaces via env and
// stubs global.fetch with an in-memory fake ledger, then drives a full market
// lifecycle and asserts the money-flow invariants:
//   - escrow-before-open (pool funded, market state → 'open')
//   - trades post ceil-rounded cost to /ledger/trade and DON'T touch SQLite capital
//   - resolve pays winners in ONE batched /ledger/payout
//   - the fake ledger stays conserved (Σ postings == 0) and no account goes negative

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Arm the KAX surfaces BEFORE requiring the hub (cfg() reads env fresh anyway).
process.env.KAX_LEDGER_BASE = 'http://kax.test';
process.env.KAX_LEDGER_MINT_TOKEN = 'mint-tok';
process.env.KAX_LEDGER_TRADE_TOKEN = 'trade-tok';
process.env.KAX_SERVICE_TOKEN = 'read-tok';

const { GhostSignalsHub } = require('../server/ghostsignals-hub');

function tmpDbPath() {
  const dir = path.join(os.tmpdir(), 'gshub-wiring-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

// ── In-memory fake KAX ledger (double-entry, conserved, overdraft-guarded) ──
function makeFakeLedger() {
  const balances = new Map(); // account -> bigint
  const txs = new Map();      // txId -> { head, count }
  const calls = [];           // {path, body}
  const bal = (a) => balances.get(a) || 0n;

  function apply(txId, postings) {
    if (txs.has(txId)) return { replay: true, ...txs.get(txId) }; // idempotent
    // overdraft guard: non-house debits can't go negative
    for (const p of postings) {
      if (p.amount < 0n && p.account !== 'house' && bal(p.account) + p.amount < 0n) {
        const e = new Error('insufficient funds'); e.status = 409; throw e;
      }
    }
    const sum = postings.reduce((a, p) => a + p.amount, 0n);
    if (sum !== 0n) { const e = new Error('not balanced'); e.status = 400; throw e; }
    for (const p of postings) balances.set(p.account, bal(p.account) + p.amount);
    const rec = { head: 'h' + txs.size, count: postings.length };
    txs.set(txId, rec);
    return { replay: false, ...rec };
  }

  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ path: u.pathname, body });
    const S = (v) => BigInt(v);
    try {
      let postings = null;
      if (u.pathname === '/api/ledger/escrow') {
        postings = [{ account: 'house', amount: -S(body.amount) }, { account: `amm:${body.marketId}`, amount: S(body.amount) }];
      } else if (u.pathname === '/api/ledger/grant') {
        postings = [{ account: 'house', amount: -S(body.amount) }, { account: `trader:${body.principal}`, amount: S(body.amount) }];
      } else if (u.pathname === '/api/ledger/trade') {
        const amm = { account: `amm:${body.marketId}`, amount: S(body.amount) };
        const trader = { account: `trader:${body.principal}`, amount: -S(body.amount) };
        postings = body.side === 'sell' ? [{ ...amm, amount: -S(body.amount) }, { ...trader, amount: S(body.amount) }] : [trader, amm];
      } else if (u.pathname === '/api/ledger/payout') {
        const total = (body.winners || []).reduce((a, w) => a + S(w.amount), 0n) + S(body.residual || '0');
        postings = [{ account: `amm:${body.marketId}`, amount: -total }];
        for (const w of body.winners) postings.push({ account: `trader:${w.principal}`, amount: S(w.amount) });
        if (S(body.residual || '0') > 0n) postings.push({ account: 'house', amount: S(body.residual) });
      }
      if (postings) {
        const r = apply(body.txId, postings);
        return { ok: true, status: r.replay ? 200 : 201, json: async () => ({ ok: true, ...r, idempotentReplay: r.replay }) };
      }
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'no route' }) };
    } catch (e) {
      const status = e.status || 500;
      return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: false, error: e.message }) };
    }
  };

  return { balances, txs, calls, bal };
}

async function run() {
  const led = makeFakeLedger();
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
  await hub.init();

  // Seed the two labs traders with ledger credits (grant) so they can trade.
  const alice = 'kax:agent:alice';
  const bob = 'kax:agent:bob';
  await hub.registerTrader({ id: alice, display_name: 'Alice', kind: 'ai' });
  await hub.registerTrader({ id: bob, display_name: 'Bob', kind: 'ai' });
  await require('../server/kax-ledger').grant({ principal: alice, amountMinor: '100000000', txId: 'grant:register:' + alice });
  await require('../server/kax-ledger').grant({ principal: bob, amountMinor: '100000000', txId: 'grant:register:' + bob });

  // 1) Create a labs market → escrow-before-open.
  const m = await hub.createMarket({ question: 'ledger path?', outcomes: ['Yes', 'No'], ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs' });
  assert.strictEqual(m.state, 'open', 'market should be open after successful escrow');
  assert.strictEqual(m.ledger_backed, true, 'market should be ledger-backed');
  const escrowCall = led.calls.find((c) => c.path === '/api/ledger/escrow');
  assert.ok(escrowCall, 'escrow POST must have happened');
  assert.strictEqual(escrowCall.body.marketId, m.id, 'escrow funds THIS market');
  assert.ok(led.bal(`amm:${m.id}`) > 0n, 'pool funded with subsidy');
  console.log(`ok  escrow-before-open (pool = ${led.bal(`amm:${m.id}`)} minor units, market open)`);

  // 2) Trades post to the ledger, ceil-rounded, and DON'T touch SQLite capital.
  const capBefore = (await hub.getTrader(alice)).capital;
  const t = await hub.placeTrade({ market_id: m.id, trader_id: alice, outcome: 0, shares: 5 });
  const tradeCall = led.calls.find((c) => c.path === '/api/ledger/trade');
  assert.ok(tradeCall, 'trade POST must have happened');
  assert.strictEqual(tradeCall.body.principal, alice);
  assert.strictEqual(typeof tradeCall.body.amount, 'string', 'amount is a decimal string');
  assert.strictEqual(tradeCall.body.amount, String(Math.ceil(t.cost * 1e6)), 'cost charged is ceil(cost·MINOR)');
  const capAfter = (await hub.getTrader(alice)).capital;
  assert.strictEqual(capAfter, capBefore, 'SQLite capital untouched on the ledger path');
  assert.ok(led.bal(`trader:${alice}`) < 100000000n, 'ledger debited the trader');
  console.log(`ok  ledger trade (charged ${tradeCall.body.amount} minor, SQLite capital untouched)`);

  // A second trader takes the other side.
  await hub.placeTrade({ market_id: m.id, trader_id: bob, outcome: 1, shares: 3 });

  // 3) Resolve → ONE batched payout.
  const poolBefore = led.bal(`amm:${m.id}`);
  await hub.resolveMarket({ market_id: m.id, winning_outcome: 0, method: 'manual' });
  const payoutCalls = led.calls.filter((c) => c.path === '/api/ledger/payout');
  assert.strictEqual(payoutCalls.length, 1, 'exactly ONE batched payout');
  const p = payoutCalls[0];
  assert.ok(Array.isArray(p.body.winners) && p.body.winners.length >= 1, 'winners present');
  assert.ok(p.body.winners.some((w) => w.principal === alice), 'Alice (outcome 0) is a winner');
  assert.ok(!p.body.winners.some((w) => w.principal === bob), 'Bob (outcome 1) is not paid');
  console.log(`ok  batched payout (1 tx, ${p.body.winners.length} winner(s), residual ${p.body.residual})`);

  // 4) Conservation: every posting summed to zero, so Σ all balances == 0, and
  //    the pool never went negative.
  let total = 0n;
  for (const v of led.balances.values()) total += v;
  assert.strictEqual(total, 0n, 'ledger conserved (Σ balances == 0)');
  assert.ok(led.bal(`amm:${m.id}`) >= 0n, `pool solvent (${led.bal(`amm:${m.id}`)} >= 0)`);
  assert.ok(poolBefore >= 0n);
  console.log('ok  conservation (Σ balances == 0, pool never negative)');

  console.log('\nPASSED kax-ledger-wiring.test.js');
}

run().catch((e) => {
  console.error('\nFAILED kax-ledger-wiring.test.js:', e.stack || e.message);
  process.exitCode = 1;
});
