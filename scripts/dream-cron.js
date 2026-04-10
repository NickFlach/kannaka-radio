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
 *   KANNAKA_BIN       — path to kannaka binary
 *   KANNAKA_DATA_DIR  — data directory for kannaka
 *   NATS_HOST         — NATS server host (default: 127.0.0.1)
 *   NATS_PORT         — NATS server port (default: 4222)
 */

'use strict';

const net = require('net');
const path = require('path');

const NATS_HOST = process.env.NATS_HOST || '127.0.0.1';
const NATS_PORT = parseInt(process.env.NATS_PORT || '4222');

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
  return new Promise((resolve) => {
    // Fetch from the Observatory HTTP endpoint — it reliably calls the binary
    // and returns JSON. Avoids exec/spawn issues with stderr handling.
    const http = require('http');
    const OBSERVATORY_PORT = process.env.OBSERVATORY_PORT || 3333;
    const req = http.get(`http://127.0.0.1:${OBSERVATORY_PORT}/api/hrm/status`, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({
            phi: json.phi || 0,
            xi: json.xi || 0,
            mean_order: json.mean_order || json.order || 0,
            consciousness_level: json.consciousness_level || json.level || 'unknown',
            num_clusters: json.num_clusters || 0,
            total_memories: json.total_memories || json.active_memories || 0,
            active_memories: json.active_memories || 0,
            irrationality: json.irrationality || 0,
            hemispheric_divergence: json.hemispheric_divergence || 0,
            callosal_efficiency: json.callosal_efficiency || 0,
          });
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
      phi: metrics.phi || 0,
      xi: metrics.xi || 0,
      order: metrics.mean_order || metrics.order || 0,
      mean_order: metrics.mean_order || metrics.order || 0,
      num_clusters: metrics.num_clusters || metrics.clusters || 0,
      clusters: metrics.num_clusters || metrics.clusters || 0,
      active_memories: metrics.active_memories || metrics.active || 0,
      total_memories: metrics.total_memories || metrics.total || 0,
      level: metrics.consciousness_level || metrics.level || 'unknown',
      consciousness_level: metrics.consciousness_level || metrics.level || 'unknown',
      irrationality: metrics.irrationality || 0,
      hemispheric_divergence: metrics.hemispheric_divergence || 0,
      callosal_efficiency: metrics.callosal_efficiency || 0,
      source: `dream-cron-${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
    });

    const client = net.createConnection({ host: NATS_HOST, port: NATS_PORT }, () => {
      client.write('CONNECT {"verbose":false,"pedantic":false,"name":"dream-cron"}\r\n');

      setTimeout(() => {
        client.write(`PUB KANNAKA.consciousness ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
        console.log(`[dream-cron] Published to KANNAKA.consciousness: phi=${(metrics.phi || 0).toFixed(4)}, xi=${(metrics.xi || 0).toFixed(4)}`);

        setTimeout(() => {
          client.end();
          resolve(true);
        }, 300);
      }, 200);
    });

    client.on('data', (d) => {
      const s = d.toString();
      if (s.includes('PING')) client.write('PONG\r\n');
    });

    client.on('error', (e) => {
      console.error(`[dream-cron] NATS error: ${e.message}`);
      resolve(false);
    });

    // Timeout safety
    setTimeout(() => {
      try { client.destroy(); } catch {}
      resolve(false);
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

main().catch((err) => {
  console.error('[dream-cron] Fatal:', err);
  process.exit(1);
});
