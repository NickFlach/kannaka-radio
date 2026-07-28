/**
 * voice-dj-endpoints.test.js — the DJ's metrics fetches must follow config,
 * not hardcoded production hosts (#100, #107).
 *
 * Pre-fix, _fetchConstellationMetrics() called two production literals:
 *   https://observatory.ninja-portal.com/api/constellation
 *   https://radio.ninja-portal.com/api/gshub/stats
 *
 * The second is the worse one: /api/gshub/stats is served by THIS radio
 * (server/routes.js), so every non-production install round-tripped to
 * production to read somebody else's stats instead of its own — and a box with
 * no outbound internet just got nulls and a DJ with no numbers to talk about.
 *
 * These drive the real exported resolvers, not a reimplementation.
 */

'use strict';

const assert = require('assert');
const { observatoryBaseUrl, localRadioBaseUrl } = require('../server/voice-dj');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
  finally { process.env = savedEnv; process.argv = savedArgv; }
}

/** Run fn with a specific env/argv shape. */
function withEnv(env, argv, fn) {
  for (const k of ['OBSERVATORY_URL', 'RADIO_PORT', 'PORT']) delete process.env[k];
  Object.assign(process.env, env);
  process.argv = ['node', 'server.js', ...(argv || [])];
  return fn();
}

console.log('\nvoice-dj-endpoints.test.js');

test('#107 Observatory keeps its production default', () => {
  withEnv({}, [], () => {
    assert.strictEqual(observatoryBaseUrl(), 'https://observatory.ninja-portal.com');
  });
});

test('#107 OBSERVATORY_URL overrides the default', () => {
  withEnv({ OBSERVATORY_URL: 'http://obs.local:3334' }, [], () => {
    assert.strictEqual(observatoryBaseUrl(), 'http://obs.local:3334');
  });
});

test('#107 a trailing slash does not produce a double slash in the path', () => {
  withEnv({ OBSERVATORY_URL: 'http://obs.local:3334/' }, [], () => {
    assert.strictEqual(observatoryBaseUrl(), 'http://obs.local:3334');
  });
});

test('#107 a blank OBSERVATORY_URL falls back rather than yielding an empty host', () => {
  withEnv({ OBSERVATORY_URL: '   ' }, [], () => {
    assert.strictEqual(observatoryBaseUrl(), 'https://observatory.ninja-portal.com');
  });
});

test('#100 gshub stats resolve to THIS host, never production', () => {
  withEnv({}, [], () => {
    const u = localRadioBaseUrl();
    assert.ok(u.startsWith('http://127.0.0.1:'), `got ${u}`);
    assert.ok(!u.includes('ninja-portal.com'), 'must not round-trip to production');
  });
});

test('#100 the local port follows the same precedence as the server', () => {
  withEnv({ RADIO_PORT: '7000', PORT: '6000' }, ['--port', '9000'], () => {
    assert.strictEqual(localRadioBaseUrl(), 'http://127.0.0.1:9000', '--port flag wins');
  });
  withEnv({ RADIO_PORT: '7000', PORT: '6000' }, [], () => {
    assert.strictEqual(localRadioBaseUrl(), 'http://127.0.0.1:7000', 'RADIO_PORT beats PORT');
  });
  withEnv({ PORT: '6000' }, [], () => {
    assert.strictEqual(localRadioBaseUrl(), 'http://127.0.0.1:6000', 'PORT used alone');
  });
});

test('#100 default port is 8888, matching server/index.js', () => {
  withEnv({}, [], () => {
    assert.strictEqual(localRadioBaseUrl(), 'http://127.0.0.1:8888');
  });
});

// ── The resolvers must actually be USED ─────────────────────────────────
//
// The tests above only prove the helpers are correct. They pass just as
// happily if the call sites go back to hardcoded literals and never call
// them — I verified that by reverting the call sites and watching all seven
// stay green. So gate the call sites directly, on source.

test('#100/#107 no hardcoded ninja-portal API call remains in voice-dj.js', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server', 'voice-dj.js'), 'utf8');
  const hits = src.match(/https?:\/\/[a-z0-9.-]*ninja-portal\.com\/api\//gi) || [];
  assert.strictEqual(hits.length, 0,
    `hardcoded production API URL(s) reintroduced: ${JSON.stringify(hits)}`);
});

test('#100/#107 the metrics fetch calls the resolvers', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server', 'voice-dj.js'), 'utf8');
  assert.ok(src.includes('${observatoryBaseUrl()}/api/constellation'),
    'constellation fetch should go through observatoryBaseUrl()');
  assert.ok(src.includes('${localRadioBaseUrl()}/api/gshub/stats'),
    'gshub fetch should go through localRadioBaseUrl()');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`  VoiceDJ endpoints: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
