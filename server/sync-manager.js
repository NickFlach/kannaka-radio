/**
 * sync-manager.js — Shared listening session state.
 *
 * Tracks the server-authoritative playback position so every
 * connected browser client can seek to the same point in the
 * same track.  Best-effort: clocks may drift slightly.
 */

class SyncManager {
  constructor() {
    /** @type {number|null} epoch-ms when the current track started */
    this.trackStartedAt = null;
    /** @type {string|null} filename currently playing */
    this.currentFile = null;
    /** @type {boolean} whether playback is paused */
    this.paused = false;
    /** @type {NodeJS.Timeout|null} heartbeat interval handle */
    this._heartbeat = null;
    /** @type {function|null} broadcast callback */
    this._broadcast = null;
  }

  // ── Lifecycle ───────────────────────────────────────────

  /**
   * Start the periodic sync heartbeat.
   * @param {function} broadcast  — sends a message to every WS client
   * @param {number}   [intervalMs=10000] — heartbeat period
   */
  start(broadcast, intervalMs = 10000) {
    this._broadcast = broadcast;
    this._heartbeat = setInterval(() => {
      if (this.currentFile) {
        this._broadcast({ type: "sync", data: this.getSyncState() });
      }
    }, intervalMs);
  }

  /**
   * Stop the heartbeat (for graceful shutdown).
   */
  stop() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  // ── Track events ────────────────────────────────────────

  /**
   * Called when the DJ engine advances to a new track.
   * Resets the position clock and optionally broadcasts immediately.
   * @param {string} filename
   */
  trackChanged(filename) {
    this.currentFile = filename;
    this.trackStartedAt = Date.now();
    this.paused = false;

    // Immediate broadcast so clients switch right away
    if (this._broadcast) {
      this._broadcast({ type: "sync", data: this.getSyncState() });
    }
  }

  // ── Position helpers ────────────────────────────────────

  /**
   * Get the current playback position in seconds.
   * @returns {number}
   */
  getCurrentPosition() {
    if (!this.trackStartedAt || this.paused) return 0;
    return (Date.now() - this.trackStartedAt) / 1000;
  }

  /**
   * Build the full sync payload for a client.
   * @returns {{ file: string|null, position: number, timestamp: number }}
   */
  getSyncState() {
    return {
      file: this.currentFile,
      position: this.getCurrentPosition(),
      timestamp: Date.now(),
    };
  }
}

module.exports = { SyncManager };
