'use strict';

// Unit tests for the KAX ledger client + economic math (ADR-0041 Phase 2,
// funded-AMM PR 2a). No network, no DB — exercises the two review blockers that
// live in this module:
//   #10 rounding in the pool's favor (solvency), and
//   #12 ambiguous ≠ failed (the httpJson classification contract).

const assert = require('assert');
const kax = require('../server/kax-ledger');

function testRoundingDirection() {
  // ceil charges the trader up; floor pays the winner down. Same fractional
  // input must round in OPPOSITE directions (the pool keeps the sub-unit).
  assert.strictEqual(kax.toMinorCeil(1.0000004), '1000001', 'ceil rounds up');
  assert.strictEqual(kax.toMinorFloor(1.0000004), '1000000', 'floor rounds down');
  assert.strictEqual(kax.toMinorCeil(2), '2000000', 'integer credits exact (ceil)');
  assert.strictEqual(kax.toMinorFloor(2), '2000000', 'integer credits exact (floor)');
  console.log('ok  rounding direction (ceil up / floor down)');
}

function testDustRejected() {
  // A trade whose cost rounds to <= 0 minor units would be a free share. Because
  // we ceil, any strictly-positive cost charges at least 1 minor unit (in the
  // pool's favor), so only cost <= 0 is dust.
  assert.throws(() => kax.tradeCostMinor(0), /dust/, 'zero cost rejected');
  assert.throws(() => kax.tradeCostMinor(-0.5), /dust/, 'negative cost rejected');
  assert.strictEqual(kax.tradeCostMinor(1e-9), '1', 'tiny positive cost still charges 1 minor unit');
  assert.strictEqual(kax.tradeCostMinor(1e-6), '1', 'exactly one minor unit');
  assert.strictEqual(kax.tradeCostMinor(0.5), '500000', 'half credit');
  console.log('ok  dust trades rejected (no free shares); tiny costs charge >= 1');
}

function testSubsidyFormula() {
  // subsidy = ceil(b·ln(n)·MINOR). b=10, n=2 → 10·0.6931… = 6.931… credits.
  const s = kax.subsidyMinor(10, 2);
  assert.strictEqual(s, String(Math.ceil(10 * Math.log(2) * kax.MINOR)), 'subsidy = ceil(b·ln n·MINOR)');
  assert.ok(BigInt(s) > 6_931_000n && BigInt(s) < 6_932_000n, `subsidy ~6.931 credits, got ${s}`);
  assert.throws(() => kax.subsidyMinor(10, 1), /n>=2/, 'n<2 rejected');
  assert.throws(() => kax.subsidyMinor(0, 2), /b>0/, 'b<=0 rejected');
  console.log('ok  subsidy formula');
}

function testSolvencyInvariant() {
  // The core conservation claim: for ANY sequence of trades then payouts, with
  // ceil charging and floor paying, the pool never goes negative. Construct the
  // worst case: costs and payouts that (unrounded) would net the pool to exactly
  // 0, then show integer rounding leaves it >= 0.
  const b = 10, n = 2;
  const subsidy = BigInt(kax.subsidyMinor(b, n));
  // 200 trades with fractional per-unit costs.
  let charged = 0n;
  const trueCosts = [];
  for (let i = 0; i < 200; i++) {
    const c = 0.0000005 + (i % 7) * 0.13; // fractional credits
    trueCosts.push(c);
    charged += BigInt(kax.tradeCostMinor(c));
  }
  // Winners are paid the floor of some share amounts whose TRUE total value
  // equals subsidy(true) + Σ trueCosts — i.e. the market maker's break-even.
  const trueInflow = trueCosts.reduce((a, c) => a + c, 0) + b * Math.log(n);
  // Split the break-even inflow across 50 winners as share payouts.
  let paid = 0n;
  const per = trueInflow / 50;
  for (let i = 0; i < 50; i++) paid += BigInt(kax.payoutMinor(per));
  const poolAfter = subsidy + charged - paid;
  assert.ok(poolAfter >= 0n, `pool must stay solvent; got ${poolAfter}`);
  console.log(`ok  solvency invariant (pool residual ${poolAfter} minor units >= 0)`);
}

function testTxidDeterminism() {
  assert.strictEqual(kax.txid.escrow('m_abc'), 'escrow:m_abc');
  assert.strictEqual(kax.txid.resolve('m_abc'), 'resolve:m_abc');
  assert.strictEqual(kax.txid.grantRegister('kax:agent:alias'), 'grant:register:kax:agent:alias');
  // Same logical event → identical id (idempotency key stability).
  assert.strictEqual(kax.txid.resolve('m_abc'), kax.txid.resolve('m_abc'));
  console.log('ok  deterministic txids');
}

function testPrincipalValidation() {
  assert.strictEqual(kax.principalFor('kax:agent:alias'), 'kax:agent:alias');
  assert.throws(() => kax.principalFor(''), /valid ledger principal/);
  assert.throws(() => kax.principalFor('has space'), /valid ledger principal/);
  assert.throws(() => kax.principalFor('a'), /valid ledger principal/, 'too short');
  console.log('ok  principal validation mirrors server grammar');
}

// #12: the ambiguity contract. Stub global.fetch to drive each branch.
async function testAmbiguityContract() {
  const origFetch = global.fetch;
  const stub = (status, jsonBody, opts = {}) => {
    global.fetch = async () => {
      if (opts.throwErr) throw new Error('network down');
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => jsonBody,
      };
    };
  };
  try {
    // 2xx → committed, definitive.
    stub(201, { ok: true, head: 'h', count: 2 });
    let r = await kax.httpJson('POST', '/api/ledger/trade', 't', { a: 1 });
    assert.deepStrictEqual([r.ok, r.definitive], [true, true], '2xx committed+definitive');

    // 409 (conflict / insufficient) → NOT posted, definitive.
    stub(409, { ok: false, error: 'insufficient funds' });
    r = await kax.httpJson('POST', '/api/ledger/trade', 't', { a: 1 });
    assert.deepStrictEqual([r.ok, r.definitive], [false, true], '409 not-posted+definitive');

    // 400 → definitive.
    stub(400, { ok: false, error: 'bad request' });
    r = await kax.httpJson('POST', '/api/ledger/trade', 't', { a: 1 });
    assert.strictEqual(r.definitive, true, '400 definitive');

    // 429 (grant cap) → definitive.
    stub(429, { ok: false, error: 'daily grant cap exceeded' });
    r = await kax.httpJson('POST', '/api/ledger/grant', 't', { a: 1 });
    assert.strictEqual(r.definitive, true, '429 definitive');

    // 500 → AMBIGUOUS (may have committed) — must NOT be treated as failed.
    stub(500, { ok: false, error: 'boom' });
    r = await kax.httpJson('POST', '/api/ledger/trade', 't', { a: 1 });
    assert.deepStrictEqual([r.ok, r.definitive], [false, false], '5xx ambiguous');

    // network error / timeout → AMBIGUOUS.
    stub(0, null, { throwErr: true });
    r = await kax.httpJson('POST', '/api/ledger/trade', 't', { a: 1 });
    assert.deepStrictEqual([r.ok, r.definitive, r.status], [false, false, 0], 'network error ambiguous');

    console.log('ok  ambiguity contract (4xx=not-posted, 5xx/timeout=reconcile)');
  } finally {
    global.fetch = origFetch;
  }
}

function testInertUntilConfigured() {
  // With no env, the surfaces are disabled and mutating calls refuse locally.
  const saved = { ...process.env };
  delete process.env.KAX_LEDGER_BASE;
  delete process.env.KAX_LEDGER_MINT_TOKEN;
  delete process.env.KAX_LEDGER_TRADE_TOKEN;
  try {
    assert.strictEqual(kax.tradeEnabled(), false);
    assert.strictEqual(kax.mintEnabled(), false);
    return Promise.all([
      assert.rejects(() => kax.trade({ txId: 'trade:x', principal: 'kax:agent:a', marketId: 'm_1', amountMinor: '10' }), /not configured/),
      assert.rejects(() => kax.escrow({ marketId: 'm_1', subsidyMinor: '10' }), /not configured/),
    ]).then(() => console.log('ok  inert until configured'));
  } finally {
    Object.assign(process.env, saved);
  }
}

(async () => {
  testRoundingDirection();
  testDustRejected();
  testSubsidyFormula();
  testSolvencyInvariant();
  testTxidDeterminism();
  testPrincipalValidation();
  await testAmbiguityContract();
  await testInertUntilConfigured();
  console.log('\nPASSED kax-ledger.test.js');
})().catch((e) => {
  console.error('\nFAILED kax-ledger.test.js:', e.message);
  process.exitCode = 1;
});
