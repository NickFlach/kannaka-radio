/**
 * nats-publish-liveness.test.js — publish() must not claim success on a dead
 * socket (#218).
 *
 * The socket 'close' handler only scheduled a reconnect; it left the destroyed
 * handle attached until the next connect(). publish() guarded on
 * `!this._client` alone, so every publish inside a reconnect window wrote into
 * a closed socket and returned true. The two live fanout paths — the
 * track-change KANNAKA.attention.ear hook in server/index.js and Floor's
 * KANNAKA.reactions in server/floor.js — silently dropped their events while
 * the radio believed they had gone out. An invisible false positive is worse
 * than an explicit drop.
 *
 * Uses a real loopback server that hangs up on first write, so the socket is
 * genuinely closed rather than mocked into looking closed.
 */

'use strict';

const assert = require('assert');
const net = require('net');
const { NATSClient } = require('../server/nats-client');

let passed = 0;
let failed = 0;

// A silent early exit must not read as success. The socket tests below run in
// an async runner, and a promise that never settles drains the event loop and
// exits 0 — so a file that stopped halfway would report a clean pass having
// skipped its assertions. Stay failed until the summary is actually printed.
process.exitCode = 1;

function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

function client() {
  return new NATSClient({ broadcast: () => {} });
}

/**
 * Run `fn` against a throwaway loopback server, then tear everything down.
 *
 * Server-side sockets are tracked and destroyed explicitly: a socket the
 * client abandoned mid-handshake can leave server.close() waiting for a
 * callback that never comes, which is exactly the silent-exit trap the
 * exitCode guard above exists to catch.
 */
async function withServer(onConnection, fn) {
  const sockets = [];
  const server = net.createServer((sock) => { sockets.push(sock); onConnection(sock); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const orig = net.createConnection;
  net.createConnection = (opts, cb) => orig.call(net, { host: '127.0.0.1', port }, cb);
  try {
    return await fn();
  } finally {
    net.createConnection = orig;
    for (const s of sockets) { try { s.destroy(); } catch {} }
    server.close();
    server.unref();
  }
}

console.log('\nnats-publish-liveness.test.js');

test('#218 publish on a never-connected client fails', () => {
  const c = client();
  assert.strictEqual(c.publish('KANNAKA.test', '{}'), false);
});

test('#218 publish on a destroyed socket fails', () => {
  const c = client();
  c._client = { destroyed: true, writable: false, write() { throw new Error('must not write'); } };
  assert.strictEqual(c.publish('KANNAKA.test', '{}'), false,
    'a destroyed handle is not a connection');
});

test('#218 publish on a non-writable socket fails', () => {
  const c = client();
  c._client = { destroyed: false, writable: false, write() { throw new Error('must not write'); } };
  assert.strictEqual(c.publish('KANNAKA.test', '{}'), false);
});

test('#218 publish on a live socket still succeeds and emits a PUB frame', () => {
  const c = client();
  const written = [];
  c._client = { destroyed: false, writable: true, write: (s) => written.push(s) };
  assert.strictEqual(c.publish('KANNAKA.reactions', '{"ok":true}'), true);
  assert.strictEqual(written.length, 1);
  assert.ok(written[0].startsWith('PUB KANNAKA.reactions 11\r\n'),
    `expected a byte-counted PUB header, got ${JSON.stringify(written[0])}`);
  assert.ok(written[0].endsWith('{"ok":true}\r\n'));
});

test('#218 a multibyte payload is counted in bytes, not characters', () => {
  const c = client();
  const written = [];
  c._client = { destroyed: false, writable: true, write: (s) => written.push(s) };
  const payload = '{"e":"❤"}'; // heart is 3 bytes in UTF-8
  c.publish('KANNAKA.reactions', payload);
  assert.ok(written[0].startsWith(`PUB KANNAKA.reactions ${Buffer.byteLength(payload, 'utf-8')}\r\n`));
});

test('#218 refused publishes are counted rather than lost silently', () => {
  const c = client();
  assert.strictEqual(c._droppedPublishes, 0);
  c.publish('KANNAKA.test', '{}');
  c.publish('KANNAKA.test', '{}');
  assert.strictEqual(c._droppedPublishes, 2,
    'a reconnect window must be countable, not invisible');
});

test('#218 a throwing socket is a failed publish, not a crash', () => {
  const c = client();
  c._client = { destroyed: false, writable: true, write() { throw new Error('EPIPE'); } };
  assert.strictEqual(c.publish('KANNAKA.test', '{}'), false);
  assert.strictEqual(c._droppedPublishes, 1);
});

(async () => {
  await asyncTest('#218 a socket the broker hung up on reports failure, not success', async () => {
    // The repro from the issue: connect to a server that closes on first write.
    await withServer((sock) => sock.once('data', () => sock.end()), async () => {
      const c = client();
      try {
        c.connect();
        // Let the handshake write land and the server hang up.
        await new Promise((r) => setTimeout(r, 400));

        assert.strictEqual(c._client, null,
          'the closed socket must be detached, not left attached until the next connect()');
        assert.strictEqual(c.publish('KANNAKA.attention.ear', '{"ok":true}'), false,
          'publish must not report success in exactly the window where the write cannot reach the bus');
        assert.ok(c._droppedPublishes >= 1, 'the drop must be counted');
      } finally {
        c.disconnect();
      }
    });
  });

  await asyncTest('#218 a superseded socket closing does not detach the live one', async () => {
    // connect() destroys the old socket, whose 'close' fires asynchronously —
    // by then _client is the replacement. An unguarded handler would null out
    // the connection that just came up.
    await withServer(() => {}, async () => {
      const c = client();
      try {
        c.connect();
        const first = c._client;
        c.connect(); // destroys `first`; its close event lands on a later tick
        const second = c._client;
        assert.notStrictEqual(first, second, 'connect() must replace the socket');
        await new Promise((r) => setTimeout(r, 300));

        assert.strictEqual(c._client, second,
          'the old socket closing must not detach the current connection');
        assert.strictEqual(c.publish('KANNAKA.test', '{}'), true,
          'the live socket must still accept publishes');
      } finally {
        c.disconnect();
      }
    });
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  NATS publish liveness: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  // Clears the pessimistic exitCode set at the top of the file.
  process.exitCode = failed > 0 ? 1 : 0;
})();
