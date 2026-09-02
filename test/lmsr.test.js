'use strict';

// lmsr.test.js — property tests for the pure LMSR math (server/lmsr.js).
//
// The hub's money path is only as sound as these three identities, so they are
// checked over many random states rather than a handful of hand-picked ones:
//   1. prices are a probability vector (each in (0,1), Σ = 1),
//   2. cost is path-independent (buy A then B costs the same as buying A+B),
//      strictly positive for a positive buy, and larger for a larger buy,
//   3. the log-sum-exp form is stable for |q|/b far beyond exp() range.
// And the guards: b <= 0 / NaN / Infinity, q of length < 2, non-finite q, a
// share count that is not a positive finite number, are refused rather than
// producing a NaN or negative cost that a caller would happily debit.

const assert = require('assert');
const { lmsrCost, lmsrPrices, lmsrTradeCost, MAX_OUTCOMES } = require('../server/lmsr');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

// Deterministic PRNG so a failure is reproducible from the seed printed below.
let seed = Number(process.env.LMSR_TEST_SEED) || 0x5eed1234;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; }
console.log(`lmsr.test.js (seed ${seed})`);

function randomState() {
  const n = 2 + Math.floor(rnd() * 6);            // 2..7 outcomes
  const b = Math.exp(rnd() * 12 - 4);              // ~0.018 .. ~2981
  // q spread bounded to ±10b so no outcome is priced below ~e^-20: a buy of an
  // outcome priced at 1e-300 legitimately costs 0 in float and is refused as
  // dust by lmsrTradeCost (that refusal has its own test below).
  const q = Array.from({ length: n }, () => (rnd() - 0.5) * 20 * b);
  return { n, b, q };
}

run('prices are a probability vector over 2000 random states', () => {
  for (let i = 0; i < 2000; i++) {
    const { b, q } = randomState();
    const p = lmsrPrices(q, b);
    const sum = p.reduce((a, x) => a + x, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `Σp = ${sum} for q=${JSON.stringify(q)} b=${b}`);
    for (const x of p) assert.ok(x >= 0 && x <= 1 && Number.isFinite(x), `price ${x} out of [0,1]`);
    // The outcome with the largest q has the highest price.
    const argmaxQ = q.indexOf(Math.max(...q));
    const argmaxP = p.indexOf(Math.max(...p));
    assert.strictEqual(argmaxP, argmaxQ, 'highest q must carry the highest price');
  }
});

run('cost is path-independent, strictly positive, and monotone in shares', () => {
  for (let i = 0; i < 2000; i++) {
    const { n, b, q } = randomState();
    const idx = Math.floor(rnd() * n);
    const s1 = Math.exp(rnd() * 5 - 2) * b;         // 0.14b .. 20b
    const s2 = Math.exp(rnd() * 5 - 2) * b;
    const a = lmsrTradeCost(q, b, idx, s1);
    const then = lmsrTradeCost(a.qAfter, b, idx, s2);
    const once = lmsrTradeCost(q, b, idx, s1 + s2);
    const twoStep = a.cost + then.cost;
    // Relative tolerance: costs scale with b, so compare against magnitude.
    const tol = 1e-9 * Math.max(1, Math.abs(once.cost));
    assert.ok(Math.abs(twoStep - once.cost) <= tol, `path dependence: ${twoStep} vs ${once.cost} (q=${JSON.stringify(q)}, b=${b})`);
    assert.ok(a.cost > 0, `cost must be > 0, got ${a.cost}`);
    assert.ok(once.cost > a.cost, `buying more must cost more (${once.cost} <= ${a.cost})`);
    // A trade can never cost more than its face value (1/share) — LMSR prices are < 1.
    assert.ok(a.cost <= s1 + 1e-9 * s1, `cost ${a.cost} exceeds face value ${s1}`);
  }
});

run('buying shares can never cost more than a full-price fill (no over-charging)', () => {
  // The marginal price is bounded by 1, so the cost of s shares is < s. This is
  // the pool's side of "no free money": we never charge above face either.
  for (let i = 0; i < 500; i++) {
    const { n, b, q } = randomState();
    const idx = Math.floor(rnd() * n);
    const s = Math.exp(rnd() * 5 - 2) * b;
    const { cost } = lmsrTradeCost(q, b, idx, s);
    assert.ok(cost < s * (1 + 1e-12) , `cost ${cost} >= shares ${s}`);
  }
});

run('log-sum-exp stays finite for |q|/b far beyond exp() range', () => {
  const b = 1;
  const q = [1e6, 0, -1e6];
  const c = lmsrCost(q, b);
  assert.ok(Number.isFinite(c) && Math.abs(c - 1e6) < 1e-6, `cost ${c} should be ≈ 1e6`);
  const p = lmsrPrices(q, b);
  assert.ok(p.every(Number.isFinite), 'prices finite');
  assert.ok(Math.abs(p[0] - 1) < 1e-12 && p[1] === 0 && p[2] === 0, `prices ${p} should be [1,0,0]`);
  // Symmetric huge negatives.
  const p2 = lmsrPrices([-1e9, -1e9], 3);
  assert.deepStrictEqual(p2, [0.5, 0.5]);
  // Tiny b relative to q (a very illiquid market) — still finite.
  const c3 = lmsrCost([500, 0], 0.001);
  assert.ok(Number.isFinite(c3), `illiquid cost ${c3}`);
});

run('a uniform q prices every outcome at 1/n and costs b·ln(n)', () => {
  for (let n = 2; n <= 8; n++) {
    const q = new Array(n).fill(0);
    const p = lmsrPrices(q, 10);
    for (const x of p) assert.ok(Math.abs(x - 1 / n) < 1e-12);
    assert.ok(Math.abs(lmsrCost(q, 10) - 10 * Math.log(n)) < 1e-9);
  }
});

run('liquidity guards: b = 0, negative, NaN, Infinity, non-number are refused', () => {
  for (const b of [0, -1, -0.0001, NaN, Infinity, -Infinity, '10', null, undefined, {}]) {
    assert.throws(() => lmsrCost([0, 0], b), /liquidity/, `lmsrCost accepted b=${String(b)}`);
    assert.throws(() => lmsrPrices([0, 0], b), /liquidity/, `lmsrPrices accepted b=${String(b)}`);
    assert.throws(() => lmsrTradeCost([0, 0], b, 0, 1), /liquidity/, `lmsrTradeCost accepted b=${String(b)}`);
  }
});

run('a negative b would have sold unlimited shares for a bounded cost (the bug this guards)', () => {
  // Reconstruct the unguarded formula to show WHY it must be refused: with b<0
  // the price of an outcome FALLS as you buy it, so C(q) is bounded above by 0
  // and a thousand shares (a $1000 payout) cost no more than |b|·ln(2) ≈ 6.93.
  // (Push it further and the formula overflows to a cost of -Infinity: the
  // trader is paid to take the shares.)
  const raw = (q, b) => { const max = Math.max(...q) / b; let s = 0; for (const qi of q) s += Math.exp(qi / b - max); return b * (max + Math.log(s)); };
  const costOfThousand = raw([1000, 0], -10) - raw([0, 0], -10);
  assert.ok(costOfThousand < 7, `unguarded b<0: 1000 shares cost only ${costOfThousand}`);
  assert.strictEqual(raw([1e6, 0], -10) - raw([0, 0], -10), -Infinity, 'and 1e6 shares overflow to a negative-infinite cost');
  // The guarded function refuses the state outright.
  assert.throws(() => lmsrTradeCost([0, 0], -10, 0, 1e6), /liquidity/);
});

run('q guards: fewer than 2 outcomes, too many, non-finite, non-array are refused', () => {
  assert.throws(() => lmsrCost([], 10), /2\.\./);
  assert.throws(() => lmsrCost([0], 10), /2\.\./, 'a single-outcome market prices at 1 — every share would be free');
  assert.throws(() => lmsrCost(new Array(MAX_OUTCOMES + 1).fill(0), 10), /2\.\./);
  assert.throws(() => lmsrCost([0, NaN], 10), /finite/);
  assert.throws(() => lmsrCost([0, Infinity], 10), /finite/);
  assert.throws(() => lmsrCost([0, '1'], 10), /finite/);
  assert.throws(() => lmsrCost('ab', 10), /array/);
  assert.throws(() => lmsrPrices(null, 10), /array/);
});

run('trade guards: shares <= 0, NaN, string; outcome out of range / non-integer', () => {
  for (const s of [0, -1, NaN, Infinity, '5', null]) {
    assert.throws(() => lmsrTradeCost([0, 0], 10, 0, s), /shares must be positive/, `accepted shares=${String(s)}`);
  }
  for (const idx of [-1, 2, 0.5, '0', NaN]) {
    assert.throws(() => lmsrTradeCost([0, 0], 10, idx, 1), /outcome out of range/, `accepted idx=${String(idx)}`);
  }
});

run('a buy too small to move the cost function is refused (no free dust shares)', () => {
  // 1e-18 shares against C(q)≈6.93 vanishes below float resolution: the
  // unguarded subtraction returns exactly 0 and the hub would credit a position
  // for nothing. Repeated, that is a (slow) mint.
  assert.throws(() => lmsrTradeCost([0, 0], 10, 0, 1e-18), /too small/);
  // While a merely small buy is fine.
  assert.ok(lmsrTradeCost([0, 0], 10, 0, 1e-6).cost > 0);
});

run('lmsrTradeCost does not mutate its input q', () => {
  const q = [1, 2, 3];
  lmsrTradeCost(q, 5, 1, 2);
  assert.deepStrictEqual(q, [1, 2, 3]);
});

if (failed) { console.error(`\n${failed} lmsr test(s) FAILED`); process.exitCode = 1; }
else console.log('\nAll lmsr tests passed');
