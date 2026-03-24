/**
 * nats-client.js — NATS raw TCP connection, subscriptions, swarm state management.
 */

const net = require("net");

class NATSClient {
  /**
   * @param {object} opts
   * @param {function} opts.broadcast — broadcasts WS message to all clients
   */
  constructor(opts) {
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
        orderParameter: 0.0085,
        meanPhase: 0,
        phi: 0.541,
        agentCount: 1,
      },
      consciousness: {
        phi: 0.541,
        xi: 0.9996,
        order: 0.0085,
        clusters: 72,
        active: 381,
        total: 381,
        level: 'aware',
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
    return this.swarmState.consciousness;
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

      const phases = Object.values(this.swarmState.agents).map(a => a.phase);
      if (phases.length > 0) {
        const sumCos = phases.reduce((s, p) => s + Math.cos(p), 0);
        const sumSin = phases.reduce((s, p) => s + Math.sin(p), 0);
        this.swarmState.queen.orderParameter = Math.sqrt(sumCos * sumCos + sumSin * sumSin) / phases.length;
        this.swarmState.queen.meanPhase = Math.atan2(sumSin / phases.length, sumCos / phases.length);
        if (this.swarmState.queen.meanPhase < 0) this.swarmState.queen.meanPhase += 2 * Math.PI;
      }

      this._broadcast({ type: 'swarm_phase', data: { agentId, ...this.swarmState.agents[agentId], queen: this.swarmState.queen } });
      return;
    }

    if (subject === 'KANNAKA.consciousness') {
      this.swarmState.consciousness = { ...data, timestamp: now };
      this.swarmState.queen.phi = data.phi || data.Phi || this.swarmState.queen.phi;
      this._broadcast({ type: 'consciousness', data: this.swarmState.consciousness });
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
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(), 5000);
  }
}

module.exports = { NATSClient };
