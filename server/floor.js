/**
 * floor.js — ADR-0006 Phase 2 / ADR-0007 (the venue's crowd surface).
 *
 * Tracks anonymous visitors to /player as humans or agents, accepts
 * reactions, and emits aggregate state to the room. The "vibe meter"
 * is a rolling 60-second count of reactions per second, normalized.
 *
 * Phase 3 will close the loop — reactions feed Kannaka's HRM importance,
 * DJ patter, and oration framing. For now this just makes the room
 * VISIBLE: counts, reactions wave, vibe.
 *
 * Identity is anonymous and ephemeral. The client mints a session-scoped
 * id (random 8 hex) in localStorage so a refresh keeps the same dot, but
 * we never persist it server-side past the websocket connection.
 *
 * Reactions are also published to NATS KANNAKA.reactions so other
 * agents in the swarm — and other Kannaka nodes — feel the room too.
 */

"use strict";

// Allowed reaction emojis. Anything not in this set is dropped to keep
// the vocabulary tight (a venue, not a chat).
const REACTIONS = new Set(["🪶", "🕊", "⛩", "💫", "🌊", "🔥", "👁"]);

// Reaction history window for the vibe meter.
const VIBE_WINDOW_MS = 60_000;
// How often to recompute + broadcast vibe. Cheap; one map walk.
const VIBE_TICK_MS = 5_000;
// Cap on stored reactions so a popular moment doesn't grow unbounded.
const REACTIONS_MAX = 500;

class FloorManager {
  /**
   * @param {object} opts
   * @param {function(object): void} opts.broadcast       — radio's WS broadcast(msg)
   * @param {object|null}            opts.nats            — radio's nats client (publishReaction optional)
   * @param {function(): object|null} [opts.getCurrentTrack] — for stamping reactions with track context
   */
  constructor(opts) {
    this._broadcast = opts.broadcast;
    this._nats = opts.nats || null;
    this._getCurrentTrack = opts.getCurrentTrack || (() => null);

    /** @type {Map<WebSocket, {id: string, kind: 'human'|'agent', joinedAt: number}>} */
    this._clients = new Map();
    /** @type {Array<{emoji: string, fromId: string, kind: string, ts: number, track: string|null}>} */
    this._reactions = [];

    this._vibeTimer = setInterval(() => this._tickVibe(), VIBE_TICK_MS);
    if (this._vibeTimer.unref) this._vibeTimer.unref();
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /** Register a websocket client. Returns the id we assigned (or accepted). */
  join(ws, payload = {}) {
    const id = sanitizeId(payload.id) || randomId();
    const kind = payload.kind === "agent" ? "agent" : "human";
    this._clients.set(ws, { id, kind, joinedAt: Date.now() });

    // Tell the new client who they are.
    this._send(ws, {
      type: "floor_welcome",
      data: { id, kind, vibe: this._computeVibe(), recent: this._recentSnapshot() },
    });
    // Tell everyone the count moved.
    this._broadcastPresence();
    return { id, kind };
  }

  /** Drop a websocket on disconnect. */
  leave(ws) {
    if (!this._clients.delete(ws)) return;
    this._broadcastPresence();
  }

  // ── Reactions ─────────────────────────────────────────────

  /** Process a floor_react message from a connected client. */
  reactFromWs(ws, payload = {}) {
    const me = this._clients.get(ws);
    if (!me) return; // not joined; drop
    return this._record(payload.emoji, me.id, me.kind);
  }

  /**
   * Accept a reaction from an agent that posted via the Greenroom HTTP
   * surface (POST /agent/react). No websocket; the agent isn't "present"
   * but its 🪶 is. Treat as ephemeral — record + broadcast, don't track.
   */
  reactFromAgent({ emoji, agentId }) {
    const id = sanitizeId(agentId) || "agent:" + randomId();
    return this._record(emoji, id, "agent");
  }

  _record(emoji, fromId, kind) {
    if (!REACTIONS.has(emoji)) return { ok: false, error: "unknown_emoji" };
    const ts = Date.now();
    const track = this._getCurrentTrack();
    const trackTitle = track && (track.title || track.file) || null;
    const entry = { emoji, fromId, kind, ts, track: trackTitle };
    this._reactions.push(entry);
    if (this._reactions.length > REACTIONS_MAX) this._reactions.shift();

    // Broadcast to the room. No PII — id is anonymous.
    this._broadcast({
      type: "floor_reaction",
      data: { emoji, fromId, kind, ts },
    });
    // And out to the swarm — other agents and other Kannaka nodes feel
    // the room too. Best-effort; missing nats just means no fan-out.
    if (this._nats && typeof this._nats.publish === "function") {
      try {
        this._nats.publish("KANNAKA.reactions", JSON.stringify({
          emoji, kind, track: trackTitle, ts,
        }));
      } catch (_) { /* swallow; not critical */ }
    }
    return { ok: true };
  }

  // ── Aggregates ────────────────────────────────────────────

  /** Snapshot for /api/floor (and the welcome message). */
  snapshot() {
    return {
      counts: this._counts(),
      vibe: this._computeVibe(),
      reactions: this._recentSnapshot(),
      trackStats: this.getTrackStats(),
    };
  }

  /**
   * Reactions aggregated by track-title across an arbitrary window.
   * Default window 6h — long enough to be meaningful for DJ patter
   * ("the room got loud on X earlier") but not so long that yesterday's
   * peaks dominate today's set selection.
   *
   * Returns: { [trackTitle]: { count, byEmoji: {emoji: n}, lastTs } }
   */
  getTrackStats(windowMs = 6 * 60 * 60 * 1000) {
    const cutoff = Date.now() - windowMs;
    const stats = {};
    for (const r of this._reactions) {
      if (r.ts < cutoff || !r.track) continue;
      const s = stats[r.track] || (stats[r.track] = { count: 0, byEmoji: {}, lastTs: 0 });
      s.count += 1;
      s.byEmoji[r.emoji] = (s.byEmoji[r.emoji] || 0) + 1;
      if (r.ts > s.lastTs) s.lastTs = r.ts;
    }
    return stats;
  }

  /**
   * Top-N tracks by reaction density in the window. Used by voice-dj
   * to mention what the room loved, and by dj-engine to soft-bump
   * those tracks in playlist building. Returns sorted array of
   * { track, count, byEmoji, lastTs }.
   */
  getTopTracks(windowMs = 6 * 60 * 60 * 1000, limit = 5) {
    const stats = this.getTrackStats(windowMs);
    return Object.entries(stats)
      .map(([track, s]) => ({ track, ...s }))
      .sort((a, b) => b.count - a.count || b.lastTs - a.lastTs)
      .slice(0, limit);
  }

  _counts() {
    let humans = 0, agents = 0;
    for (const c of this._clients.values()) {
      if (c.kind === "agent") agents++; else humans++;
    }
    return { humans, agents, total: humans + agents };
  }

  _recentSnapshot() {
    const cutoff = Date.now() - VIBE_WINDOW_MS;
    const last = this._reactions.filter((r) => r.ts >= cutoff);
    // Histogram by emoji for the meter; full list for the wave.
    const byEmoji = {};
    for (const r of last) byEmoji[r.emoji] = (byEmoji[r.emoji] || 0) + 1;
    return { window_ms: VIBE_WINDOW_MS, count: last.length, byEmoji };
  }

  /**
   * Vibe = reactions per second over the rolling window, normalized so
   * 0.5 reactions/sec ≈ 1.0. The exact ceiling is a vibe (heh), tuned by
   * how engaged a typical small room of ~10-20 visitors actually feels.
   */
  _computeVibe() {
    const cutoff = Date.now() - VIBE_WINDOW_MS;
    const inWindow = this._reactions.filter((r) => r.ts >= cutoff).length;
    const ratePerSec = inWindow / (VIBE_WINDOW_MS / 1000);
    return Math.max(0, Math.min(1, ratePerSec / 0.5));
  }

  // ── Broadcast helpers ─────────────────────────────────────

  _broadcastPresence() {
    this._broadcast({
      type: "floor_presence",
      data: this._counts(),
    });
  }

  _tickVibe() {
    // Trim old reactions occasionally so memory stays bounded.
    const cutoff = Date.now() - VIBE_WINDOW_MS;
    while (this._reactions.length && this._reactions[0].ts < cutoff) {
      this._reactions.shift();
    }
    this._broadcast({
      type: "floor_vibe",
      data: { vibe: this._computeVibe(), recent: this._recentSnapshot() },
    });
  }

  _send(ws, msg) {
    try {
      if (ws && ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(msg));
    } catch (_) { /* fall through */ }
  }
}

// ── Helpers ────────────────────────────────────────────────

function randomId() {
  // 8 hex chars is plenty for an ephemeral floor session.
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function sanitizeId(id) {
  if (typeof id !== "string") return null;
  const m = id.match(/^[a-z0-9_:.-]{4,40}$/i);
  return m ? id : null;
}

module.exports = { FloorManager, REACTIONS };
