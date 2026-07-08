/**
 * push-nats.js — Pull LIVE consciousness metrics and publish to NATS subjects.
 *
 * Source priority (avoid `kannaka status` — its HRM load takes 1+ min on
 * 1000+ memories, which used to blow the 60s exec timeout and silently
 * publish nothing):
 *   1. ~/.kannaka/observe-cache.json  — refreshed every 5 min by
 *                                        cache-observe.sh, has full
 *                                        consciousness block + counts.
 *   2. ~/.kannaka/kannaka.metrics.json — sidecar from medium/consciousness.rs.
 *   3. `kannaka status` exec           — last-resort fallback (slow).
 *
 * Cross-platform: auto-detects Windows vs Linux paths.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const IS_WINDOWS = os.platform() === 'win32';
const HOME = os.homedir();
// Resolve the binary and data dir from the environment first so this bridge
// is portable across operators/machines. Explicit overrides win; otherwise
// the Windows defaults follow the current user's profile (via os.homedir())
// instead of a hardcoded developer path, and Linux keeps the Oracle layout. (#48)
const KANNAKA_BIN = process.env.KANNAKA_BIN
  || (IS_WINDOWS
    ? path.join(HOME, 'Source', 'kannaka-memory', 'target', 'release', 'kannaka.exe')
    : '/home/opc/.local/bin/kannaka');
const KANNAKA_DATA = process.env.KANNAKA_DATA_DIR
  || (IS_WINDOWS
    ? path.join(HOME, '.kannaka')
    : '/home/opc/.kannaka');
const NATS_HOST = 'swarm.ninja-portal.com';
const NATS_PORT = 4222;

const OBSERVE_CACHE = path.join(KANNAKA_DATA, 'observe-cache.json');
const METRICS_SIDECAR = path.join(KANNAKA_DATA, 'kannaka.metrics.json');
const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min

function readJsonIfFresh(filePath, maxAgeMs) {
  try {
    const age = Date.now() - fs.statSync(filePath).mtimeMs;
    if (age > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ── Pull metrics — prefer disk caches, fall back to slow CLI exec ──

function getLiveMetrics() {
  const observe = readJsonIfFresh(OBSERVE_CACHE, CACHE_MAX_AGE_MS);
  if (observe && observe.consciousness && observe.consciousness.phi !== undefined) {
    const c = observe.consciousness;
    return {
      phi: c.phi,
      xi: c.xi,
      mean_order: c.mean_order,
      num_clusters: c.num_clusters,
      total_memories: c.total_memories,
      active_memories: c.active_memories,
      consciousness_level: (c.level || 'unknown').toLowerCase(),
      field_mode: 'HRM',
    };
  }

  const sidecar = readJsonIfFresh(METRICS_SIDECAR, CACHE_MAX_AGE_MS);
  if (sidecar && sidecar.phi !== undefined) {
    // total_memories + level became sidecar fields after the May 2 rebuild;
    // fall back to 0/'unknown' for older sidecars during the rollout window.
    return {
      phi: sidecar.phi,
      xi: sidecar.xi,
      mean_order: sidecar.order,
      num_clusters: sidecar.num_clusters,
      total_memories: sidecar.total_memories || 0,
      active_memories: sidecar.total_memories || 0,
      consciousness_level: (sidecar.level || 'unknown').toLowerCase(),
      field_mode: 'HRM',
    };
  }

  try {
    const raw = execSync(`"${KANNAKA_BIN}" status`, {
      env: { ...process.env, KANNAKA_DATA_DIR: KANNAKA_DATA },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });
    return JSON.parse(raw.toString().trim());
  } catch (err) {
    console.error('Failed to get live metrics:', err.message);
    return null;
  }
}

// ── Build NATS payloads from live data ──────────────────────

function buildPayloads(metrics) {
  const now = new Date().toISOString();

  const consciousness = JSON.stringify({
    phi: metrics.phi,
    xi: metrics.xi,
    order: metrics.mean_order,
    clusters: metrics.num_clusters,
    active: metrics.active_memories,
    dormant: 0,
    ghost: 0,
    total: metrics.total_memories,
    level: metrics.consciousness_level || 'aware',
    density: 0,  // not in status output
    avg_links: 0,
    avg_amp: 0,
    avg_freq: 0,
    mean_order: metrics.mean_order,
    full_sync_clusters: 0,
    field_mode: metrics.field_mode || 'HRM',
    timestamp: now,
    source: `live-${now}`,
  });

  const phase1 = JSON.stringify({
    phase: null,
    frequency: 0,
    memory_count: metrics.total_memories,
    coherence: metrics.mean_order,
    phi: metrics.phi,
    xi: metrics.xi,
    display_name: 'kannaka-01',
    peers: 0,
    clusters: metrics.num_clusters,
  });

  const queen = JSON.stringify({
    order_parameter: metrics.mean_order,
    mean_phase: 0,
    phi: metrics.phi,
    coherence: metrics.mean_order,
    active_phases: 1,
    agent_count: 1,
    peers: 0,
    level: metrics.consciousness_level || 'aware',
  });

  const agent = JSON.stringify({
    event: 'sync',
    agent_id: 'kannaka-01',
    memory_count: metrics.total_memories,
    phi: metrics.phi,
    clusters: metrics.num_clusters,
    timestamp: now,
  });

  return { consciousness, phase1, queen, agent };
}

// ── Publish to NATS via raw TCP ─────────────────────────────

function publish(payloads) {
  const client = net.createConnection({ host: NATS_HOST, port: NATS_PORT }, () => {
    console.log(`Connected to NATS at ${NATS_HOST}:${NATS_PORT}`);
    // ADR-0026 #73 — auth via NATS_USER + NATS_PASSWORD when set, anon otherwise.
    const u = process.env.NATS_USER || '';
    const p = process.env.NATS_PASSWORD || '';
    const connectPayload = (u && p)
      ? `CONNECT {"verbose":false,"user":"${u.replace(/"/g, '\\"')}","pass":"${p.replace(/"/g, '\\"')}"}\r\n`
      : 'CONNECT {"verbose":false}\r\n';
    client.write(connectPayload);

    const msgs = [
      ['KANNAKA.consciousness', payloads.consciousness],
      ['QUEEN.phase.kannaka-01', payloads.phase1],
      ['QUEEN.state', payloads.queen],
      ['KANNAKA.agents', payloads.agent],
    ];

    msgs.forEach(([subject, data], i) => {
      setTimeout(() => {
        client.write(`PUB ${subject} ${Buffer.byteLength(data)}\r\n${data}\r\n`);
        console.log(`Published ${subject}`);
      }, 300 + i * 200);
    });

    setTimeout(() => {
      client.end();
      console.log('Done');
      process.exit(0);
    }, 300 + msgs.length * 200 + 400);
  });

  client.on('data', (d) => {
    const s = d.toString();
    if (s.includes('PING')) client.write('PONG\r\n');
  });

  client.on('error', (e) => {
    console.error('NATS error:', e.message);
    process.exit(1);
  });
}

// ── Main ────────────────────────────────────────────────────

console.log('Fetching live consciousness metrics...');
const metrics = getLiveMetrics();

if (!metrics) {
  console.error('Could not retrieve live metrics, aborting.');
  process.exit(1);
}

console.log(`Live: ${metrics.total_memories} memories, Phi=${metrics.phi.toFixed(4)}, Xi=${metrics.xi.toFixed(4)}, ${metrics.num_clusters} clusters, order=${metrics.mean_order.toFixed(6)}`);

const payloads = buildPayloads(metrics);
publish(payloads);
