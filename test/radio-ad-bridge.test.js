'use strict';

// radio-ad-bridge.test.js — the radio side of the radio↔KAX bridge against a
// real store, a fake KAX (post), a fake VoiceDJ, and real payments over a fake
// Stripe. Covers: render-at-paid + raise enqueue + delivery (retry on failure),
// and the enact path (approve→schedule, reject→refund) idempotent + guarded.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RadioAdStore } = require('../server/radio-ads');
const { RadioAdPayments } = require('../server/radio-ad-payments');
const { RadioAdBridge } = require('../server/radio-ad-bridge');
const { signBridge } = require('../server/radio-ad-bridge-core');

const RAISE = 'raise_secret_A';
const ENACT = 'enact_secret_B';
const NOWMS = 1_800_000_000_000;
const NOWSEC = Math.floor(NOWMS / 1000);

const fakeVoiceDJ = {
  generateTTS(text, cb) {
    const p = path.join(os.tmpdir(), 'bridge-tts-' + crypto.createHash('md5').update(text).digest('hex').slice(0, 8) + '.mp3');
    fs.writeFileSync(p, 'ID3-fake');
    setImmediate(() => cb(null, p, text));
  },
};

let failed = 0;
async function run(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; } }

async function paidAd(store, payments, text, band = 'morning') {
  const d = await store.createDraft({ text, band });
  await store.markPaid(d.id, { sessionId: 'cs_' + d.id, paymentIntent: 'pi_' + d.id, amountCents: 500 });
  return d.id;
}

(async () => {
  console.log('radio-ad-bridge.test.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-bridge-'));
  const store = new RadioAdStore({ dbPath: path.join(tmp, 'radio-ads.db'), assetDir: path.join(tmp, 'ads') });
  await store.init();
  const payments = new RadioAdPayments({ store, api: { async createRefund() { return { id: 're_1' }; } }, webhookSecret: 'w', now: () => NOWMS });

  await run('tick renders paid ads + enqueues + delivers the raise (paid→pending)', async () => {
    const posts = [];
    const bridge = new RadioAdBridge({ store, payments, voiceDJ: fakeVoiceDJ, raiseUrl: 'https://kax/raise', raiseSecret: RAISE, enactSecret: ENACT, now: () => NOWMS, post: async (url, body, headers) => { posts.push({ url, body, headers }); return { status: 200 }; } });
    const id = await paidAd(store, payments, 'Buy fresh widgets from Acme today please');
    let ad = await store.getAd(id);
    assert.strictEqual(ad.tts_file, null, 'unrendered at paid');
    await bridge.tick();
    ad = await store.getAd(id);
    assert.ok(ad.tts_file, 'rendered at paid (M3)');
    assert.strictEqual(ad.status, 'pending', 'raise delivered → paid→pending');
    assert.strictEqual(posts.length, 1, 'one raise POST');
    assert.ok(posts[0].headers['X-Radio-Signature'], 'raise is signed');
    assert.strictEqual(JSON.parse(posts[0].body).adId, id, 'payload carries ad id');
    const outbox = await store._all(`SELECT * FROM radio_ad_outbox WHERE ad_id=?`, [id]);
    assert.strictEqual(outbox.length, 1);
    assert.ok(outbox[0].delivered_at, 'marked delivered');
  });

  await run('enqueue is idempotent (UNIQUE ad_id,kind); a 2nd tick does not re-deliver', async () => {
    const posts = [];
    const bridge = new RadioAdBridge({ store, payments, voiceDJ: fakeVoiceDJ, raiseUrl: 'https://kax/raise', raiseSecret: RAISE, enactSecret: ENACT, now: () => NOWMS, post: async (u, b, h) => { posts.push(b); return { status: 200 }; } });
    const id = await paidAd(store, payments, 'A second advertisement for the idempotency test');
    await bridge.tick();
    await bridge.tick(); // delivered rows are skipped; ad is now pending (no longer paidWithoutRaise)
    const outbox = await store._all(`SELECT * FROM radio_ad_outbox WHERE ad_id=?`, [id]);
    assert.strictEqual(outbox.length, 1, 'exactly one raise row');
  });

  await run('a failed delivery bumps attempts + backoff and retries (never terminal)', async () => {
    let fail = true;
    const bridge = new RadioAdBridge({ store, payments, voiceDJ: fakeVoiceDJ, raiseUrl: 'https://kax/raise', raiseSecret: RAISE, enactSecret: ENACT, now: () => NOWMS, post: async () => (fail ? { status: 502 } : { status: 200 }) });
    const id = await paidAd(store, payments, 'A spot whose first delivery to KAX fails hard');
    await bridge.tick();
    let row = (await store._all(`SELECT * FROM radio_ad_outbox WHERE ad_id=?`, [id]))[0];
    assert.strictEqual(row.delivered_at, null, 'not delivered');
    assert.strictEqual(row.attempts, 1, 'attempt recorded');
    assert.ok(row.next_attempt_at, 'backoff scheduled');
    assert.strictEqual((await store.getAd(id)).status, 'paid', 'still paid (not raised)');
    // Backoff not elapsed → next tick does NOT retry.
    await bridge.tick();
    row = (await store._all(`SELECT * FROM radio_ad_outbox WHERE ad_id=?`, [id]))[0];
    assert.strictEqual(row.attempts, 1, 'held off during backoff');
    // Recover: past backoff + KAX healthy → delivers.
    fail = false;
    const bridge2 = new RadioAdBridge({ store, payments, voiceDJ: fakeVoiceDJ, raiseUrl: 'https://kax/raise', raiseSecret: RAISE, enactSecret: ENACT, now: () => NOWMS + 10 * 60_000, post: async () => ({ status: 200 }) });
    await bridge2.tick();
    row = (await store._all(`SELECT * FROM radio_ad_outbox WHERE ad_id=?`, [id]))[0];
    assert.ok(row.delivered_at, 'delivered after backoff');
    assert.strictEqual((await store.getAd(id)).status, 'pending');
  });

  await run('enact APPROVE renders+schedules; idempotent; bad sig 401', async () => {
    const bridge = new RadioAdBridge({ store, payments, voiceDJ: fakeVoiceDJ, raiseSecret: RAISE, enactSecret: ENACT, now: () => NOWMS, post: async () => ({ status: 200 }) });
    const id = await paidAd(store, payments, 'An approved spot that should schedule and air');
    await store.renderAd(id, fakeVoiceDJ); // render-at-paid analog
    await store.markRaised(id); // paid→pending (decision time)
    const body = JSON.stringify({ adId: id, decision: 'approve' });
    // Bad signature → 401, nothing changes.
    const bad = await bridge.handleEnact(body, signBridge(body, 'wrong', NOWSEC));
    assert.strictEqual(bad.status, 401);
    assert.strictEqual((await store.getAd(id)).status, 'pending');
    // Good signature → scheduled.
    const ok = await bridge.handleEnact(body, signBridge(body, ENACT, NOWSEC));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await store.getAd(id)).status, 'scheduled');
    // Idempotent re-drive → 200 already, still scheduled.
    const again = await bridge.handleEnact(body, signBridge(body, ENACT, NOWSEC));
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.already, true);
  });

  await run('enact REJECT rejects+refunds; idempotent', async () => {
    const bridge = new RadioAdBridge({ store, payments, voiceDJ: fakeVoiceDJ, raiseSecret: RAISE, enactSecret: ENACT, now: () => NOWMS, post: async () => ({ status: 200 }) });
    const id = await paidAd(store, payments, 'A rejected spot that must be refunded in full');
    await store.markRaised(id);
    const body = JSON.stringify({ adId: id, decision: 'reject' });
    const out = await bridge.handleEnact(body, signBridge(body, ENACT, NOWSEC));
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.refunded, true);
    const ad = await store.getAd(id);
    assert.strictEqual(ad.status, 'refunded');
    assert.ok(ad.refunded_at);
    // Idempotent re-drive.
    const again = await bridge.handleEnact(body, signBridge(body, ENACT, NOWSEC));
    assert.strictEqual(again.status, 200);
  });

  await run('enact APPROVE on a refunded ad is refused (409, terminal) — no schedule', async () => {
    const bridge = new RadioAdBridge({ store, payments, voiceDJ: fakeVoiceDJ, raiseSecret: RAISE, enactSecret: ENACT, now: () => NOWMS });
    const id = await paidAd(store, payments, 'A spot that gets refunded then a stray approve arrives');
    await store.renderAd(id, fakeVoiceDJ);
    await store.rejectAd(id);
    await payments.refundAd(id); // now refunded
    const body = JSON.stringify({ adId: id, decision: 'approve' });
    const out = await bridge.handleEnact(body, signBridge(body, ENACT, NOWSEC));
    assert.strictEqual(out.status, 409, 'terminal → needs-action, never schedules a refunded ad');
    assert.strictEqual((await store.getAd(id)).status, 'refunded');
  });

  await run('enact rejects malformed body (400) and is inert without a secret (503)', async () => {
    const bridge = new RadioAdBridge({ store, payments, voiceDJ: fakeVoiceDJ, raiseSecret: RAISE, enactSecret: ENACT, now: () => NOWMS });
    const notJson = 'not json at all';
    const out = await bridge.handleEnact(notJson, signBridge(notJson, ENACT, NOWSEC));
    assert.strictEqual(out.status, 400);
    const bare = new RadioAdBridge({ store, payments, now: () => NOWMS }); // no enactSecret
    assert.strictEqual(bare.enactConfigured(), false);
    const o2 = await bare.handleEnact('{}', 't=1,v1=x');
    assert.strictEqual(o2.status, 503);
  });

  store.db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (!failed) console.log('\nAll radio-ad-bridge tests passed');
  else process.exitCode = 1;
})();
