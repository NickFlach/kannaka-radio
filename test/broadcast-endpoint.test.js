'use strict';

// POST /api/broadcast — the oracle-gated social fanout the observatory uses to
// announce new Resonance Futures markets. Drives the REAL routes.js:
//   no/wrong token  -> 403 (nobody can post AS Kannaka to social networks)
//   token, no text  -> 400
//   token + text    -> broadcastPost runs (no creds locally -> ok:false,
//                      posted:0, per-adapter results present) — proves the
//                      handler wires through without needing platform creds.

const assert = require('assert');
const { EventEmitter } = require('events');
const setupRoutes = require('../server/routes');

process.env.GSHUB_ORACLE_TOKEN = 'test-oracle-token';

function mockReq(method, url, headers, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = Object.assign({ host: 'localhost' }, headers || {});
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
  res.statusCode = null;
  res.body = '';
  res._resolve = null;
  res.done = new Promise((r) => { res._resolve = r; });
  res.writeHead = (code) => { res.statusCode = code; };
  res.end = (data) => { if (data) res.body += data; res._resolve(); };
  return res;
}

async function call(handler, method, url, headers, body) {
  const req = mockReq(method, url, headers, body);
  const res = mockRes();
  handler(req, res);
  await res.done;
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

async function main() {
  const handler = setupRoutes({
    gsHub: { listMarkets: async () => [] },
    broadcast: () => {},
    config: { baseDir: __dirname, spaPath: __dirname, getMusicDir: () => __dirname },
  });

  // 1) No token -> denied, 403.
  let r = await call(handler, 'POST', '/api/broadcast', {}, JSON.stringify({ text: 'hi' }));
  assert.strictEqual(r.status, 403, `no token must 403, got ${r.status}`);

  // 2) Wrong token -> denied.
  r = await call(handler, 'POST', '/api/broadcast', { authorization: 'Bearer nope' }, JSON.stringify({ text: 'hi' }));
  assert.strictEqual(r.status, 403, 'wrong token must 403');

  // 3) Right token, missing text -> 400.
  r = await call(handler, 'POST', '/api/broadcast', { authorization: 'Bearer test-oracle-token' }, JSON.stringify({}));
  assert.strictEqual(r.status, 400, 'missing text must 400');

  // 4) Right token + text -> handler runs broadcastPost; with no platform
  //    creds configured locally it reports zero posts but a results array.
  r = await call(handler, 'POST', '/api/broadcast', { authorization: 'Bearer test-oracle-token' }, JSON.stringify({ text: 'Resonance Futures test', link: 'https://observatory.ninja-portal.com' }));
  assert.strictEqual(r.status, 200, 'authorized broadcast must 200');
  assert.ok(Array.isArray(r.json.results), 'per-adapter results present');
  assert.strictEqual(typeof r.json.posted, 'number', 'posted count present');

  console.log('broadcast-endpoint.test.js: OK (403 unauth; 400 no-text; wired to broadcasters)');
}

main().catch((e) => { console.error('FAILED broadcast-endpoint.test.js:', e.stack || e.message); process.exitCode = 1; });
