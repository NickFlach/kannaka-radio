'use strict';

// read-body-utf8.test.js — readBody must reconstruct a multibyte UTF-8 char
// split across chunk boundaries. This is money-critical: the Stripe webhook's
// HMAC is over the exact bytes, so a corrupted re-encode fails verification and
// silently drops the paid signal (review B1). Node's 16KB highWaterMark makes
// the boundary deterministic, so a >16KB event with a multibyte char at the
// boundary would fail EVERY redelivery.

const assert = require('assert');
const { EventEmitter } = require('events');
const { readBody } = require('../server/utils');

function fakeReq(chunks) {
  const r = new EventEmitter();
  r.destroy = () => {};
  setImmediate(() => { for (const c of chunks) r.emit('data', c); r.emit('end'); });
  return r;
}
function fakeRes() { let code = 0; return { writeHead(c) { code = c; }, end() {}, get code() { return code; } }; }

let failed = 0;
function run(name, fn) {
  return new Promise((resolve) => {
    const done = () => { console.log(`  ok  ${name}`); resolve(); };
    const fail = (e) => { console.error(`  FAIL ${name}: ${e.message}`); failed++; resolve(); };
    try { fn(done, fail); } catch (e) { fail(e); }
  });
}

(async () => {
  console.log('read-body-utf8.test.js');

  await run('multibyte char split across two chunks is reconstructed exactly', (done, fail) => {
    const buf = Buffer.from('a—b', 'utf8'); // em dash U+2014 = E2 80 94
    // Split INSIDE the em dash: [61 E2] | [80 94 62].
    const req = fakeReq([buf.slice(0, 2), buf.slice(2)]);
    readBody(req, fakeRes(), (body) => {
      try { assert.strictEqual(body, 'a—b'); done(); } catch (e) { fail(e); }
    });
  });

  await run('a realistic JSON body with a — split at the boundary round-trips', (done, fail) => {
    const json = JSON.stringify({ name: 'Kannaka Radio ad — 7-day run', amount: 500 });
    const buf = Buffer.from(json, 'utf8');
    const dash = buf.indexOf(0xe2); // first byte of the em dash
    const req = fakeReq([buf.slice(0, dash + 1), buf.slice(dash + 1)]); // split mid-dash
    readBody(req, fakeRes(), (body) => {
      try {
        assert.strictEqual(body, json, 'exact bytes preserved');
        assert.deepStrictEqual(JSON.parse(body).name, 'Kannaka Radio ad — 7-day run');
        done();
      } catch (e) { fail(e); }
    });
  });

  await run('a plain ASCII body still works (single chunk)', (done, fail) => {
    const req = fakeReq([Buffer.from('{"ok":true}', 'utf8')]);
    readBody(req, fakeRes(), (body) => {
      try { assert.strictEqual(body, '{"ok":true}'); done(); } catch (e) { fail(e); }
    });
  });

  if (!failed) console.log('\nAll read-body-utf8 tests passed');
  else process.exitCode = 1;
})();
