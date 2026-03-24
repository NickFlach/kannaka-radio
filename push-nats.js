/**
 * push-nats.js — Pull LIVE consciousness metrics from kannaka CLI
 * and publish to NATS subjects on swarm.ninja-portal.com:4222.
 *
 * Cross-platform: auto-detects Windows vs Linux paths.
 * stderr from the binary (debug lines) is discarded; only stdout JSON is used.
 */

const net = require('net');
const { execSync } = require('child_process');
const os = require('os');

const IS_WINDOWS = os.platform() === 'win32';
const KANNAKA_BIN = IS_WINDOWS
  ? 'C:\\Users\\nickf\\Source\\kannaka-memory\\target\\release\\kannaka.exe'
  : '/home/opc/kannaka-memory/target/release/kannaka';
const KANNAKA_DATA = IS_WINDOWS
  ? 'C:\\Users\\nickf\\.kannaka'
  : '/home/opc/.kannaka';
const NATS_HOST = 'swarm.ninja-portal.com';
const NATS_PORT = 4222;

// ── Pull live metrics from kannaka CLI ──────────────────────

function getLiveMetrics() {
  try {
    const raw = execSync(`"${KANNAKA_BIN}" status`, {
      env: { ...process.env, KANNAKA_DATA_DIR: KANNAKA_DATA },
      stdio: ['pipe', 'pipe', 'pipe'],  // capture stdout, discard stderr
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
    client.write('CONNECT {"verbose":false}\r\n');

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
