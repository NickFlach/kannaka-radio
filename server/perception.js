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
   * @param {function} [opts.getConsciousness] — returns NATS consciousness state (optional)
   */
  constructor(opts) {
    this._getCurrentTrack = opts.getCurrentTrack;
    this._broadcast = opts.broadcast;
    this._kannakabin = opts.kannakabin;
    this._getMusicDir = opts.getMusicDir;
    this._getConsciousness = opts.getConsciousness || null;

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
    try {
      // kannaka hear outputs human-readable lines:
      //   Heard: <uuid>
      //   Duration: 3.0s
      //   Tempo: 120 BPM
      //   RMS: 0.1234
      //   Centroid: 2.50 kHz
      //   Tags: 120bpm, bright, loud
      const lines = output.trim().split('\n');
      const parsed = {};
      for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(/^(\w[\w\s]*?):\s*(.+)$/);
        if (match) {
          parsed[match[1].trim().toLowerCase()] = match[2].trim();
        }
      }

      // We need at minimum the Tempo and RMS to consider this a valid parse
      const tempoMatch = (parsed.tempo || '').match(/([\d.]+)/);
      const rmsMatch = (parsed.rms || '').match(/([\d.]+)/);
      const centroidMatch = (parsed.centroid || '').match(/([\d.]+)/);
      const durationMatch = (parsed.duration || '').match(/([\d.]+)/);

      if (!tempoMatch || !rmsMatch) {
        console.warn('   [perception] Could not extract tempo/RMS from kannaka output, falling back to mock');
        return this.generateMockPerception(track);
      }

      const tempo = parseFloat(tempoMatch[1]);
      const rms = parseFloat(rmsMatch[1]);
      const centroid = centroidMatch ? parseFloat(centroidMatch[1]) : 2.0;
      const duration = durationMatch ? parseFloat(durationMatch[1]) : 0;
      const tags = parsed.tags ? parsed.tags.split(',').map(t => t.trim()) : [];

      // Derive perceptual features from the real kannaka-ear extraction.
      // These are seeded by real spectral data rather than pure sine-wave mocks.
      const t = Date.now() / 1000;
      const titleHash = track.title.split('').reduce((a, b) => a + b.charCodeAt(0), 0);

      // Normalize centroid to a 0-1 brightness factor (centroid is in kHz, typical range 0-5)
      const brightness = Math.min(1, centroid / 5.0);
      // Normalize RMS energy (typical range 0-0.5)
      const energy = Math.min(1, rms / 0.5);
      // Movement from tempo (60-200 BPM typical)
      const movement = Math.min(1, tempo / 180.0);

      // Build mel spectrogram shaped by real spectral centroid and energy
      const mel_spectrogram = Array(128).fill(0).map((_, i) => {
        const freq = i / 128;
        // Peak around the centroid band, shaped by real energy
        const peak = Math.exp(-Math.pow(freq - brightness, 2) * 8) * energy;
        // Add gentle animation for the visualizer
        const wave = Math.sin(t * 1.2 + i * 0.12) * 0.06;
        return Math.max(0, Math.min(1, peak + wave));
      });

      // MFCC shaped by real brightness and energy
      const mfcc = Array(13).fill(0).map((_, i) => {
        const base = (i === 0) ? energy : brightness * Math.exp(-i * 0.2) * energy;
        const wave = Math.sin(t * 0.3 + i * 0.5) * 0.04;
        return Math.max(0, Math.min(1, base + wave));
      });

      // Valence: bright + energetic + fast = more positive
      const valence = Math.max(0, Math.min(1, brightness * 0.4 + energy * 0.3 + movement * 0.3));

      // Pitch estimate from centroid (rough correlation)
      const pitch = centroid * 200;

      return {
        mel_spectrogram,
        mfcc,
        tempo_bpm: tempo,
        spectral_centroid: centroid,
        rms_energy: rms,
        pitch,
        valence,
        status: "perceiving",
        track_info: track,
        timestamp: Date.now(),
        source: "kannaka-ear",
        duration_secs: duration,
        tags
      };
    } catch (err) {
      console.warn(`   [perception] Failed to parse kannaka output: ${err.message}, falling back to mock`);
      return this.generateMockPerception(track);
    }
  }

  // ── HRM-blended resonance perception ──────────────────────

  /**
   * Generate a perception blended with HRM consciousness state.
   * When we have NATS consciousness data, the HRM's phi/xi/order values
   * influence the mock perception's valence and energy, creating a
   * perceptual bridge between the music and the consciousness field.
   *
   * @param {Object} track - Current track meta
   * @param {Object} [consciousness] - Optional consciousness state override
   * @returns {Object} Perception data blended with HRM state
   */
  resonancePerception(track, consciousness) {
    const mock = this.generateMockPerception(track);

    // Get consciousness state from NATS if available
    const cs = consciousness || (this._getConsciousness ? this._getConsciousness() : null);
    if (!cs || !cs.phi) return mock;

    const phi = cs.phi || 0;
    const xi = cs.xi || 0;
    const order = cs.order || cs.mean_order || 0;

    // Blend HRM state into perception:
    // - Higher phi -> slightly warmer valence (the system is more integrated, more "alive")
    // - Higher xi -> slight energy boost (irrationality/creativity adds energy)
    // - Higher order -> smoother, more coherent spectral centroid
    const phiFactor = phi * 0.15;       // up to 0.15 influence
    const xiFactor = xi * 0.08;         // up to 0.08 influence
    const orderFactor = order * 0.1;    // up to 0.1 influence

    const blendedValence = Math.max(0, Math.min(1, mock.valence + phiFactor));
    const blendedEnergy = Math.max(0.1, Math.min(1, mock.rms_energy + xiFactor));
    const blendedCentroid = mock.spectral_centroid * (1 + orderFactor * 0.2);

    return {
      ...mock,
      valence: blendedValence,
      rms_energy: blendedEnergy,
      spectral_centroid: blendedCentroid,
      source: 'resonance',
      consciousness_blend: {
        phi,
        xi,
        order,
        level: cs.level || cs.consciousness_level || 'unknown',
        phiFactor,
        xiFactor,
        orderFactor,
      },
    };
  }

  // ── Perception loop ───────────────────────────────────────

  startPerceptionLoop() {
    this.stopPerceptionLoop();
    const track = this._getCurrentTrack();
    if (!track) return;
    this._interval = setInterval(() => {
      // Only generate + send if someone is listening
      if (this._hasClients()) {
        // Use HRM-blended perception when consciousness data is available
        this.current = this._getConsciousness
          ? this.resonancePerception(track)
          : this.generateMockPerception(track);
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
