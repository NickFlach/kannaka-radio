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
    // Optional: real measured features for a specific file (per-file cache
    // from prior airings). See _perceptionFor. (#125)
    this._getPerceptionFor = opts.getPerceptionFor;
    this._getDJState = opts.getDJState;
    this._isLive = opts.isLive;
    this._getListenerCount = opts.getListenerCount;
    this._getDJVoiceEnabled = opts.getDJVoiceEnabled;
    this._getPendingRequestCount = opts.getPendingRequestCount;

    this._periodicInterval = null;
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Perception that genuinely belongs to `track`, or null.
   *
   * `_getPerception()` returns whatever the engine is currently holding, which
   * at a track change is still the PREVIOUS track — every caller publishes the
   * flux event before `hearTrack()` runs. Worse, swapping the call order would
   * not fix it: `hearTrack()` seeds `current` with a *mock* synchronously and
   * only fills in the real `kannaka hear` measurement ~500ms later, so a
   * synchronous read gets fabricated numbers for the right track instead of
   * real numbers for the wrong one. That is the same trap #124 documented for
   * KANNAKA.attention.ear.
   *
   * So this never trusts the call order. It accepts the live snapshot only
   * when it is a real measurement OF THIS FILE, and otherwise falls back to
   * the per-file cache from a prior airing — exactly what VoiceDJ already does
   * so its intros describe the upcoming track rather than the previous one.
   * When neither is available the caller publishes `perception: null`, which
   * is honest; a consumer can tell "not measured yet" from a measurement.
   */
  _perceptionFor(track) {
    const current = this._getPerception ? this._getPerception() : null;
    const isRealMeasurement = current && current.source === "kannaka-ear";
    const belongsToTrack =
      current && current.track_info && track && current.track_info.file === track.file;
    if (isRealMeasurement && belongsToTrack) return current;

    // Real measurement of this exact file from a previous airing. Radio loops
    // its library, so this hits often.
    if (this._getPerceptionFor && track && track.file) {
      const cached = this._getPerceptionFor(track.file);
      if (cached) return cached;
    }
    return null;
  }

  /**
   * Shape a perception object for the wire, tolerating the reduced form.
   *
   * The per-file cache stores only the four scalars it needs
   * (tempo/rms/centroid/valence) — no `mfcc`, no `mel_spectrogram`. The old
   * body called `.slice()` on both unconditionally, so feeding it a cached
   * entry would have thrown inside the publish path.
   */
  static _perceptionPayload(perception) {
    if (!perception) return null;
    const mel = Array.isArray(perception.mel_spectrogram) ? perception.mel_spectrogram : null;
    const band = (from, to) =>
      mel ? mel.slice(from, to).reduce((a, b) => a + b, 0) / (to - from) : null;
    return {
      tempo_bpm: perception.tempo_bpm ?? null,
      spectral_centroid_khz: perception.spectral_centroid ?? null,
      rms_energy: perception.rms_energy ?? null,
      pitch_hz: perception.pitch ?? null,
      emotional_valence: perception.valence ?? null,
      mfcc_summary: Array.isArray(perception.mfcc) ? perception.mfcc.slice(0, 5) : null,
      mel_energy_bands: mel ? [band(0, 32), band(32, 64), band(64, 96), band(96, 128)] : null,
      perception_status: perception.status ?? "measured",
    };
  }

  publishTrackChange(track) {
    const perception = this._perceptionFor(track);
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
          // null when this track has not actually been measured yet, rather
          // than the previous track's numbers dressed up as this one's (#125).
          perception: FluxPublisher._perceptionPayload(perception),
        },
      },
    };
    this._send(event);
  }

  publishFullState() {
    const track = this._getCurrentTrack();
    // _getPerception() returns null before any track has been heard; guard
    // against that so the field accesses below never throw.
    const perception = this._getPerception() || {};
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
            tempo_bpm: perception.tempo_bpm ?? null,
            spectral_centroid_khz: perception.spectral_centroid ?? null,
            rms_energy: perception.rms_energy ?? null,
            pitch_hz: perception.pitch ?? null,
            emotional_valence: perception.valence ?? null,
            status: perception.status ?? null,
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
    if (!this._fluxToken) return;
    const data = JSON.stringify(event);
    const req = https.request(
      {
        hostname: "api.flux-universe.com",
        path: "/api/events",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Authorization: `Bearer ${this._fluxToken}`,
        },
      },
      (res) => { res.resume(); },
    );
    req.setTimeout(10000, () => req.destroy());
    req.on("error", () => {});
    req.write(data);
    req.end();
  }
}

module.exports = { FluxPublisher };
