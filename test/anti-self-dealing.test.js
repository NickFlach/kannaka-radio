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

  console.log('ok  proposer blocked; non-proposer allowed; inert on plain markets');
  console.log('\nPASSED anti-self-dealing.test.js');
}

run().catch((e) => { console.error('\nFAILED anti-self-dealing.test.js:', e.stack || e.message); process.exitCode = 1; });
