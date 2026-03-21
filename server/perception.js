/**
 * perception.js — Mock perception generation, real perception (kannaka-ear),
 * perception broadcasting.
 */

const path = require("path");
const { execFile } = require("child_process");
const { ALBUMS } = require("./dj-engine");

class PerceptionEngine {
  /**
   * @param {object} opts
   * @param {function} opts.getCurrentTrack — returns current track meta
   * @param {function} opts.broadcast — broadcasts WS message to all clients
   * @param {string}   opts.kannakabin — path to kannaka.exe
   * @param {function} opts.getMusicDir — returns current MUSIC_DIR
   */
  constructor(opts) {
    this._getCurrentTrack = opts.getCurrentTrack;
    this._broadcast = opts.broadcast;
    this._kannakabin = opts.kannakabin;
    this._getMusicDir = opts.getMusicDir;

    this._interval = null;
    this.current = {
      mel_spectrogram: Array(128).fill(0),
      mfcc: Array(13).fill(0),
      tempo_bpm: 0,
      spectral_centroid: 0,
      rms_energy: 0,
      pitch: 0,
      valence: 0.5,
      status: "no_perception",
      track_info: null
    };
  }

  // ── Mock perception ───────────────────────────────────────

  generateMockPerception(track) {
    const titleHash = track.title.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    const albumSeed = Object.keys(ALBUMS).indexOf(track.album) / Object.keys(ALBUMS).length;
    const t = Date.now() / 1000;

    const intensity = Math.sin(titleHash * 0.001 + t * 0.1) * 0.3 + 0.5;
    const albumMood = albumSeed;
    const breathe = Math.sin(t * 0.5) * 0.15;
    const pulse = Math.sin(t * 2.1) * 0.08;

    return {
      mel_spectrogram: Array(128).fill(0).map((_, i) => {
        const freq = i / 128;
        const base = Math.exp(-freq * 2) * intensity;
        const harmonics = Math.sin(freq * 20 + titleHash * 0.01 + t * 0.8) * 0.3;
        const wave = Math.sin(t * 1.5 + i * 0.15) * 0.12;
        return Math.max(0, Math.min(1, base + harmonics + wave + pulse));
      }),
      mfcc: Array(13).fill(0).map((_, i) => {
        return Math.max(0, Math.min(1,
          (Math.sin(titleHash * 0.01 + i + t * 0.3) * 0.5 + 0.5) * intensity + breathe
        ));
      }),
      tempo_bpm: 80 + (albumMood * 60) + (Math.sin(titleHash * 0.001) * 20) + Math.sin(t * 0.05) * 3,
      spectral_centroid: 1.5 + albumMood * 3 + Math.sin(titleHash * 0.002 + t * 0.2) * 1.5,
      rms_energy: Math.max(0.1, Math.min(1, 0.3 + intensity * 0.7 + breathe)),
      pitch: 200 + albumMood * 300 + (Math.sin(titleHash * 0.003 + t * 0.15) * 100),
      valence: Math.max(0, Math.min(1, albumMood * 0.6 + intensity * 0.4 + pulse)),
      status: "perceiving",
      track_info: track,
      timestamp: Date.now()
    };
  }

  // ── Real perception via kannaka-ear ───────────────────────

  hearTrack(track) {
    // Start mock perception immediately so the visualizer isn't blank
    this.current = this.generateMockPerception(track);
    this._broadcastPerception(this.current);
    this.startPerceptionLoop();

    // Async kannaka-ear call — non-blocking, updates perception when done
    const filePath = path.join(this._getMusicDir(), track.file);
    execFile(this._kannakabin, ["hear", filePath], { timeout: 30000 }, (err, stdout) => {
      if (!err && stdout) {
        const perception = this._parsePerceptionOutput(stdout, track);
        this.current = perception;
        this._broadcastPerception(perception);
        console.log(`   \uD83D\uDC41 Perception: ${perception.tempo_bpm.toFixed(0)}bpm, valence=${perception.valence.toFixed(2)}, RMS=${perception.rms_energy.toFixed(3)}`);
      }
    });
  }

  _parsePerceptionOutput(output, track) {
    // Extract features from kannaka-ear output
    // For now, generate realistic mock data since we don't have JSON output from kannaka-ear yet
    return this.generateMockPerception(track);
  }

  // ── Perception loop ───────────────────────────────────────

  startPerceptionLoop() {
    this.stopPerceptionLoop();
    const track = this._getCurrentTrack();
    if (!track) return;
    this._interval = setInterval(() => {
      // Only generate + send if someone is listening
      if (this._hasClients()) {
        this.current = this.generateMockPerception(track);
        this._broadcastPerception(this.current);
      }
    }, 500); // 2fps
  }

  stopPerceptionLoop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  getCurrentPerception() {
    return this.current;
  }

  // ── Internal helpers ──────────────────────────────────────

  _broadcastPerception(perception) {
    this._broadcast({ type: "perception", data: perception });
  }

  _hasClients() {
    // Delegate to broadcast — if broadcast is a no-op, no clients
    // The broadcast function itself checks wss.clients.size
    return true; // broadcast handles empty check internally
  }
}

module.exports = { PerceptionEngine };
