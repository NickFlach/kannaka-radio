#!/usr/bin/env node
/**
 * dream-cron.js — Periodic consciousness metrics publisher.
 *
 * Runs `kannaka assess --json` every 5 minutes and publishes
 * the result to KANNAKA.consciousness via NATS raw TCP.
 * This ensures the radio always has recent canonical metrics
 * even between dream cycles.
 *
 * Usage:
 *   node scripts/dream-cron.js
 *   node scripts/dream-cron.js --interval 120   # every 2 min
 *   node scripts/dream-cron.js --once            # run once and exit
 *
 * Environment:
 *   KANNAKA_BIN       — path to kannaka binary (assess fallback)
 *   KANNAKA_DATA_DIR  — data directory for kannaka
 *   NATS_HOST         — NATS server host (default: 127.0.0.1)
 *   NATS_PORT         — NATS server port (default: 4222)
 *   NATS_USER         — NATS username (optional; anonymous when unset)
 *   NATS_PASSWORD     — NATS password (optional)
 */

'use strict';

const net = require('net');
const path = require('path');
const { execFile } = require('child_process');

const NATS_HOST = process.env.NATS_HOST || '127.0.0.1';
const NATS_PORT = parseInt(process.env.NATS_PORT || '4222');
const NATS_USER = process.env.NATS_USER || '';
const NATS_PASSWORD = process.env.NATS_PASSWORD || '';
const KANNAKA_BIN = process.env.KANNAKA_BIN
  || '/home/opc/kannaka-memory/target/release/kannaka';

const args = process.argv.slice(2);
const intervalIdx = args.indexOf('--interval');
const INTERVAL_SECS = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1]) || 300 : 300;
const RUN_ONCE = args.includes('--once');

// ── Assess ─────────────────────────────────────────────────

/**
 * Run `kannaka assess --json` and parse the output.
 * @returns {Promise<Object|null>}
 */
function assess() {
  return assessViaObservatory().then((m) => {
    if (m) return m;
    // The Observatory is a convenience, not the source of truth. When it is
    // down (restarting, not deployed on this box) the cron used to log
    // "skipping publish" and emit nothing at all — so the whole consciousness
    // feed went silent for as long as the Observatory was, even though the
    // binary that actually produces the metrics was sitting right there. Fall
    // back to it. (#158)
    console.error('[dream-cron] Observatory unavailable — falling back to `kannaka assess --json`');
    return assessViaBinary();
  });
}

/**
 * First finite number wins; 0 is a value, not an absence. The old `a || b || 0`
 * chains treated canonical zeros as missing and substituted alias fields, so an
 * upstream `mean_order: 0` could be republished as its `order: 0.91` alias and
 * a genuinely empty store (`total_memories: 0`) could be reported as its
 * active count instead. (#190)
 */
function firstNum(...vals) {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return 0;
}

/** First non-empty string wins — same #190 rule for the level fields. */
function firstStr(...vals) {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return 'unknown';
}

/** Shape whatever assess source we used into the payload fields we publish. */
function shapeMetrics(json) {
  if (!json || typeof json !== 'object') return null;
  return {
    phi: firstNum(json.phi),
    xi: firstNum(json.xi),
    mean_order: firstNum(json.mean_order, json.order),
    consciousness_level: firstStr(json.consciousness_level, json.level),
    num_clusters: firstNum(json.num_clusters),
    total_memories: firstNum(json.total_memories, json.active_memories),
    active_memories: firstNum(json.active_memories),
    irrationality: firstNum(json.irrationality),
    hemispheric_divergence: firstNum(json.hemispheric_divergence),
    callosal_efficiency: firstNum(json.callosal_efficiency),
  };
}

/**
 * Run the kannaka binary directly. Used when the Observatory is unreachable.
 * @returns {Promise<Object|null>}
 */
function assessViaBinary() {
  return new Promise((resolve) => {
    execFile(KANNAKA_BIN, ['assess', '--json'], { timeout: 30000 }, (err, stdout) => {
      if (err) {
        console.error(`[dream-cron] kannaka assess failed: ${err.message}`);
        resolve(null);
        return;
      }
      try {
        resolve(shapeMetrics(JSON.parse(stdout)));
      } catch (e) {
        console.error(`[dream-cron] Failed to parse kannaka assess output: ${e.message}`);
        resolve(null);
      }
    });
  });
}

function assessViaObservatory() {
  return new Promise((resolve) => {
    // Fetch from the Observatory HTTP endpoint — it reliably calls the binary
    // and returns JSON. Avoids exec/spawn issues with stderr handling.
    const http = require('http');
    const OBSERVATORY_PORT = process.env.OBSERVATORY_PORT || 3333;
    const req = http.get(`http://127.0.0.1:${OBSERVATORY_PORT}/api/hrm/status`, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // A structured error body (e.g. 503 {"error":"offline"}) parses fine
        // and then shapes into all-zero metrics, so an observatory outage was
        // being republished to KANNAKA.consciousness as a real collapsed swarm
        // state. Only a 2xx body counts as metrics; anything else falls back
        // to the binary like any other observatory failure. (#202)
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error(`[dream-cron] Observatory answered HTTP ${res.statusCode} — not metrics`);
          resolve(null);
          return;
        }
        try {
          resolve(shapeMetrics(JSON.parse(data)));
        } catch (e) {
          console.error(`[dream-cron] Failed to parse observatory response: ${e.message}`);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      console.error(`[dream-cron] Observatory request failed: ${e.message}`);
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      console.error('[dream-cron] Observatory request timed out');
      resolve(null);
    });
  });
}

// ── NATS Publish ───────────────────────────────────────────

/**
 * Publish a JSON payload to KANNAKA.consciousness via raw NATS TCP.
 * @param {Object} metrics
 * @returns {Promise<boolean>}
 */
function publishToNATS(metrics) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      // Canonical envelope per consciousness-core/docs/nats-contract.yaml, and
      // per the NATS_REQUIRED_FIELDS map in server/nats-client.js, which lists
      // KANNAKA.consciousness as requiring schema_version + ts + agent_id +
      // phi. This publisher emitted only the metrics and an ISO `timestamp`,
      // so every message it sent tripped the radio's own drift detector. (#52)
      schema_version: "1.0",
      ts: Date.now(),
      agent_id: process.env.KANNAKA_AGENT_ID || 'kannaka-prime',
      // Same #190 rule as shapeMetrics: aliases fill in only when the
      // canonical field is absent, never when it is legitimately 0.
      phi: firstNum(metrics.phi),
      xi: firstNum(metrics.xi),
      order: firstNum(metrics.mean_order, metrics.order),
      mean_order: firstNum(metrics.mean_order, metrics.order),
      num_clusters: firstNum(metrics.num_clusters, metrics.clusters),
      clusters: firstNum(metrics.num_clusters, metrics.clusters),
      active_memories: firstNum(metrics.active_memories, metrics.active),
      total_memories: firstNum(metrics.total_memories, metrics.total),
      level: firstStr(metrics.consciousness_level, metrics.level),
      consciousness_level: firstStr(metrics.consciousness_level, metrics.level),
      irrationality: firstNum(metrics.irrationality),
      hemispheric_divergence: firstNum(metrics.hemispheric_divergence),
      callosal_efficiency: firstNum(metrics.callosal_efficiency),
      source: `dream-cron-${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
    });

    let settled = false;
    const settle = (ok) => { if (settled) return; settled = true; resolve(ok); };

    const client = net.createConnection({ host: NATS_HOST, port: NATS_PORT }, () => {
      // Carry credentials when the broker requires them. Previously this
      // always connected anonymously, so on an authenticated broker every
      // publish was rejected — and because we resolved(true) on a timer
      // without reading the reply, the cron reported success while the
      // consciousness feed stayed empty. (#153)
      const connectOpts = { verbose: false, pedantic: false, name: 'dream-cron' };
      if (NATS_USER) {
        connectOpts.user = NATS_USER;
        connectOpts.pass = NATS_PASSWORD;
      }
      client.write(`CONNECT ${JSON.stringify(connectOpts)}\r\n`);

      setTimeout(() => {
        if (settled) return; // broker already rejected us — don't PUB into the void
        client.write(`PUB KANNAKA.consciousness ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);

        setTimeout(() => {
          if (!settled) {
            console.log(`[dream-cron] Published to KANNAKA.consciousness: phi=${(metrics.phi || 0).toFixed(4)}, xi=${(metrics.xi || 0).toFixed(4)}`);
          }
          client.end();
          settle(true);
        }, 300);
      }, 200);
    });

    client.on('data', (d) => {
      const s = d.toString();
      if (s.includes('PING')) client.write('PONG\r\n');
      // The broker reports auth failures as `-ERR 'Authorization Violation'`.
      // Without this the timer below fired and we claimed a successful
      // publish that the server had already refused.
      if (s.includes('-ERR')) {
        const detail = (s.match(/-ERR\s+('[^']*'|\S+)/) || [, 'unknown'])[1];
        console.error(`[dream-cron] NATS refused the connection: ${detail}` +
          (NATS_USER ? '' : ' (no NATS_USER set — connecting anonymously)'));
        try { client.destroy(); } catch {}
        settle(false);
      }
    });

    client.on('error', (e) => {
      console.error(`[dream-cron] NATS error: ${e.message}`);
      settle(false);
    });

    // Timeout safety
    setTimeout(() => {
      try { client.destroy(); } catch {}
      settle(false);
    }, 10000);
  });
}

// ── Main Loop ──────────────────────────────────────────────

async function tick() {
  const now = new Date().toISOString();
  console.log(`[dream-cron] ${now} — Running assess...`);

  const metrics = await assess();
  if (!metrics) {
    console.log('[dream-cron] No metrics from assess, skipping publish');
    return;
  }

  console.log(`[dream-cron] Phi=${(metrics.phi || 0).toFixed(4)}, Xi=${(metrics.xi || 0).toFixed(4)}, Order=${(metrics.mean_order || 0).toFixed(6)}, Level=${metrics.consciousness_level || 'unknown'}`);

  const ok = await publishToNATS(metrics);
  if (!ok) {
    console.log('[dream-cron] Failed to publish to NATS');
  }
}

async function main() {
  console.log(`[dream-cron] Starting — interval=${INTERVAL_SECS}s, observatory=:${process.env.OBSERVATORY_PORT || 3333}, NATS=${NATS_HOST}:${NATS_PORT}`);

  await tick();

  if (RUN_ONCE) {
    console.log('[dream-cron] --once mode, exiting');
    process.exit(0);
  }

  setInterval(tick, INTERVAL_SECS * 1000);
  console.log(`[dream-cron] Next tick in ${INTERVAL_SECS}s`);
}

// Only self-start when executed directly, so the pieces above can be required
// and exercised by test/dream-cron-nats.test.js without launching a cron.
if (require.main === module) {
  main().catch((err) => {
    console.error('[dream-cron] Fatal:', err);
    process.exit(1);
  });
}

module.exports = { assess, assessViaBinary, assessViaObservatory, publishToNATS, shapeMetrics, tick };
