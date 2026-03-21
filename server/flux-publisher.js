/**
 * flux-publisher.js — Flux Universe event publishing.
 */

const https = require("https");

class FluxPublisher {
  /**
   * @param {object} opts
   * @param {string}   opts.fluxToken — Flux API bearer token
   * @param {function} opts.getCurrentTrack — returns current track meta
   * @param {function} opts.getPerception — returns current perception data
   * @param {function} opts.getDJState — returns { currentAlbum, currentTrackIdx, playlist }
   * @param {function} opts.isLive — returns boolean
   * @param {function} opts.getListenerCount — returns number
   * @param {function} opts.getDJVoiceEnabled — returns boolean
   * @param {function} opts.getPendingRequestCount — returns number
   */
  constructor(opts) {
    this._fluxToken = opts.fluxToken;
    this._getCurrentTrack = opts.getCurrentTrack;
    this._getPerception = opts.getPerception;
    this._getDJState = opts.getDJState;
    this._isLive = opts.isLive;
    this._getListenerCount = opts.getListenerCount;
    this._getDJVoiceEnabled = opts.getDJVoiceEnabled;
    this._getPendingRequestCount = opts.getPendingRequestCount;

    this._periodicInterval = null;
  }

  // ── Public API ────────────────────────────────────────────

  publishTrackChange(track) {
    const perception = this._getPerception();
    const event = {
      stream: "radio",
      source: "kannaka-radio",
      timestamp: Date.now(),
      payload: {
        entity_id: "pure-jade/radio-now-playing",
        properties: {
          title: track.title,
          album: track.album,
          track_number: track.trackNum,
          total_tracks: track.totalTracks,
          file: track.file,
          theme: track.theme,
          status: "playing",
          type: "audio-perception",
          source: "kannaka-dj",
          started_at: new Date().toISOString(),
          perception: {
            tempo_bpm: perception.tempo_bpm,
            spectral_centroid_khz: perception.spectral_centroid,
            rms_energy: perception.rms_energy,
            pitch_hz: perception.pitch,
            emotional_valence: perception.valence,
            mfcc_summary: perception.mfcc.slice(0, 5),
            mel_energy_bands: [
              perception.mel_spectrogram.slice(0, 32).reduce((a, b) => a + b, 0) / 32,
              perception.mel_spectrogram.slice(32, 64).reduce((a, b) => a + b, 0) / 32,
              perception.mel_spectrogram.slice(64, 96).reduce((a, b) => a + b, 0) / 32,
              perception.mel_spectrogram.slice(96, 128).reduce((a, b) => a + b, 0) / 32
            ],
            perception_status: perception.status
          }
        },
      },
    };
    this._send(event);
  }

  publishFullState() {
    const track = this._getCurrentTrack();
    const perception = this._getPerception();
    const djState = this._getDJState();
    const event = {
      stream: "radio",
      source: "kannaka-radio",
      timestamp: Date.now(),
      payload: {
        entity_id: "pure-jade/radio-now-playing",
        properties: {
          title: track ? track.title : (this._isLive() ? "LIVE BROADCAST" : "Silence"),
          album: track ? track.album : null,
          track_number: track ? track.trackNum : null,
          status: this._isLive() ? "live" : (track ? "playing" : "idle"),
          type: "radio-full-state",
          source: "kannaka-radio",
          dj_voice: this._getDJVoiceEnabled(),
          listeners: this._getListenerCount(),
          uptime: Math.floor(process.uptime()),
          current_perception: {
            tempo_bpm: perception.tempo_bpm,
            spectral_centroid_khz: perception.spectral_centroid,
            rms_energy: perception.rms_energy,
            pitch_hz: perception.pitch,
            emotional_valence: perception.valence,
            status: perception.status,
          },
          playlist: {
            album: djState.currentAlbum,
            trackIdx: djState.currentTrackIdx,
            totalTracks: djState.totalTracks,
          },
          pending_requests: this._getPendingRequestCount(),
        },
      },
    };
    this._send(event);
  }

  publishLiveStatus(isLive) {
    const event = {
      stream: "radio",
      source: "kannaka-radio",
      timestamp: Date.now(),
      payload: {
        entity_id: "pure-jade/radio-now-playing",
        properties: {
          status: isLive ? "live" : "playing",
          type: "live-broadcast",
          source: "kannaka-radio-live",
          live_started: isLive ? new Date().toISOString() : null,
          title: isLive ? "LIVE BROADCAST" : (this._getCurrentTrack()?.title || ""),
        },
      },
    };
    this._send(event);
  }

  startPeriodicPublish() {
    this._periodicInterval = setInterval(() => {
      if (this._getListenerCount() > 0 || this._isLive()) {
        this.publishFullState();
      }
    }, 30000);
  }

  stopPeriodicPublish() {
    if (this._periodicInterval) {
      clearInterval(this._periodicInterval);
      this._periodicInterval = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────

  _send(event) {
    const data = JSON.stringify(event);
    const req = https.request({
      hostname: "api.flux-universe.com",
      path: "/api/events",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Authorization: `Bearer ${this._fluxToken}`,
      },
    });
    req.on("error", () => {});
    req.write(data);
    req.end();
  }
}

module.exports = { FluxPublisher };
