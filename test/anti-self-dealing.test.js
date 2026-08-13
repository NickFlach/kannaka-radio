'use strict';

// ADR-0041 anti-self-dealing: the principal that proposed a prediction cannot
// trade on its paired market (metadata.proposedBy). Inert on ordinary markets.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { GhostSignalsHub } = require('../server/ghostsignals-hub');

function tmpDbPath() {
  const dir = path.join(os.tmpdir(), 'gshub-selfdeal-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

async function run() {
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
  await hub.init();
  const alice = 'kax:agent:alice'; // the proposer
  const bob = 'kax:agent:bob';
  await hub.registerTrader({ id: alice, display_name: 'Alice', kind: 'ai' });
  await hub.registerTrader({ id: bob, display_name: 'Bob', kind: 'ai' });

  // Labs market whose prediction Alice proposed.
  const m = await hub.createMarket({
    question: 'self-deal guard',
    outcomes: ['Yes', 'No'],
    ttl_sec: 3600,
    tag: 'labs',
    source: 'kannaka-labs',
    metadata: { proposedBy: alice, predictionId: 'pred-1' },
  });

  // Alice (the proposer) is blocked from trading her own market.
  await assert.rejects(
    () => hub.placeTrade({ market_id: m.id, trader_id: alice, outcome: 0, shares: 2 }),
    /self-dealing blocked/,
    'proposer must not trade own market',
  );

  // Bob (not the proposer) trades freely.
  const t = await hub.placeTrade({ market_id: m.id, trader_id: bob, outcome: 0, shares: 2 });
  assert.ok(t && t.cost > 0, 'non-proposer can trade');

  // An ordinary market with no proposedBy is unaffected — Alice trades fine.
  const plain = await hub.createMarket({ question: 'plain', outcomes: ['Yes', 'No'], ttl_sec: 3600, tag: 'custom' });
  const t2 = await hub.placeTrade({ market_id: plain.id, trader_id: alice, outcome: 0, shares: 2 });
  assert.ok(t2 && t2.cost > 0, 'self-deal guard is inert on non-labs markets');

  // ── The REAL prod path (was a dead guard): the OBC door stamps proposedBy as
  // `obc:<bot>`, but the SAME bot trades labs-tier as `kax:agent:<bot>` (the id
  // is derived from its KAX token, not the body). A bare string compare never
  // matched, so the proposer could trade — and front-run — its own funded market.
  // This is the case the previous test never exercised.
  const carol = 'carol-bot-id';
  await hub.registerTrader({ id: `kax:agent:${carol}`, display_name: 'Carol', kind: 'agent' });
  const obcMarket = await hub.createMarket({
    question: 'obc-door market',
    outcomes: ['Yes', 'No'],
    ttl_sec: 3600,
    tag: 'labs',
    source: 'kannaka-labs',
    metadata: { proposedBy: `obc:${carol}`, predictionId: 'pred-obc-1' },
  });
  await assert.rejects(
    () => hub.placeTrade({ market_id: obcMarket.id, trader_id: `kax:agent:${carol}`, outcome: 0, shares: 2 }),
    /self-dealing blocked/,
    'OBC-door proposer (obc:<bot>) must be blocked when trading as kax:agent:<bot> — the SAME operator',
  );
  // A different bot trades that same OBC-door market freely.
  await hub.registerTrader({ id: 'kax:agent:dave-bot-id', display_name: 'Dave', kind: 'agent' });
  const t3 = await hub.placeTrade({ market_id: obcMarket.id, trader_id: 'kax:agent:dave-bot-id', outcome: 0, shares: 2 });
  assert.ok(t3 && t3.cost > 0, 'a non-proposer bot can trade an OBC-door market');

  // Guard against the collapse being too greedy: a kax:user proposer is NOT the
  // same operator as a kax:agent whose bot_id happens to equal the user's sub.
  const userMarket = await hub.createMarket({
    question: 'user-proposed market',
    outcomes: ['Yes', 'No'],
    ttl_sec: 3600,
    tag: 'labs',
    source: 'kannaka-labs',
    metadata: { proposedBy: 'kax:user:eve', predictionId: 'pred-user-1' },
  });
  await hub.registerTrader({ id: 'kax:agent:eve', display_name: 'EveAgent', kind: 'agent' });
  const t4 = await hub.placeTrade({ market_id: userMarket.id, trader_id: 'kax:agent:eve', outcome: 0, shares: 2 });
  assert.ok(t4 && t4.cost > 0, 'kax:user:eve and kax:agent:eve are distinct operators — not a self-deal');

  console.log('ok  proposer blocked; non-proposer allowed; inert on plain markets');
  console.log('ok  OBC-door obc:<bot> vs kax:agent:<bot> self-deal is now BLOCKED (was the live hole)');
  console.log('ok  kax:user vs kax:agent same-tail is NOT collapsed');
  console.log('\nPASSED anti-self-dealing.test.js');
}

run().catch((e) => { console.error('\nFAILED anti-self-dealing.test.js:', e.stack || e.message); process.exitCode = 1; });
