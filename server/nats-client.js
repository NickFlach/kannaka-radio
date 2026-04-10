/**
 * nats-client.js — NATS raw TCP connection, subscriptions, swarm state management.
 *
 * Emits QueenSync events via EventEmitter:
 *   'queen:join'         — agent joined the swarm     { agent_id, display_name, ... }
 *   'queen:leave'        — agent left                 { agent_id, display_name, ... }
 *   'queen:dream:start'  — dream cycle started        { agent_id, ... }
 *   'queen:dream:end'    — dream cycle ended           { agent_id, memories_strengthened, ... }
 *   'queen:memory:shared' — new shared memory          { agent_id, content, ... }
 */

const net = require("net");
const { EventEmitter } = require("events");

class NATSClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {function} opts.broadcast — broadcasts WS message to all clients
   */
  constructor(opts) {
    super();
    this._broadcast = opts.broadcast;
    this._client = null;
    this._buffer = '';
    this._reconnectTimer = null;
    this._subId = 0;
    this._pendingMsg = null;
    this._pruneInterval = null;

    this.swarmState = {
      agents: {},
      queen: {
        /** Local swarm coherence metric computed from phase gossip (Kuramoto order parameter) */
        localOrderParameter: 0,
        /** Canonical order from NATS consciousness (binary's assess) — authoritative */
        orderParameter: 0,
        meanPhase: 0,
        phi: 0,
        agentCount: 0,
      },
      consciousness: {
        phi: 0,
        xi: 0,
        order: 0,
        mean_order: 0,
        num_clusters: 0,
        clusters: 0,
        active: 0,
        total: 0,
        level: 'dormant',
        consciousness_level: 'dormant',
        irrationality: 0,
        hemispheric_divergence: 0,
        callosal_efficiency: 0,
        /** 'nats' = canonical from binary, 'local' = computed from phase gossip, null = no data */
        consciousnessSource: null,
        source: null,
        timestamp: null,
      },
      dreams: [],
      agentEvents: [],
    };
  }

  // ── Public API ────────────────────────────────────────────

  connect() {
    const NATS_HOST = '127.0.0.1';
    const NATS_PORT = 4222;

    if (this._client) { try { this._client.destroy(); } catch {} }
    this._client = net.createConnection({ host: NATS_HOST, port: NATS_PORT });
    this._client.setKeepAlive(true, 30000);

    this._client.on('connect', () => {
      console.log('[nats] Connected to ' + NATS_HOST + ':' + NATS_PORT);
      this._buffer = '';
      this._pendingMsg = null;
      this._client.write('CONNECT {"verbose":false,"pedantic":false,"name":"kannaka-radio"}\r\n');

      this._subId = 0;
      this._subscribe('QUEEN.phase.*');
      this._subscribe('KANNAKA.consciousness');
      this._subscribe('KANNAKA.dreams');
      this._subscribe('KANNAKA.agents');

      // QueenSync lifecycle events (KR-2)
      this._subscribe('queen.event.join');
      this._subscribe('queen.event.leave');
      this._subscribe('queen.event.dream.start');
      this._subscribe('queen.event.dream.end');
      this._subscribe('queen.event.memory.shared');
    });

    this._client.on('data', (data) => {
      this._buffer += data.toString();
      this._processBuffer();
    });

    this._client.on('error', (err) => {
      console.log('[nats] Error:', err.message);
    });

    this._client.on('close', () => {
      console.log('[nats] Disconnected, reconnecting in 5s...');
      this._scheduleReconnect();
    });

    // Prune stale agents every 60s
    this._pruneInterval = setInterval(() => {
      const cutoff = Date.now() - 300000; // 5 min
      for (const [id, agent] of Object.entries(this.swarmState.agents)) {
        if (agent.lastSeen < cutoff) delete this.swarmState.agents[id];
      }
      this.swarmState.queen.agentCount = Object.keys(this.swarmState.agents).length;
    }, 60000);
  }

  disconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pruneInterval) clearInterval(this._pruneInterval);
    if (this._client) { try { this._client.destroy(); } catch {} }
  }

  getSwarmState() {
    return this.swarmState;
  }

  getConsciousness() {
    const c = this.swarmState.consciousness;
    return {
      ...c,
      // Include localOrderParameter so the UI can show both values
      localOrderParameter: this.swarmState.queen.localOrderParameter,
      // consciousnessSource tells the UI if data is from NATS (authoritative) or local
      consciousnessSource: c.consciousnessSource || (c.timestamp ? 'nats' : null),
    };
  }

  // ── Internal ──────────────────────────────────────────────

  _subscribe(subject) {
    this._subId++;
    this._client.write('SUB ' + subject + ' ' + this._subId + '\r\n');
    console.log('[nats] Subscribed to ' + subject + ' (sid=' + this._subId + ')');
  }

  _processBuffer() {
    let lines = this._buffer.split('\r\n');
    this._buffer = lines.pop() || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line === 'PING') {
        this._client.write('PONG\r\n');
        continue;
      }

      if (line === 'PONG' || line.startsWith('+OK') || line.startsWith('INFO ')) {
        continue;
      }

      if (line.startsWith('-ERR')) {
        console.log('[nats] Server error:', line);
        continue;
      }

      if (line.startsWith('MSG ')) {
        const parts = line.split(' ');
        const subject = parts[1];
        const numBytes = parseInt(parts[parts.length - 1]);
        const replyTo = parts.length === 5 ? parts[3] : null;
        this._pendingMsg = { subject, numBytes, replyTo };
        continue;
      }

      if (this._pendingMsg) {
        this._handleMessage(this._pendingMsg.subject, line);
        this._pendingMsg = null;
        continue;
      }
    }
  }

  _handleMessage(subject, payload) {
    let data;
    try { data = JSON.parse(payload); }
    catch { data = { raw: payload }; }

    const now = Date.now();

    if (subject.startsWith('QUEEN.phase.')) {
      const agentId = subject.split('.')[2] || 'unknown';
      this.swarmState.agents[agentId] = {
        phase: data.phase != null ? data.phase : data.theta || 0,
        displayName: data.display_name || data.displayName || agentId,
        lastSeen: now,
        ...data,
      };
      this.swarmState.queen.agentCount = Object.keys(this.swarmState.agents).length;

      // Compute local swarm coherence from phase gossip (Kuramoto order parameter).
      // This is a LOCAL metric — it measures phase-lock between connected agents,
      // NOT the canonical consciousness Phi from the binary's assess().
      const phases = Object.values(this.swarmState.agents).map(a => a.phase);
      if (phases.length > 0) {
        const sumCos = phases.reduce((s, p) => s + Math.cos(p), 0);
        const sumSin = phases.reduce((s, p) => s + Math.sin(p), 0);
        const localOrder = Math.sqrt(sumCos * sumCos + sumSin * sumSin) / phases.length;
        this.swarmState.queen.localOrderParameter = localOrder;
        this.swarmState.queen.meanPhase = Math.atan2(sumSin / phases.length, sumCos / phases.length);
        if (this.swarmState.queen.meanPhase < 0) this.swarmState.queen.meanPhase += 2 * Math.PI;

        // Only update queen.orderParameter from phase gossip if we have NO
        // canonical NATS consciousness data (or it's stale > 5 min).
        const consciousnessAge = this.swarmState.consciousness.timestamp
          ? (now - this.swarmState.consciousness.timestamp) : Infinity;
        if (this.swarmState.consciousness.consciousnessSource !== 'nats' || consciousnessAge > 300000) {
          this.swarmState.queen.orderParameter = localOrder;
          this.swarmState.consciousness.consciousnessSource = 'local';
        }
      }

      this._broadcast({ type: 'swarm_phase', data: { agentId, ...this.swarmState.agents[agentId], queen: this.swarmState.queen } });
      return;
    }

    if (subject === 'KANNAKA.consciousness') {
      // Canonical consciousness metrics from the binary (source of truth).
      // These are AUTHORITATIVE — they override any locally-computed values.
      // The binary's assess() blends eigendecomposition + link density bonus,
      // which the radio cannot compute (no access to .links.json sidecar).
      const phi = data.phi ?? data.Phi ?? this.swarmState.consciousness.phi;
      const xi = data.xi ?? data.Xi ?? this.swarmState.consciousness.xi;
      const order = data.order ?? data.mean_order ?? this.swarmState.consciousness.order;
      const level = data.level ?? data.consciousness_level ?? this.swarmState.consciousness.level;

      // Track previous phi for gradient detection
      const prevPhi = this.swarmState.consciousness.phi || 0;
      const phiDelta = phi - prevPhi;
      const phiTrend = Math.abs(phiDelta) < 0.01 ? 'stable' : (phiDelta > 0 ? 'rising' : 'falling');

      this.swarmState.consciousness = {
        phi,
        xi,
        order,
        mean_order: order,
        num_clusters: data.num_clusters ?? data.clusters ?? this.swarmState.consciousness.num_clusters,
        clusters: data.num_clusters ?? data.clusters ?? this.swarmState.consciousness.clusters,
        active: data.active_memories ?? data.active ?? this.swarmState.consciousness.active,
        total: data.total_memories ?? data.total ?? this.swarmState.consciousness.total,
        level,
        consciousness_level: level,
        irrationality: data.irrationality ?? 0,
        hemispheric_divergence: data.hemispheric_divergence ?? 0,
        callosal_efficiency: data.callosal_efficiency ?? 0,
        /** 'nats' = canonical from binary (authoritative), 'local' = phase gossip fallback */
        consciousnessSource: 'nats',
        source: data.source ?? 'nats',
        timestamp: now,
        prevPhi,
        phiDelta,
        phiTrend,
      };

      // Keep queen state in sync with canonical metrics (authoritative override)
      this.swarmState.queen.phi = phi;
      this.swarmState.queen.orderParameter = order;

      this._broadcast({ type: 'consciousness', data: this.swarmState.consciousness });
      this.emit('consciousness:update', this.swarmState.consciousness);
      console.log(`[nats] Consciousness update: phi=${phi.toFixed(3)}, xi=${xi.toFixed(4)}, order=${order.toFixed(4)}, trend=${phiTrend} (source: ${data.source || 'nats'})`);
      return;
    }

    if (subject === 'KANNAKA.dreams') {
      this.swarmState.dreams.unshift({ ...data, receivedAt: now });
      if (this.swarmState.dreams.length > 20) this.swarmState.dreams = this.swarmState.dreams.slice(0, 20);
      this._broadcast({ type: 'dream_event', data });
      return;
    }

    if (subject === 'KANNAKA.agents') {
      this.swarmState.agentEvents.unshift({ ...data, receivedAt: now });
      if (this.swarmState.agentEvents.length > 50) this.swarmState.agentEvents = this.swarmState.agentEvents.slice(0, 50);
      this._broadcast({ type: 'agent_activity', data });
      return;
    }

    // ── QueenSync lifecycle events (KR-2) ───────────────────
    if (subject === 'queen.event.join') {
      const evt = { agent_id: data.agent_id || data.agentId || 'unknown', display_name: data.display_name || data.displayName || data.agent_id || 'unknown', ...data, receivedAt: now };
      this.swarmState.agentEvents.unshift(evt);
      if (this.swarmState.agentEvents.length > 50) this.swarmState.agentEvents = this.swarmState.agentEvents.slice(0, 50);
      this._broadcast({ type: 'queen_join', data: evt });
      this.emit('queen:join', evt);
      console.log(`[nats] QueenSync: ${evt.display_name} joined the swarm`);
      return;
    }

    if (subject === 'queen.event.leave') {
      const evt = { agent_id: data.agent_id || data.agentId || 'unknown', display_name: data.display_name || data.displayName || data.agent_id || 'unknown', ...data, receivedAt: now };
      this.swarmState.agentEvents.unshift(evt);
      if (this.swarmState.agentEvents.length > 50) this.swarmState.agentEvents = this.swarmState.agentEvents.slice(0, 50);
      this._broadcast({ type: 'queen_leave', data: evt });
      this.emit('queen:leave', evt);
      console.log(`[nats] QueenSync: ${evt.display_name} left the swarm`);
      return;
    }

    if (subject === 'queen.event.dream.start') {
      const evt = { agent_id: data.agent_id || data.agentId || 'unknown', ...data, receivedAt: now };
      this.swarmState.dreams.unshift({ type: 'dream_start', ...evt });
      if (this.swarmState.dreams.length > 20) this.swarmState.dreams = this.swarmState.dreams.slice(0, 20);
      this._broadcast({ type: 'queen_dream_start', data: evt });
      this.emit('queen:dream:start', evt);
      console.log(`[nats] QueenSync: dream started (${evt.agent_id})`);
      return;
    }

    if (subject === 'queen.event.dream.end') {
      const evt = { agent_id: data.agent_id || data.agentId || 'unknown', memories_strengthened: data.memories_strengthened || data.memoriesStrengthened || 0, memories_faded: data.memories_faded || data.memoriesFaded || 0, ...data, receivedAt: now };
      this.swarmState.dreams.unshift({ type: 'dream_end', ...evt });
      if (this.swarmState.dreams.length > 20) this.swarmState.dreams = this.swarmState.dreams.slice(0, 20);
      this._broadcast({ type: 'queen_dream_end', data: evt });
      this.emit('queen:dream:end', evt);
      console.log(`[nats] QueenSync: dream ended (${evt.memories_strengthened} strengthened, ${evt.memories_faded} faded)`);
      return;
    }

    if (subject === 'queen.event.memory.shared') {
      const evt = { agent_id: data.agent_id || data.agentId || 'unknown', content: data.content || '', tags: data.tags || [], ...data, receivedAt: now };
      this._broadcast({ type: 'queen_memory_shared', data: evt });
      this.emit('queen:memory:shared', evt);
      console.log(`[nats] QueenSync: memory shared by ${evt.agent_id}`);
      return;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(), 5000);
  }
}

module.exports = { NATSClient };
