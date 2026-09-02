'use strict';

// ghostsignals-hub-hardening.test.js — the play-tier market engine attacked as
// a market engine. Each block was written as a FAILING test against the
// pre-hardening hub (commit 7ca5f1e) and names what it caught:
//
//   A. market inputs: negative liquidity (a buy PAID the trader), a single
//      outcome (every share free), empty / non-array outcomes (NaN prices),
//      non-string question, NaN ttl.
//   B. resolve refuses a non-integer winning_outcome — "0" (string), 0.5, null,
//      undefined all used to flip resolved=1 with NOBODY paid (outcome_idx
//      compared === against a string / float / NULL).
//   C. concurrent trades on one market all commit (serialised), instead of
//      N-1 of them failing "market state changed concurrently".
//   D. atomicity: a throw between statements rolls back money, q and position.
//   E. conservation property over a random trade/resolve sequence: every
//      credit that leaves a trader is a recorded cost, every credit that
//      arrives is a winning share; capital never negative.
//   F. idempotency_key: a double-submitted trade is applied once.
//   G. a play-tier create cannot squat the deterministic id of a labs
//      prediction market (metadata.predictionId).
//   H. registration input bounds; dust trades; hub stats contract (#285).

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
require('./lib/sqlite3-guard')('ghostsignals-hub-hardening');
const { GhostSignalsHub } = require('../server/ghostsignals-hub');

function tmpDbPath(tag) {
  const dir = path.join(os.tmpdir(), `gshub-hard-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}
async function freshHub(tag, opts = {}) {
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(tag), defaultLiquidity: 10, startingCapital: 100, ...opts });
  await hub.init();
  return hub;
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
let seed = 0xc0ffee;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; }

let failed = 0;
async function run(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}

async function main() {
  console.log('ghostsignals-hub-hardening.test.js');

  // ── A. market inputs ─────────────────────────────────────────────────
  await run('A1 negative liquidity is refused (it inverted the cost function)', async () => {
    const hub = await freshHub('a1');
    await assert.rejects(() => hub.createMarket({ question: 'neg b', ttl_sec: 60, liquidity: -10 }), /liquidity/);
    await assert.rejects(() => hub.createMarket({ question: 'nan b', ttl_sec: 60, liquidity: NaN }), /liquidity/);
    await assert.rejects(() => hub.createMarket({ question: 'str b', ttl_sec: 60, liquidity: '10' }), /liquidity/);
    // 0 / undefined still mean "use the default" (existing callers pass nothing).
    const m = await hub.createMarket({ question: 'default b', ttl_sec: 60, liquidity: 0 });
    assert.strictEqual(m.liquidity, 10);
  });

  await run('A2 outcomes must be 2..N distinct non-empty strings', async () => {
    const hub = await freshHub('a2');
    await assert.rejects(() => hub.createMarket({ question: 'one', ttl_sec: 60, outcomes: ['Only'] }), /outcomes/);
    await assert.rejects(() => hub.createMarket({ question: 'none', ttl_sec: 60, outcomes: [] }), /outcomes/);
    await assert.rejects(() => hub.createMarket({ question: 'str', ttl_sec: 60, outcomes: 'Yes' }), /outcomes/);
    await assert.rejects(() => hub.createMarket({ question: 'nums', ttl_sec: 60, outcomes: [1, 2] }), /outcomes/);
    await assert.rejects(() => hub.createMarket({ question: 'blank', ttl_sec: 60, outcomes: ['Yes', '  '] }), /outcomes/);
    await assert.rejects(() => hub.createMarket({ question: 'dup', ttl_sec: 60, outcomes: ['Yes', 'Yes'] }), /outcomes/);
    await assert.rejects(() => hub.createMarket({ question: 'many', ttl_sec: 60, outcomes: Array.from({ length: 40 }, (_, i) => `o${i}`) }), /outcomes/);
    const m = await hub.createMarket({ question: 'three', ttl_sec: 60, outcomes: ['A', 'B', 'C'] });
    assert.deepStrictEqual(m.outcomes, ['A', 'B', 'C']);
    assert.ok(Math.abs(sum(m.prices) - 1) < 1e-12);
  });

  await run('A3 question must be a non-empty bounded string; ttl_sec must be a finite number', async () => {
    const hub = await freshHub('a3');
    await assert.rejects(() => hub.createMarket({ ttl_sec: 60 }), /question/);
    await assert.rejects(() => hub.createMarket({ question: '   ', ttl_sec: 60 }), /question/);
    await assert.rejects(() => hub.createMarket({ question: { a: 1 }, ttl_sec: 60 }), /question/);
    await assert.rejects(() => hub.createMarket({ question: 'x'.repeat(2001), ttl_sec: 60 }), /question/);
    await assert.rejects(() => hub.createMarket({ question: 'ttl', ttl_sec: 'abc' }), /ttl_sec/);
    await assert.rejects(() => hub.createMarket({ question: 'ttl', ttl_sec: NaN }), /ttl_sec/);
    await assert.rejects(() => hub.createMarket({ question: 'ttl', ttl_sec: 1e15 }), /ttl_sec/);
  });

  // ── B. resolve outcome validation ───────────────────────────────────
  await run('B  resolve refuses a non-integer / out-of-range winning_outcome and pays nobody until a valid one', async () => {
    const hub = await freshHub('b');
    const m = await hub.createMarket({ question: 'resolve types', ttl_sec: 3600 });
    await hub.registerTrader({ id: 'w', display_name: 'w' });
    const { cost } = await hub.placeTrade({ market_id: m.id, trader_id: 'w', outcome: 0, shares: 10 });
    for (const bad of ['0', 0.5, null, undefined, -1, 2, NaN, '1', [0], {}]) {
      await assert.rejects(
        () => hub.resolveMarket({ market_id: m.id, winning_outcome: bad, method: 'manual' }),
        /winning_outcome/,
        `resolve accepted winning_outcome=${JSON.stringify(bad)}`,
      );
      const cur = await hub.getMarket(m.id);
      assert.strictEqual(cur.resolved, false, `market was resolved by winning_outcome=${JSON.stringify(bad)}`);
    }
    await hub.resolveMarket({ market_id: m.id, winning_outcome: 0, method: 'manual' });
    const w = await hub.getTrader('w');
    assert.ok(Math.abs(w.capital - (100 - cost + 10)) < 1e-9, `winner paid exactly once: ${w.capital}`);
    // And trading after resolution is refused with the honest reason.
    await assert.rejects(() => hub.placeTrade({ market_id: m.id, trader_id: 'w', outcome: 0, shares: 1 }), /already resolved/);
  });

  // ── C. concurrency ──────────────────────────────────────────────────
  await run('C  six concurrent trades on one market ALL commit, q and positions sum exactly', async () => {
    const hub = await freshHub('c');
    const m = await hub.createMarket({ question: 'concurrent', ttl_sec: 3600 });
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    for (const id of ids) await hub.registerTrader({ id, display_name: id });
    const shares = [1, 2, 3, 4, 5, 6];
    const results = await Promise.allSettled(ids.map((id, i) =>
      hub.placeTrade({ market_id: m.id, trader_id: id, outcome: i % 2, shares: shares[i] })));
    const rejected = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
    assert.deepStrictEqual(rejected, [], `concurrent trades were rejected: ${rejected.join(' | ')}`);
    const after = await hub.getMarket(m.id);
    assert.strictEqual(after.q[0], 1 + 3 + 5, 'q[0] is the sum of the even traders');
    assert.strictEqual(after.q[1], 2 + 4 + 6, 'q[1] is the sum of the odd traders');
    const pos = await hub._all('SELECT trader_id, shares FROM positions WHERE market_id = ?', [m.id]);
    assert.strictEqual(sum(pos.map((p) => p.shares)), 21);
    // Sequential pricing: the i-th trade was priced against the (i-1)-th state,
    // so total cost == C(q_final) − C(q_0).
    const { lmsrCost } = require('../server/lmsr');
    const totalCost = sum(results.map((r) => r.value.cost));
    assert.ok(Math.abs(totalCost - (lmsrCost(after.q, 10) - lmsrCost([0, 0], 10))) < 1e-9, 'trades were priced sequentially, not off a shared stale snapshot');
    const caps = await Promise.all(ids.map((id) => hub.getTrader(id)));
    ids.forEach((id, i) => assert.ok(Math.abs(caps[i].capital - (100 - results[i].value.cost)) < 1e-9, `${id} debited its own cost`));
  });

  // ── D. atomicity ────────────────────────────────────────────────────
  await run('D  a failure between statements leaves capital, q, trades and positions untouched', async () => {
    const hub = await freshHub('d');
    const m = await hub.createMarket({ question: 'atomic', ttl_sec: 3600 });
    await hub.registerTrader({ id: 'atom', display_name: 'atom' });
    await hub.placeTrade({ market_id: m.id, trader_id: 'atom', outcome: 0, shares: 2 }); // a baseline row
    const before = {
      cap: (await hub.getTrader('atom')).capital,
      q: (await hub.getMarket(m.id)).q,
      trades: (await hub._all('SELECT COUNT(*) AS c FROM trades'))[0].c,
      pos: (await hub._all('SELECT shares FROM positions WHERE trader_id = ?', ['atom']))[0].shares,
    };
    const realRun = hub._run.bind(hub);
    hub._run = (sql, params) => /INSERT INTO positions/.test(sql) ? Promise.reject(new Error('injected: disk full')) : realRun(sql, params);
    await assert.rejects(() => hub.placeTrade({ market_id: m.id, trader_id: 'atom', outcome: 1, shares: 3 }), /injected/);
    hub._run = realRun;
    const after = {
      cap: (await hub.getTrader('atom')).capital,
      q: (await hub.getMarket(m.id)).q,
      trades: (await hub._all('SELECT COUNT(*) AS c FROM trades'))[0].c,
      pos: (await hub._all('SELECT shares FROM positions WHERE trader_id = ?', ['atom']))[0].shares,
    };
    assert.deepStrictEqual(after, before, 'partial trade leaked state');
    // The connection is not stuck in a transaction: the next trade works.
    await hub.placeTrade({ market_id: m.id, trader_id: 'atom', outcome: 1, shares: 3 });
  });

  // ── E. conservation property ────────────────────────────────────────
  await run('E  random trade/resolve sequence: Δcapital == Σpayout − Σcost; capital never negative', async () => {
    const hub = await freshHub('e', { defaultLiquidity: 25 });
    const traders = ['e1', 'e2', 'e3', 'e4'];
    for (const t of traders) await hub.registerTrader({ id: t, display_name: t });
    const markets = [];
    for (let i = 0; i < 3; i++) markets.push(await hub.createMarket({ question: `prop ${i}`, ttl_sec: 3600, outcomes: i === 2 ? ['A', 'B', 'C'] : ['Yes', 'No'] }));
    const capital0 = sum((await Promise.all(traders.map((t) => hub.getTrader(t)))).map((t) => t.capital));
    let recordedCost = 0;
    let accepted = 0;
    for (let i = 0; i < 60; i++) {
      const m = markets[Math.floor(rnd() * markets.length)];
      const t = traders[Math.floor(rnd() * traders.length)];
      const outcome = Math.floor(rnd() * m.outcomes.length);
      const shares = Math.round((rnd() * 30 + 0.5) * 100) / 100;
      try {
        const r = await hub.placeTrade({ market_id: m.id, trader_id: t, outcome, shares });
        recordedCost += r.cost; accepted++;
      } catch (e) {
        assert.ok(/insufficient capital/.test(e.message), `unexpected rejection: ${e.message}`);
      }
      const caps = await Promise.all(traders.map((x) => hub.getTrader(x)));
      for (const c of caps) assert.ok(c.capital >= -1e-9, `capital went negative: ${c.id} ${c.capital}`);
    }
    assert.ok(accepted >= 20, `too few trades accepted (${accepted}) for the property to mean anything`);
    const tradeRows = await hub._all('SELECT market_id, trader_id, outcome_idx, SUM(shares) AS s, SUM(cost) AS c FROM trades GROUP BY market_id, trader_id, outcome_idx');
    assert.ok(Math.abs(sum(tradeRows.map((r) => r.c)) - recordedCost) < 1e-6, 'trades table records every cost');
    // Positions mirror the trades table exactly.
    for (const r of tradeRows) {
      const p = (await hub._all('SELECT shares FROM positions WHERE market_id = ? AND trader_id = ? AND outcome_idx = ?', [r.market_id, r.trader_id, r.outcome_idx]))[0];
      assert.ok(p && Math.abs(p.shares - r.s) < 1e-9, `position drift for ${r.trader_id}/${r.market_id}/${r.outcome_idx}`);
    }
    let expectedPayout = 0;
    for (const m of markets) {
      const win = Math.floor(rnd() * m.outcomes.length);
      const winners = await hub._all('SELECT COALESCE(SUM(shares), 0) AS s FROM positions WHERE market_id = ? AND outcome_idx = ?', [m.id, win]);
      expectedPayout += winners[0].s;
      await hub.resolveMarket({ market_id: m.id, winning_outcome: win, method: 'manual' });
    }
    const capital1 = sum((await Promise.all(traders.map((t) => hub.getTrader(t)))).map((t) => t.capital));
    assert.ok(Math.abs((capital1 - capital0) - (expectedPayout - recordedCost)) < 1e-6,
      `Δcapital ${capital1 - capital0} != payout ${expectedPayout} − cost ${recordedCost}`);
  });

  // ── F. idempotency_key ──────────────────────────────────────────────
  await run('F  a double-submitted trade (same trader + idempotency_key) is applied once', async () => {
    const hub = await freshHub('f');
    const m = await hub.createMarket({ question: 'idem', ttl_sec: 3600 });
    await hub.registerTrader({ id: 'dup', display_name: 'dup' });
    const a = await hub.placeTrade({ market_id: m.id, trader_id: 'dup', outcome: 0, shares: 5, idempotency_key: 'req-1' });
    const b = await hub.placeTrade({ market_id: m.id, trader_id: 'dup', outcome: 0, shares: 5, idempotency_key: 'req-1' });
    assert.strictEqual(b.replay, true, 'second submit is reported as a replay');
    assert.strictEqual(b.cost, a.cost);
    const rows = await hub._all('SELECT COUNT(*) AS c FROM trades WHERE trader_id = ?', ['dup']);
    assert.strictEqual(rows[0].c, 1, 'only one trade row');
    assert.ok(Math.abs((await hub.getTrader('dup')).capital - (100 - a.cost)) < 1e-9, 'debited once');
    assert.strictEqual((await hub.getMarket(m.id)).q[0], 5, 'q moved once');
    // Concurrent double-submit: still once.
    const pair = await Promise.allSettled([
      hub.placeTrade({ market_id: m.id, trader_id: 'dup', outcome: 1, shares: 2, idempotency_key: 'req-2' }),
      hub.placeTrade({ market_id: m.id, trader_id: 'dup', outcome: 1, shares: 2, idempotency_key: 'req-2' }),
    ]);
    assert.ok(pair.every((r) => r.status === 'fulfilled'), `concurrent replay rejected: ${pair.map((r) => r.reason && r.reason.message)}`);
    assert.strictEqual((await hub.getMarket(m.id)).q[1], 2, 'q moved once under a concurrent double-submit');
    assert.strictEqual((await hub._all('SELECT COUNT(*) AS c FROM trades WHERE trader_id = ?', ['dup']))[0].c, 2);
    // A different trader may reuse the same key string; a different key is a new trade.
    await hub.registerTrader({ id: 'other', display_name: 'other' });
    await hub.placeTrade({ market_id: m.id, trader_id: 'other', outcome: 0, shares: 1, idempotency_key: 'req-1' });
    const c = await hub.placeTrade({ market_id: m.id, trader_id: 'dup', outcome: 0, shares: 5, idempotency_key: 'req-3' });
    assert.notStrictEqual(c.replay, true);
    // Key bounds.
    await assert.rejects(() => hub.placeTrade({ market_id: m.id, trader_id: 'dup', outcome: 0, shares: 1, idempotency_key: 'k'.repeat(65) }), /idempotency_key/);
    await assert.rejects(() => hub.placeTrade({ market_id: m.id, trader_id: 'dup', outcome: 0, shares: 1, idempotency_key: 42 }), /idempotency_key/);
  });

  // ── G. deterministic-id squat ───────────────────────────────────────
  await run('G  a play-tier create cannot squat a labs prediction\'s deterministic market id', async () => {
    const hub = await freshHub('g');
    const meta = { predictionId: 'pred-squat-1', proposedBy: 'obc:attacker' };
    const play = await hub.createMarket({ question: 'squat', ttl_sec: 60, tag: 'custom', source: 'system', metadata: meta });
    // The real registry pipeline files the same prediction as labs-tier (KAX
    // unarmed here, so it stays a SQLite market — but it MUST be a distinct,
    // labs-tagged, oracle-settled market and not the attacker's TTL-resolved one).
    const labs = await hub.createMarket({ question: 'real', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs', metadata: { predictionId: 'pred-squat-1', proposedBy: 'obc:proposer' } });
    assert.notStrictEqual(labs.id, play.id, 'labs create returned the attacker\'s play market');
    assert.strictEqual(labs.tag, 'labs');
    // Labs idempotency is preserved: the retry returns the labs market.
    const again = await hub.createMarket({ question: 'real', ttl_sec: 3600, tag: 'labs', source: 'kannaka-labs', metadata: { predictionId: 'pred-squat-1' } });
    assert.strictEqual(again.id, labs.id);
    // And the id derivation is what the observatory expects (sha256 of prediction:<id>).
    const crypto = require('crypto');
    assert.strictEqual(labs.id, 'm_' + crypto.createHash('sha256').update('prediction:pred-squat-1').digest('hex').slice(0, 12));
  });

  // ── H. registration bounds, dust, stats contract ────────────────────
  await run('H1 registerTrader refuses unusable ids / names / kinds', async () => {
    const hub = await freshHub('h1');
    for (const id of ['', '   ', 'a\nb', 'x'.repeat(129), 42, {}]) {
      await assert.rejects(() => hub.registerTrader({ id, display_name: 'n' }), /id/, `accepted id=${JSON.stringify(id)}`);
    }
    await assert.rejects(() => hub.registerTrader({ id: 'ok', display_name: 'n'.repeat(121) }), /display_name/);
    await assert.rejects(() => hub.registerTrader({ id: 'ok', display_name: 'n', kind: 'ai; DROP' }), /kind/);
    await assert.rejects(() => hub.registerTrader({ id: 'ok', display_name: 'n', kind: null }), /kind/);
    const t = await hub.registerTrader({ id: 'kax:agent:some-bot', display_name: 'Some Bot', kind: 'agent' });
    assert.strictEqual(t.id, 'kax:agent:some-bot');
    const anon = await hub.registerTrader({ display_name: 'anon' });
    assert.ok(/^[0-9a-f]{12}$/.test(anon.id), 'generated id shape');
  });

  await run('H2 a dust trade whose cost rounds to zero is refused', async () => {
    const hub = await freshHub('h2');
    const m = await hub.createMarket({ question: 'dust', ttl_sec: 3600 });
    await hub.registerTrader({ id: 'd', display_name: 'd' });
    await assert.rejects(() => hub.placeTrade({ market_id: m.id, trader_id: 'd', outcome: 0, shares: 1e-18 }), /too small/);
    assert.strictEqual((await hub._all('SELECT COUNT(*) AS c FROM positions'))[0].c, 0);
  });

  await run('H3 getHubStats returns the counters VoiceDJ reads (#285 contract) and rejects on a DB error', async () => {
    const hub = await freshHub('h3');
    await hub.createMarket({ question: 's', ttl_sec: 3600 });
    await hub.registerTrader({ id: 's1', display_name: 's1' });
    const s = await hub.getHubStats();
    assert.deepStrictEqual(s, { traders: 1, markets_total: 1, markets_active: 1, trades_total: 0 });
    const realGet = hub.db.get.bind(hub.db);
    hub.db.get = (sql, ...rest) => { const cb = rest[rest.length - 1]; if (/FROM trades/.test(sql)) return cb(new Error('injected')); return realGet(sql, ...rest); };
    await assert.rejects(() => hub.getHubStats(), /injected/);
    hub.db.get = realGet;
  });

  if (failed) { console.error(`\n${failed} hub-hardening test(s) FAILED`); process.exitCode = 1; }
  else console.log('\nAll ghostsignals-hub-hardening tests passed');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
