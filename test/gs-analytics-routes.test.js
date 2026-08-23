'use strict';

/**
 * gs-analytics-routes.test.js — the GSA HTTP layer, driven through the REAL
 * routes.js handleRequest with mock req/res (the pattern already used by
 * market-auth-gate / broadcast-endpoint / request-backlog).
 *
 * This suite exists because it was missing: the upload route read
 * `parsed.query` (a WHATWG URL has `searchParams`, not `query`), so `kind` was
 * silently forced to "csv" and `name` to "" — JSON uploads, an advertised v1
 * format, were broken on arrival and every dataset was called "dataset". Unit
 * tests on the store and the engine both passed. One route assertion would
 * have caught it, so here it is, alongside the gate/auth/scoping checks that
 * protect customer data.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const setupRoutes = require('../server/routes');

let failed = 0;
async function run(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; } }

function mockReq(method, url, headers, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = Object.assign({ host: 'localhost' }, headers || {});
  req.socket = { remoteAddress: '10.0.0.7' };
  req.destroy = () => {};
  const origOn = req.on.bind(req);
  req.on = (event, cb) => {
    origOn(event, cb);
    if (event === 'end') {
      setImmediate(() => {
        if (body != null) req.emit('data', Buffer.from(body));
        req.emit('end');
      });
    }
    return req;
  };
  return req;
}

function mockRes() {
  const res = {};
  res.statusCode = null; res.body = ''; res.headers = null;
  res.headersSent = false; res.writableEnded = false;
  res.done = new Promise((r) => { res._resolve = r; });
  res.writeHead = (code, hdrs) => { res.statusCode = code; res.headers = hdrs; res.headersSent = true; };
  res.end = (data) => { if (data) res.body += data; res.writableEnded = true; res._resolve(); };
  return res;
}

/** A fake GSA store recording what the routes actually pass it. */
function fakeGsa({ ready = true, account = { adId: 'ad_owner01' } } = {}) {
  const calls = { created: [], deleted: [], got: [] };
  return {
    calls,
    ready: () => ready,
    runner: { depth: () => 0, analyze: async () => ({ ok: true, report: { rowCount: 1, signals: [], caveats: [] } }) },
    store: {
      auth: async (t) => (t === 'good-token-aaaaaaaaaaaaaaaaaaaa' ? account : null),
      listDatasets: async () => [],
      createDataset: async (acct, d) => { calls.created.push({ acct, d }); return { ok: true, id: 'ds_abcdefghij', name: d.name }; },
      getDataset: async (adId, id) => { calls.got.push({ adId, id }); return adId === 'ad_owner01' ? { id, ad_id: adId, kind: 'csv', status: 'ready', report: '{"rowCount":1,"signals":[]}' } : undefined; },
      deleteDataset: async (adId, id) => { calls.deleted.push({ adId, id }); return adId === 'ad_owner01' ? { ok: true } : { ok: false, error: 'not_found' }; },
      markAnalyzing: async () => true,
      markReady: async () => {},
      markFailed: async () => {},
      redeem: async () => ({ ok: true, token: 'tok', expiresAt: '2026-09-22 00:00:00' }),
      readBlob: async () => 'a,b\n1,2\n',
    },
  };
}

function handler(gsa) {
  return setupRoutes({
    gsa,
    broadcast: () => {},
    djEngine: { state: {} },
    config: { baseDir: __dirname, spaPath: __dirname, getMusicDir: () => __dirname },
  });
}

async function call(h, method, url, headers, body) {
  const req = mockReq(method, url, headers, body);
  const res = mockRes();
  await h(req, res);
  await res.done;
  return res;
}

const AUTH = { authorization: 'Bearer good-token-aaaaaaaaaaaaaaaaaaaa' };

(async () => {
  console.log('gs-analytics-routes.test.js');

  await run('a JSON upload is stored as kind=json with its name (the parsed.query bug)', async () => {
    const gsa = fakeGsa();
    const res = await call(handler(gsa), 'POST', '/api/gsa/datasets?kind=json&name=June%20sales', AUTH, '[{"a":1}]');
    assert.strictEqual(res.statusCode, 202, res.body);
    assert.strictEqual(gsa.calls.created.length, 1);
    assert.strictEqual(gsa.calls.created[0].d.kind, 'json', 'kind must come from searchParams, not the non-existent .query');
    assert.strictEqual(gsa.calls.created[0].d.name, 'June sales', 'name must survive (and be URL-decoded)');
  });

  await run('a CSV upload defaults correctly', async () => {
    const gsa = fakeGsa();
    await call(handler(gsa), 'POST', '/api/gsa/datasets?kind=csv&name=x', AUTH, 'a,b\n1,2\n');
    assert.strictEqual(gsa.calls.created[0].d.kind, 'csv');
    // An unknown kind must fall back to csv rather than reaching the store raw.
    const gsa2 = fakeGsa();
    await call(handler(gsa2), 'POST', '/api/gsa/datasets?kind=exe', AUTH, 'a,b\n1,2\n');
    assert.strictEqual(gsa2.calls.created[0].d.kind, 'csv');
  });

  await run('503 on every GSA route until the store is ready', async () => {
    const gsa = fakeGsa({ ready: false });
    for (const [m, u] of [['GET', '/api/gsa/me'], ['POST', '/api/gsa/redeem'], ['GET', '/api/gsa/datasets']]) {
      const res = await call(handler(gsa), m, u, AUTH, '{}');
      assert.strictEqual(res.statusCode, 503, `${m} ${u}`);
    }
  });

  await run('401 without a bearer, and with a garbage bearer', async () => {
    const h = handler(fakeGsa());
    assert.strictEqual((await call(h, 'GET', '/api/gsa/me', {})).statusCode, 401);
    assert.strictEqual((await call(h, 'GET', '/api/gsa/me', { authorization: 'Bearer nope' })).statusCode, 401);
    assert.strictEqual((await call(h, 'GET', '/api/gsa/me', { authorization: 'Basic zzz' })).statusCode, 401);
  });

  await run('cross-account: B cannot read or delete A\'s dataset THROUGH the routes', async () => {
    const gsa = fakeGsa({ account: { adId: 'ad_other99' } }); // authenticated as someone else
    const h = handler(gsa);
    const get = await call(h, 'GET', '/api/gsa/reports/ds_abcdefghij', AUTH);
    assert.strictEqual(get.statusCode, 404, 'no cross-account read');
    assert.strictEqual(gsa.calls.got[0].adId, 'ad_other99', 'the store is queried with the CALLER account, never the URL owner');
    const del = await call(h, 'DELETE', '/api/gsa/datasets/ds_abcdefghij', AUTH);
    assert.strictEqual(del.statusCode, 404, 'no cross-account delete');
    assert.strictEqual(gsa.calls.deleted[0].adId, 'ad_other99');
  });

  await run('redeem is public (no bearer needed) and returns the token', async () => {
    const res = await call(handler(fakeGsa()), 'POST', '/api/gsa/redeem', {}, JSON.stringify({ adId: 'ad_x1234567' }));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(/"token"/.test(res.body));
  });

  await run('a malformed dataset id does not reach the store', async () => {
    const gsa = fakeGsa();
    const res = await call(handler(gsa), 'GET', '/api/gsa/reports/..%2F..%2Fetc%2Fpasswd', AUTH);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(gsa.calls.got.length, 0, 'the id regex rejected it before any store call');
  });

  await run('an unknown GSA endpoint 404s rather than falling through', async () => {
    const res = await call(handler(fakeGsa()), 'GET', '/api/gsa/nope', AUTH);
    assert.strictEqual(res.statusCode, 404);
  });

  if (!failed) console.log('\nAll gs-analytics-routes tests passed');
  else process.exitCode = 1;
})();
