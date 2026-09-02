'use strict';

// ADR-0041 proposer incentive: a residual-based fee rewards a proposer (who
// can't trade their own market) for a well-attended question. The fee is carved
// from the HOUSE RESIDUAL inside the same balanced payout, so the ledger stays
// conserved (Σ postings == 0) and no pool goes negative — solvency is untouched.
// Gated on distinct participation; off by default. Uses the fake-ledger harness.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.KAX_LEDGER_BASE = 'http://kax.test';
process.env.KAX_LEDGER_MINT_TOKEN = 'mint-tok';
process.env.KAX_LEDGER_TRADE_TOKEN = 'trade-tok';
process.env.KAX_SERVICE_TOKEN = 'read-tok';
process.env.PROPOSER_FEE_BPS = '200';        // 2%
process.env.PROPOSER_FEE_MIN_TRADERS = '3';

// Skip locally without sqlite3, FAIL under CI (#277): see test/lib/sqlite3-guard.js.
require('./lib/sqlite3-guard')('proposer-fee');
const { GhostSignalsHub } = require('../server/ghostsignals-hub');

function tmpDbPath() {
  const dir = path.join(os.tmpdir(), 'gshub-fee-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

function makeFakeLedger() {
  const balances = new Map();
  const txs = new Map();
  const calls = [];
  const bal = (a) => balances.get(a) || 0n;
  function apply(txId, postings) {
    if (txs.has(txId)) return { replay: true };
    for (const p of postings) {
      if (p.amount < 0n && p.account !== 'house' && bal(p.account) + p.amount < 0n) { const e = new Error('insufficient funds'); e.status = 409; throw e; }
    }
    const sum = postings.reduce((a, p) => a + p.amount, 0n);
    if (sum !== 0n) { const e = new Error('not balanced'); e.status = 400; throw e; }
    for (const p of postings) balances.set(p.account, bal(p.account) + p.amount);
    txs.set(txId, 1);
    return { replay: false };
  }
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ path: u.pathname, body });
    const S = (v) => BigInt(v);
    try {
      let postings = null;
      if (u.pathname === '/api/ledger/escrow') postings = [{ account: 'house', amount: -S(body.amount) }, { account: `amm:${body.marketId}`, amount: S(body.amount) }];
      else if (u.pathname === '/api/ledger/grant') postings = [{ account: 'house', amount: -S(body.amount) }, { account: `trader:${body.principal}`, amount: S(body.amount) }];
      else if (u.pathname === '/api/ledger/trade') { const amm = { account: `amm:${body.marketId}`, amount: S(body.amount) }; const trader = { account: `trader:${body.principal}`, amount: -S(body.amount) }; postings = body.side === 'sell' ? [{ ...amm, amount: -S(body.amount) }, { ...trader, amount: S(body.amount) }] : [trader, amm]; }
      else if (u.pathname === '/api/ledger/payout') { const total = (body.winners || []).reduce((a, w) => a + S(w.amount), 0n) + S(body.residual || '0'); postings = [{ account: `amm:${body.marketId}`, amount: -total }]; for (const w of body.winners) postings.push({ account: `trader:${w.principal}`, amount: S(w.amount) }); if (S(body.residual || '0') > 0n) postings.push({ account: 'house', amount: S(body.residual) }); }
      if (postings) { const r = apply(body.txId, postings); return { ok: true, status: r.replay ? 200 : 201, json: async () => ({ ok: true }) }; }
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'no route' }) };
    } catch (e) { const status = e.status || 500; return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: false, error: e.message }) }; }
  };
  return { balances, calls, bal };
}

const kl = require('../server/kax-ledger');

async function seed(hub, id) { await hub.registerTrader({ id, display_name: id, kind: 'agent' }); await kl.grant({ principal: id, amountMinor: '100000000', txId: 'grant:register:' + id }); }

async function run() {
  const led = makeFakeLedger();
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
  await hub.init();

  // Proposer is an OBC bot (obc:carol); traders are three distinct KAX agents.
  const proposerObc = 'obc:carol';
  const traders = ['kax:agent:t1', 'kax:agent:t2', 'kax:agent:t3'];
  for (const t of traders) await seed(hub, t);

  const m = await hub.createMarket({ question: 'fee market', outcomes: ['Yes', 'No'], ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs', metadata: { proposedBy: proposerObc, predictionId: 'pred-fee-1' } });
  // Three distinct traders each buy the LOSING side (so the pool keeps a residual).
  for (const t of traders) await hub.placeTrade({ market_id: m.id, trader_id: t, outcome: 0, shares: 3 });

  const poolBefore = led.bal(`amm:${m.id}`);
  const houseBefore = led.bal('house');
  const feeAcct = `trader:kax:agent:carol`; // obc:carol → kax:agent:carol
  assert.strictEqual(led.bal(feeAcct), 0n, 'proposer has no balance yet');

  // Resolve to the side NOBODY bought → all stakes + subsidy are residual, max fee.
  await hub.resolveMarket({ market_id: m.id, winning_outcome: 1, method: 'manual' });

  const feePaid = led.bal(feeAcct);
  assert.ok(feePaid > 0n, 'proposer received a residual fee');
  // Fee is exactly floor(residual * 200 / 10000) of the pre-fee residual (= full pool here, no winners).
  const expectedFee = (poolBefore * 200n) / 10000n;
  assert.strictEqual(feePaid, expectedFee, `fee is 2% of residual (${feePaid} vs ${expectedFee})`);
  // House got the rest of the residual; pool fully swept.
  assert.strictEqual(led.bal(`amm:${m.id}`), 0n, 'pool fully swept (no stranding)');
  assert.strictEqual(led.bal('house') - houseBefore, poolBefore - feePaid, 'house got residual minus the fee');

  // Conservation: every posting summed to zero.
  let total = 0n; for (const v of led.balances.values()) total += v;
  assert.strictEqual(total, 0n, 'ledger conserved (Σ balances == 0) — fee did not mint');
  console.log(`ok  fee ${feePaid} paid from residual; house ${poolBefore - feePaid}; conserved; solvent`);

  // ── Participation gate: a market with < min distinct traders pays NO fee ──
  const m2 = await hub.createMarket({ question: 'thin market', outcomes: ['Yes', 'No'], ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs', metadata: { proposedBy: 'obc:dave', predictionId: 'pred-fee-2' } });
  await hub.placeTrade({ market_id: m2.id, trader_id: traders[0], outcome: 0, shares: 2 }); // only ONE trader
  const daveBefore = led.bal('trader:kax:agent:dave');
  await hub.resolveMarket({ market_id: m2.id, winning_outcome: 1, method: 'manual' });
  assert.strictEqual(led.bal('trader:kax:agent:dave'), daveBefore, 'no fee when the market drew fewer than 3 distinct traders');
  console.log('ok  participation gate: an under-attended market pays the proposer nothing');

  console.log('\nPASSED proposer-fee.test.js');
}

run().catch((e) => { console.error('\nFAILED proposer-fee.test.js:', e.stack || e.message); process.exitCode = 1; });
