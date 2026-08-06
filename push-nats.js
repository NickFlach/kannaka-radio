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
// Broker resolution is shared with the radio's own NATS client so the two
// cannot drift: KANNAKA_NATS_URL > NATS_HOST/NATS_PORT > 127.0.0.1:4222.
//
// These were hardcoded to the PRODUCTION broker, which is the dangerous
// direction of this bug: every install — a laptop, a test box, a fork —
// published its metrics straight into the live swarm, and no env var could
// stop it. There was no way to point this bridge anywhere else. (#112)
const { resolveNatsEndpoint } = require('./server/nats-client');
const { host: NATS_HOST, port: NATS_PORT, source: NATS_SOURCE } = resolveNatsEndpoint();

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

/**
 * Live peer count, or null when we genuinely cannot tell.
 *
 * `null` is the whole point (#127). This bridge used to hardcode `peers: 0`
 * and `agent_count: 1`, so every consumer of QUEEN.state saw a permanently
 * solo swarm while the constellation was active. Defaulting a failed lookup to
 * 0 would reintroduce exactly that — asserting "nobody is out there" on the
 * strength of a CLI timeout. That is the lesson `/api/swarm/peers` already
 * learned in #137: a failed refresh must not read as an empty swarm.
 */
function getLivePeerCount() {
  try {
    const raw = execSync(`"${KANNAKA_BIN}" swarm peers --json`, {
      env: { ...process.env, KANNAKA_DATA_DIR: KANNAKA_DATA, KANNAKA_QUIET: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(raw.toString().trim());
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.peers;
    return Array.isArray(list) ? list.length : null;
  } catch (err) {
    console.error(`Could not resolve live peers (${err.message}) — omitting swarm cardinality`);
    return null;
  }
}

/**
 * Live local oscillator phase from `kannaka swarm status`, or null when we
 * genuinely cannot tell. Same rule as getLivePeerCount (#127): a failed
 * lookup is unknown, not a value. An unknown phase means the QUEEN.phase
 * heartbeat is skipped entirely rather than published as `phase: null` —
 * the radio's own consumer folds null to 0 radians and reports a perfectly
 * coherent one-agent swarm from a heartbeat that never measured anything. (#204)
 */
function getLiveLocalPhase() {
  try {
    const raw = execSync(`"${KANNAKA_BIN}" swarm status`, {
      env: { ...process.env, KANNAKA_DATA_DIR: KANNAKA_DATA, KANNAKA_QUIET: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(raw.toString().trim());
    const lp = parsed && parsed.local_phase;
    if (lp && Number.isFinite(lp.phase)) {
      return {
        phase: lp.phase,
        frequency: Number.isFinite(lp.frequency) ? lp.frequency : 0,
      };
    }
    console.error('Swarm status carried no finite local phase — omitting phase heartbeat');
    return null;
  } catch (err) {
    console.error(`Could not resolve local phase (${err.message}) — omitting phase heartbeat`);
    return null;
  }
}

// Env-overridable identity, resolved per call and shared by the payload
// builder and the publisher so the QUEEN.phase subject can never disagree
// with the agent_id inside it. (#204)
function resolveIdentity(env = process.env) {
  const agentId = env.KANNAKA_AGENT_ID || 'kannaka-01';
  return { agentId, displayName: env.KANNAKA_DISPLAY_NAME || agentId };
}

function buildPayloads(metrics, peerCount, localPhase) {
  const now = new Date().toISOString();

  // Canonical envelope fields (schema_version / ts / agent_id) per
  // consciousness-core/docs/nats-contract.yaml. This bridge emitted only the
  // metrics plus an ISO `timestamp`, so everything it published tripped the
  // radio's own drift detector on the receiving side. Purely additive — every
  // pre-existing field is retained for consumers that already read them. (#52)
  const { agentId: AGENT_ID, displayName: DISPLAY_NAME } = resolveIdentity();
  const TS = Date.now();
  // Only a number counts as knowledge. null/undefined mean the lookup failed
  // and the cardinality fields are omitted rather than defaulted (#127).
  const peersKnown = typeof peerCount === 'number' && Number.isFinite(peerCount);

  const consciousness = JSON.stringify({
    schema_version: "1.0",
    ts: TS,
    agent_id: AGENT_ID,
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

  // No measured phase -> no phase heartbeat. The contract requires `phase` on
  // QUEEN.phase.*, and `phase: null` is worse than silence: it advertises
  // presence with a value consumers treat as 0 rad (#204).
  const phaseKnown = localPhase && Number.isFinite(localPhase.phase);
  const phase1 = !phaseKnown ? null : JSON.stringify({
    schema_version: "1.0",
    ts: TS,
    agent_id: AGENT_ID,
    phase: localPhase.phase,
    frequency: Number.isFinite(localPhase.frequency) ? localPhase.frequency : 0,
    memory_count: metrics.total_memories,
    coherence: metrics.mean_order,
    phi: metrics.phi,
    xi: metrics.xi,
    // Was the literal 'kannaka-01' while agent_id right above it is
    // env-overridable, so the two disagreed the moment KANNAKA_AGENT_ID was
    // set. One source of truth.
    display_name: DISPLAY_NAME,
    // Omitted entirely when unknown — see getLivePeerCount. A consumer can
    // tell "no peers field" from "peers: 0"; it could not tell a real solo
    // swarm from a hardcoded one.
    ...(peersKnown ? { peers: peerCount } : {}),
    clusters: metrics.num_clusters,
  });

  const queen = JSON.stringify({
    schema_version: "1.0",
    ts: TS,
    agent_id: AGENT_ID,
    order_parameter: metrics.mean_order,
    mean_phase: 0,
    phi: metrics.phi,
    coherence: metrics.mean_order,
    // agent_count is peers + this agent; active_phases is how many agents are
    // actually reporting a phase, which this bridge only knows for itself, so
    // it tracks agent_count rather than claiming a separate figure. Both are
    // omitted when the peer lookup failed rather than asserting a solo swarm.
    ...(peersKnown ? { active_phases: peerCount + 1, agent_count: peerCount + 1, peers: peerCount } : {}),
    level: metrics.consciousness_level || 'aware',
  });

  const agent = JSON.stringify({
    schema_version: "1.0",
    ts: TS,
    event: 'sync',
    agent_id: AGENT_ID,
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
    console.log(`Connected to NATS at ${NATS_HOST}:${NATS_PORT} (via ${NATS_SOURCE})`);
    // ADR-0026 #73 — auth via NATS_USER + NATS_PASSWORD when set, anon otherwise.
    const u = process.env.NATS_USER || '';
    const p = process.env.NATS_PASSWORD || '';
    const connectPayload = (u && p)
      ? `CONNECT {"verbose":false,"user":"${u.replace(/"/g, '\\"')}","pass":"${p.replace(/"/g, '\\"')}"}\r\n`
      : 'CONNECT {"verbose":false}\r\n';
    client.write(connectPayload);

    // Subject derives from the same agent_id as the payload body — these were
    // allowed to disagree when KANNAKA_AGENT_ID was set. Null payloads (an
    // unmeasured phase) are dropped rather than published. (#204)
    const { agentId } = resolveIdentity();
    const msgs = [
      ['KANNAKA.consciousness', payloads.consciousness],
      [`QUEEN.phase.${agentId}`, payloads.phase1],
      ['QUEEN.state', payloads.queen],
      ['KANNAKA.agents', payloads.agent],
    ].filter(([, data]) => data);

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

// Guarded so the module can be required by tests without publishing to NATS.
// buildPayloads() is the part worth asserting on, and it was previously only
// reachable by reading this file as text.
if (require.main === module) {
  console.log('Fetching live consciousness metrics...');
  const metrics = getLiveMetrics();

  if (!metrics) {
    console.error('Could not retrieve live metrics, aborting.');
    process.exit(1);
  }

  console.log(`Live: ${metrics.total_memories} memories, Phi=${metrics.phi.toFixed(4)}, Xi=${metrics.xi.toFixed(4)}, ${metrics.num_clusters} clusters, order=${metrics.mean_order.toFixed(6)}`);

  const peerCount = getLivePeerCount();
  console.log(peerCount === null
    ? 'Peers: unknown — cardinality fields omitted'
    : `Peers: ${peerCount}`);

  const localPhase = getLiveLocalPhase();
  console.log(localPhase === null
    ? 'Phase: unknown — QUEEN.phase heartbeat skipped'
    : `Phase: ${localPhase.phase.toFixed(4)} rad @ ${localPhase.frequency.toFixed(2)}Hz`);

  const payloads = buildPayloads(metrics, peerCount, localPhase);
  publish(payloads);
}

module.exports = { buildPayloads, getLivePeerCount, getLiveLocalPhase };
