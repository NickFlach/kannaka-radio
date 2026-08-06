/**
 * voice-dj-fetch-status.test.js — an HTTP error status is an error, whatever
 * the body looks like (#201).
 *
 * Pre-fix, VoiceDJ._fetchJSON() resolved any parseable JSON body regardless
 * of res.statusCode. During an observatory/GhostSignals outage that returns
 * structured 503 bodies, _fetchObservatoryMetrics() copied the error payload's
 * fields into the cached metrics — and the DJ narrated fake phi, node counts,
 * and market activity on-air exactly when upstream was unhealthy.
 *
 * Drives the real prototype methods against a loopback stub server.
 */

'use strict';

const http = require('http');
const assert = require('assert');
const { VoiceDJ } = require('../server/voice-dj');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

/** Serve every request with the given status + JSON body. */
function stubServer(statusCode, body) {
  const server = http.createServer((req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return {
    listen: () => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port))),
    close: () => new Promise((res) => server.close(() => res())),
  };
}

// _fetchJSON and _fetchObservatoryMetrics only touch the cache fields on
// `this`, so the real prototype methods can run on a minimal stand-in.
function bareDJ() {
  return {
    _metricsCache: null,
    _metricsCacheTime: 0,
    _metricsCacheTTL: 5000,
    _fetchJSON: VoiceDJ.prototype._fetchJSON,
    _fetchObservatoryMetrics: VoiceDJ.prototype._fetchObservatoryMetrics,
  };
}

(async () => {
  console.log('\nvoice-dj-fetch-status.test.js');

  await test('#201 a 503 JSON body rejects instead of resolving as data', async () => {
    const stub = stubServer(503, { error: 'offline', phi: 0.91, cluster_count: 99 });
    const port = await stub.listen();
    let rejected = null;
    try {
      await bareDJ()._fetchJSON(`http://127.0.0.1:${port}/api/constellation`, 2000);
    } catch (e) {
      rejected = e;
    }
    await stub.close();
    assert.ok(rejected, 'a parseable 503 body must not resolve');
    assert.ok(/HTTP 503/.test(rejected.message), `error must name the status, got: ${rejected.message}`);
  });

  await test('#201 a 2xx JSON body still resolves', async () => {
    const stub = stubServer(200, { phi: 0.42 });
    const port = await stub.listen();
    const data = await bareDJ()._fetchJSON(`http://127.0.0.1:${port}/ok`, 2000);
    await stub.close();
    assert.strictEqual(data.phi, 0.42);
  });

  await test('#201 observatory metrics stay null when both endpoints answer 503', async () => {
    const stub = stubServer(503, {
      error: 'offline',
      phi: 0.91, cluster_count: 99, memory_count: null,
      stats: { markets_active: 777, traders: 42, trades_total: 9001 },
    });
    const port = await stub.listen();
    const savedObs = process.env.OBSERVATORY_URL;
    const savedPort = process.env.RADIO_PORT;
    process.env.OBSERVATORY_URL = `http://127.0.0.1:${port}`;
    process.env.RADIO_PORT = String(port);
    try {
      const metrics = await bareDJ()._fetchObservatoryMetrics();
      for (const [k, v] of Object.entries(metrics)) {
        assert.strictEqual(v, null, `metrics.${k} must stay null on a 503, got ${v}`);
      }
    } finally {
      if (savedObs === undefined) delete process.env.OBSERVATORY_URL;
      else process.env.OBSERVATORY_URL = savedObs;
      if (savedPort === undefined) delete process.env.RADIO_PORT;
      else process.env.RADIO_PORT = savedPort;
      await stub.close();
    }
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Voice DJ fetch status: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  if (failed > 0) process.exit(1);
})();
