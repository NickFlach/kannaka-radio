'use strict';

// ADR-0041 Phase-0 ledger-safety regressions for the GhostSignals hub:
//   1. Concurrent resolveMarket must pay winners at most ONCE (single-flip
//      guard) — the manual /resolve racing the TTL sweep must not double-pay.
//   2. A trade over capital is rejected, and two concurrent trades that each
//      fit alone but not together can never drive capital negative (guarded
//      debit) — no credit double-spend.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { GhostSignalsHub } = require('../server/ghostsignals-hub');

function tmpDbPath() {
  const dir = path.join(os.tmpdir(), 'gshub-ledger-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

async function testDoubleResolve() {
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
  await hub.init();
  const m = await hub.createMarket({ question: 'double-resolve guard', ttl_sec: 3600, tag: 'custom' });
  await hub.registerTrader({ id: 'winner', display_name: 'winner', kind: 'ai' });
  const beforeCapital = (await hub.getTrader('winner')).capital;
  const { cost } = await hub.placeTrade({ market_id: m.id, trader_id: 'winner', outcome: 0, shares: 10 });

  // Fire two resolves for the SAME winning outcome concurrently (models the
  // manual /resolve racing the TTL sweep). Exactly one must win; the other
  // must reject 'already resolved' and pay nothing.
  const settled = await Promise.allSettled([
    hub.resolveMarket({ market_id: m.id, winning_outcome: 0, method: 'manual' }),
    hub.resolveMarket({ market_id: m.id, winning_outcome: 0, method: 'ttl' }),
  ]);
  const ok = settled.filter((r) => r.status === 'fulfilled').length;
  const rejected = settled.filter((r) => r.status === 'rejected');
  assert.strictEqual(ok, 1, `exactly one resolve should succeed, got ${ok}`);
  assert.ok(rejected.every((r) => /already resolved/.test(r.reason.message)),
    'the losing resolve must reject with "already resolved"');

  // Winner held 10 winning shares → paid exactly 10 once. Capital must be
  // beforeCapital - cost + 10, NOT + 20 (which double-pay would produce).
  const afterCapital = (await hub.getTrader('winner')).capital;
  const expected = beforeCapital - cost + 10;
  assert.ok(Math.abs(afterCapital - expected) < 1e-9,
    `BLOCKER: winner capital ${afterCapital} != single-payout ${expected} (double-pay?)`);
}

async function testNoNegativeCapital() {
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10, startingCapital: 100 });
  await hub.init();
  const m = await hub.createMarket({ question: 'capital guard', ttl_sec: 3600, tag: 'custom' });
  await hub.registerTrader({ id: 'broke', display_name: 'broke', kind: 'ai' });

  // A single trade whose cost exceeds capital must be rejected.
  let overRejected = false;
  try {
    await hub.placeTrade({ market_id: m.id, trader_id: 'broke', outcome: 0, shares: 100000 });
  } catch (e) { overRejected = /insufficient capital/.test(e.message); }
  assert.ok(overRejected, 'a trade over capital must reject with "insufficient capital"');

  // Two concurrent trades that each fit alone but not together: at most the
  // ones that fit may commit, and capital must never go negative.
  const hub2 = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 1000, startingCapital: 100 });
  await hub2.init();
  const m2 = await hub2.createMarket({ question: 'concurrent debit', ttl_sec: 3600, tag: 'custom' });
  await hub2.registerTrader({ id: 't', display_name: 't', kind: 'ai' });
  // With high liquidity, cost ≈ shares/2 near the origin; 120 shares ≈ ~60 cost,
  // so two of them (~120) exceed the 100 capital but one fits.
  const results = await Promise.allSettled([
    hub2.placeTrade({ market_id: m2.id, trader_id: 't', outcome: 0, shares: 120 }),
    hub2.placeTrade({ market_id: m2.id, trader_id: 't', outcome: 0, shares: 120 }),
  ]);
  const cap = (await hub2.getTrader('t')).capital;
  assert.ok(cap >= 0, `BLOCKER: capital went negative (${cap}) — unguarded concurrent debit`);
  const committed = results.filter((r) => r.status === 'fulfilled').length;
  assert.ok(committed <= 1, `at most one of the two over-together trades may commit, got ${committed}`);
}

async function main() {
  await testDoubleResolve();
  await testNoNegativeCapital();
  console.log('ghostsignals-ledger-safety.test.js: OK (no double-pay; no negative capital)');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
