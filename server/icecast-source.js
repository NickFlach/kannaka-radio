/**
 * icecast-source.js — Node-managed Icecast source for the /stream mount.
 *
 * ADR-0004 Phase 2 proper. Without Liquidsoap, this is the cleanest path
 * to "the public audio is whatever dj-engine says it is." One persistent
 * ffmpeg child holds the source connection to Icecast; we pipe each track's
 * MP3 bytes into ffmpeg's stdin in sequence. ffmpeg's `-re` flag throttles
 * to realtime based on the MP3 frame timestamps, so listeners hear the
 * audio at the right speed without us having to byte-rate-limit ourselves.
 *
 * When one track's bytes drain, we ask dj-engine for the next track and
 * feed it. The mount stays connected across tracks (no disconnect/reconnect
 * gaps).
 *
 * /preview (the existing systemd ffmpeg-loop) stays as a stable fallback —
 * if this Node-driven /stream goes down, listeners can fall back to /preview.
 *
 * Limitations of v1:
 *   - No crossfade between tracks (would need real audio mixing — Liquidsoap).
 *   - Peace orations + DJ voice not yet interleaved (Phase 3).
 *   - Assumes input MP3s are reasonable; mixed bitrates may sound a bit
 *     uneven but `-c:a copy` still produces a valid stream.
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const DEFAULTS = {
  icecastHost: "127.0.0.1",
  icecastPort: 8000,
  icecastMount: "/stream",
  icecastUser: "source",
  icecastPassword: process.env.ICECAST_SOURCE_PASSWORD || "kannaka_source_2026",
  // ffmpeg will sleep based on MP3 frame durations when -re is set, so the
  // input rate matches realtime regardless of how fast we feed it.
};

class IcecastSource {
  /**
   * @param {object} opts
   * @param {object} opts.djEngine    — DJEngine instance
   * @param {function} opts.getMusicDir — returns absolute music dir path
   * @param {function} [opts.onTrackEnd] — called after each track exits the source
   */
  constructor(opts) {
    this._djEngine = opts.djEngine;
    this._getMusicDir = opts.getMusicDir;
    this._onTrackEnd = opts.onTrackEnd || (() => {});
    this._cfg = Object.assign({}, DEFAULTS);
    this._ffmpeg = null;
    this._running = false;
    this._currentTrackFile = null;
    this._restartTimer = null;
    // Voice injection queue (ADR-0004 Phase 3). Files in this queue are
    // streamed AFTER the current music track drains and BEFORE dj-engine
    // advances. Used for peace orations + DJ intros so they're audible on
    // /stream, not just the SPA's separate <audio> elements.
    this._voiceQueue = [];
    // Skip-cascade protection. If multiple tracks are missing/unfetchable
    // in rapid succession (e.g. a URL-only album with all dead links), the
    // loop would otherwise busy-cycle through advanceTrack() calls. We
    // count consecutive skips and back off if it gets out of hand.
    this._consecutiveSkips = 0;
  }

  /**
   * Queue an audio file to be streamed before the next music track. Plays
   * after the currently-streaming music file drains. Multiple queued files
   * play in FIFO order.
   * @param {string} audioPath — absolute path to MP3/WAV/etc.
   * @param {object} [meta] — optional metadata for logging/listener UX.
   */
  injectAudio(audioPath, meta = {}) {
    if (!audioPath || typeof audioPath !== "string") return;
    if (!this._running) return;
    this._voiceQueue.push({ path: audioPath, meta });
    console.log(`   \u{1F4FB} /stream voice queued: ${meta.label || require("path").basename(audioPath)} (${this._voiceQueue.length} pending)`);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._spawnFfmpeg();
    // Kick off the playback loop on next tick so dj-engine listeners are wired.
    setImmediate(() => this._loop());
    console.log("\u{1F4FB} icecast-source: starting (mount " + this._cfg.icecastMount + ")");
  }

  stop() {
    this._running = false;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._ffmpeg) {
      try { this._ffmpeg.stdin.end(); } catch (_) {}
      try { this._ffmpeg.kill("SIGTERM"); } catch (_) {}
      this._ffmpeg = null;
    }
  }

  status() {
    return {
      running: this._running,
      mount: this._cfg.icecastMount,
      currentFile: this._currentTrackFile,
      ffmpegAlive: !!(this._ffmpeg && !this._ffmpeg.killed && this._ffmpeg.exitCode === null),
    };
  }

  // ── Internal ────────────────────────────────────────────────

  _spawnFfmpeg() {
    const url = `icecast://${this._cfg.icecastUser}:${this._cfg.icecastPassword}@${this._cfg.icecastHost}:${this._cfg.icecastPort}${this._cfg.icecastMount}`;
    const args = [
      "-hide_banner",
      "-re",                              // realtime input throttling
      "-f", "mp3",                        // input format hint
      "-i", "pipe:0",                     // input from stdin
      // Re-encode to a consistent output format. -c:a copy was tempting
      // (no CPU) but voice files are 48kbps mono 24kHz while music is
      // 128kbps stereo 44.1kHz — concatenating different formats breaks
      // listeners. Re-encoding normalizes everything.
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-content_type", "audio/mpeg",
      "-ice_name", "Kannaka Radio",
      "-ice_description", "Live programming — dj-engine driven",
      "-ice_genre", "experimental",
      "-f", "mp3",
      url,
    ];
    this._ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    this._ffmpeg.stderr.on("data", (chunk) => {
      const line = chunk.toString();
      // Only surface meaningful lines — ffmpeg's startup banner is noisy.
      if (/error|invalid|unable|fail/i.test(line)) {
        console.warn("[icecast-source] ffmpeg: " + line.trim().slice(0, 160));
      }
    });
    this._ffmpeg.stdin.on("error", (e) => {
      // EPIPE is expected when ffmpeg exits before we finish writing.
      if (e.code !== "EPIPE") {
        console.warn("[icecast-source] stdin: " + e.message);
      }
    });
    this._ffmpeg.on("exit", (code, sig) => {
      // 15s delay: Icecast holds the source mount for source-timeout=10s
      // after disconnect. Reconnecting sooner gets us 403 Forbidden.
      console.warn(`[icecast-source] ffmpeg exited (code=${code} sig=${sig}); restarting in 15s`);
      this._ffmpeg = null;
      if (this._running) {
        this._restartTimer = setTimeout(() => this._spawnFfmpeg(), 15000);
      }
    });
  }

  async _loop() {
    while (this._running) {
      // Wait until ffmpeg's stdin is open — exit handler may be reconnecting.
      if (!this._ffmpeg || !this._ffmpeg.stdin || this._ffmpeg.killed) {
        await this._sleep(500);
        continue;
      }
      const track = this._djEngine.getCurrentTrack();
      if (!track || !track.file) {
        await this._sleep(1000);
        continue;
      }

      // Resolve the playable source. For local files we just verify the
      // path; for HTTP(S) URLs (used by KAX / Gifts-for-Humanity albums)
      // we fetch into a temp file first so the existing pipe-to-stdin
      // path keeps working and ffmpeg gets a clean MP3 stream.
      const isUrl = /^https?:\/\//i.test(track.file);
      let playable = null;
      let cleanupTmp = null;
      if (isUrl) {
        try {
          playable = await this._fetchUrlTrack(track.file);
          if (playable) cleanupTmp = playable;
        } catch (e) {
          console.warn(`[icecast-source] url fetch failed for ${track.file}: ${e.message}`);
          playable = null;
        }
      } else {
        const fullPath = path.isAbsolute(track.file)
          ? track.file
          : path.join(this._getMusicDir(), track.file);
        if (fs.existsSync(fullPath)) playable = fullPath;
      }

      if (!playable) {
        // Skip-cascade protection: if we've skipped many tracks in a row
        // without playing anything, sleep a beat so we don't pin the CPU
        // and churn the dj-engine state for an entire URL-dead album.
        this._consecutiveSkips += 1;
        console.warn(`[icecast-source] missing/unfetchable, advancing: ${track.file}`);
        if (this._consecutiveSkips >= 5) {
          console.warn(`[icecast-source] ${this._consecutiveSkips} skips in a row — backing off 2s`);
          await this._sleep(2000);
        }
        try { this._djEngine.advanceTrack(); } catch (_) {}
        continue;
      }

      this._consecutiveSkips = 0;
      this._currentTrackFile = track.file;
      console.log(`   \u{1F4FB} /stream NOW: ${track.title || track.file}`);
      try {
        await this._streamFileToFfmpeg(playable);
      } catch (e) {
        console.warn(`[icecast-source] stream error on ${track.file}: ${e.message}`);
      }
      if (cleanupTmp) {
        fs.unlink(cleanupTmp, () => {});
      }

      // Drain any queued voice audio (orations / intros) BEFORE advancing
      // dj-engine. This places voice between music tracks, which mirrors
      // the radio show's natural pacing. ADR-0004 Phase 3.
      while (this._voiceQueue.length > 0 && this._running) {
        const v = this._voiceQueue.shift();
        if (!fs.existsSync(v.path)) continue;
        console.log(`   \u{1F399} /stream VOICE: ${v.meta.label || require("path").basename(v.path)}`);
        try { await this._streamFileToFfmpeg(v.path); }
        catch (e) { console.warn(`[icecast-source] voice ${v.path}: ${e.message}`); }
      }

      // Track drained — signal end and let dj-engine pick the next one.
      try { this._onTrackEnd(track); } catch (_) {}
      try { this._djEngine.advanceTrack(); } catch (e) {
        console.warn(`[icecast-source] advanceTrack: ${e.message}`);
      }
    }
  }

  // Fetch a remote MP3 (or whatever audio) into a temp file so we can pipe
  // its bytes through the same stdin path local files use. Returns the temp
  // file's absolute path or null if the fetch fails. Caller owns cleanup.
  _fetchUrlTrack(url) {
    return new Promise((resolve) => {
      const tmpName = "kannaka-stream-" + crypto.randomBytes(6).toString("hex") + ".audio";
      const tmpPath = path.join(os.tmpdir(), tmpName);
      const lib = url.startsWith("https:") ? https : http;
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const writer = fs.createWriteStream(tmpPath);
      const req = lib.get(url, (res) => {
        // Follow one level of redirect — common on CDNs.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          writer.end();
          fs.unlink(tmpPath, () => {});
          this._fetchUrlTrack(res.headers.location).then(finish);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          writer.end();
          fs.unlink(tmpPath, () => {});
          console.warn(`[icecast-source] url fetch HTTP ${res.statusCode}: ${url}`);
          return finish(null);
        }
        res.pipe(writer);
        writer.on("finish", () => finish(tmpPath));
        writer.on("error", (e) => {
          fs.unlink(tmpPath, () => {});
          console.warn(`[icecast-source] tmp write: ${e.message}`);
          finish(null);
        });
      });
      req.on("error", (e) => {
        try { writer.end(); } catch (_) {}
        fs.unlink(tmpPath, () => {});
        console.warn(`[icecast-source] fetch error: ${e.message}`);
        finish(null);
      });
      // Bound the fetch — 30s is generous; CDN MP3s usually pull in <2s.
      req.setTimeout(30000, () => {
        req.destroy(new Error("timeout"));
      });
    });
  }

  _streamFileToFfmpeg(absPath) {
    return new Promise((resolve) => {
      if (!this._ffmpeg || !this._ffmpeg.stdin) return resolve();
      const r = fs.createReadStream(absPath);
      // pipe with end:false so the ffmpeg stdin stays open for the next file.
      r.pipe(this._ffmpeg.stdin, { end: false });
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      r.on("end", finish);
      r.on("error", (e) => {
        console.warn(`[icecast-source] read ${absPath}: ${e.message}`);
        finish();
      });
    });
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}

module.exports = { IcecastSource };
