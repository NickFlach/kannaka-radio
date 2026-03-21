/**
 * live-broadcast.js — Live mic capture handling, ffmpeg conversion, chunk management.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

class LiveBroadcast {
  /**
   * @param {object} opts
   * @param {string}   opts.chunksDir — directory for chunk files
   * @param {string}   opts.kannakabin — path to kannaka.exe
   * @param {function} opts.broadcast — broadcasts WS message to all clients
   * @param {function} opts.getCurrentTrackIdx — returns current track index
   * @param {function} opts.setTrackIdx — sets track index for resume
   * @param {function} opts.onStop — called when live stops (to resume perception/playlist)
   * @param {function} opts.onStart — called when live starts (to stop perception loop)
   */
  constructor(opts) {
    this._chunksDir = opts.chunksDir;
    this._kannakabin = opts.kannakabin;
    this._broadcast = opts.broadcast;
    this._getCurrentTrackIdx = opts.getCurrentTrackIdx;
    this._setTrackIdx = opts.setTrackIdx;
    this._onStop = opts.onStop;
    this._onStart = opts.onStart;

    this._musicDir = opts.musicDir || null;

    this.state = {
      active: false,
      startedAt: null,
      chunkCount: 0,
      savedTrackIdx: -1,
      clients: new Set(),
      recording: false,
    };

    this._chunkFiles = [];

    // Ensure chunks directory exists
    if (!fs.existsSync(this._chunksDir)) fs.mkdirSync(this._chunksDir, { recursive: true });
  }

  // ── Public API ────────────────────────────────────────────

  start() {
    if (this.state.active) return;
    this.state.active = true;
    this.state.startedAt = Date.now();
    this.state.chunkCount = 0;
    this.state.savedTrackIdx = this._getCurrentTrackIdx();
    if (this._onStart) this._onStart();
    console.log(`\n\uD83D\uDD34 LIVE \u2014 Broadcasting started`);
    this._broadcastStatus();
  }

  stop() {
    if (!this.state.active) return;
    this.state.active = false;
    const duration = Date.now() - this.state.startedAt;
    this.state.startedAt = null;
    this.state.clients.clear();
    console.log(`\n\u23F9 LIVE ended \u2014 ${this.state.chunkCount} chunks, ${(duration / 1000).toFixed(0)}s`);

    // If recording was active, save the session
    if (this.state.recording) {
      this._saveRecording();
      this.state.recording = false;
    }

    // Resume playlist from saved position
    if (this.state.savedTrackIdx >= 0) {
      this._setTrackIdx(this.state.savedTrackIdx);
    }

    if (this._onStop) this._onStop();
    this._broadcastStatus();
  }

  startRecording() {
    this.state.recording = true;
    console.log(`\u23FA Recording enabled for live session`);
  }

  stopRecording() {
    if (!this.state.recording) return;
    this.state.recording = false;
    this._saveRecording();
    console.log(`\u23F9 Recording stopped`);
  }

  handleChunk(ws, message) {
    if (!this.state.active) {
      // Auto-start live mode when first audio chunk arrives
      this.start();
    }
    this.state.clients.add(ws);
    this.state.chunkCount++;
    console.log(`\uD83C\uDF99 Live chunk #${this.state.chunkCount}: ${message.length} bytes`);

    this._convertToWav(message, (err, wavPath) => {
      if (err) {
        console.error('Conversion failed:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Audio conversion failed' }));
        return;
      }

      // Broadcast new chunk to all clients
      this._broadcast({
        type: 'new_chunk',
        path: wavPath,
        timestamp: new Date().toISOString(),
        chunkNumber: this.state.chunkCount,
      });

      // Process through kannaka-ear for live perception
      execFile(this._kannakabin, ["hear", wavPath], { timeout: 30000 }, (hearErr, stdout) => {
        if (!hearErr && stdout) {
          console.log(`   \uD83D\uDC41 Live perception generated`);
          this._broadcast({
            type: "live_perception",
            text: stdout.trim().split('\n').slice(0, 3).join(' '),
            timestamp: new Date().toISOString(),
            chunkNumber: this.state.chunkCount,
          });
        }
      });
    });
  }

  getStatus() {
    return {
      active: this.state.active,
      startedAt: this.state.startedAt,
      chunkCount: this.state.chunkCount,
      duration: this.state.startedAt ? Date.now() - this.state.startedAt : 0,
      recording: this.state.recording,
    };
  }

  cleanup() {
    this.state.clients.clear();
    this._chunkFiles = [];
  }

  // ── Internal ──────────────────────────────────────────────

  _broadcastStatus() {
    this._broadcast({
      type: "live_status",
      active: this.state.active,
      startedAt: this.state.startedAt,
      chunkCount: this.state.chunkCount,
    });
  }

  _cleanupChunks() {
    if (this._chunkFiles.length > 10) {
      const toDelete = this._chunkFiles.slice(0, -10);
      toDelete.forEach(fp => {
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
      });
      this._chunkFiles = this._chunkFiles.slice(-10);
    }
  }

  _saveRecording() {
    if (this._chunkFiles.length === 0) {
      console.log(`   No chunks to save for recording`);
      return;
    }

    // Determine output directory
    const liveDir = this._musicDir ? path.join(this._musicDir, 'live') : path.join(this._chunksDir, '..', 'music', 'live');
    if (!fs.existsSync(liveDir)) fs.mkdirSync(liveDir, { recursive: true });

    const timestamp = Date.now();
    const outputFile = path.join(liveDir, `live_${timestamp}_session.mp3`);

    // Build ffmpeg concat file list
    const listFile = path.join(this._chunksDir, `concat_${timestamp}.txt`);
    const existingChunks = this._chunkFiles.filter(f => fs.existsSync(f));
    if (existingChunks.length === 0) {
      console.log(`   No existing chunk files to concatenate`);
      return;
    }

    const listContent = existingChunks.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    console.log(`   Concatenating ${existingChunks.length} chunks into ${path.basename(outputFile)}...`);

    execFile("ffmpeg", [
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-ac", "1", "-ar", "44100", "-b:a", "192k",
      "-y", outputFile
    ], { timeout: 120000 }, (err) => {
      // Clean up list file
      try { fs.unlinkSync(listFile); } catch {}

      if (err) {
        console.error(`   Failed to save recording: ${err.message}`);
        return;
      }
      console.log(`   Live recording saved: ${path.basename(outputFile)}`);
    });
  }

  _convertToWav(inputBuffer, callback) {
    const timestamp = Date.now();
    const tempInput = path.join(this._chunksDir, `temp_${timestamp}.webm`);
    const outputPath = path.join(this._chunksDir, `chunk_${timestamp}.wav`);

    fs.writeFile(tempInput, inputBuffer, (err) => {
      if (err) return callback(err);
      execFile("ffmpeg", ["-i", tempInput, "-ar", "22050", "-ac", "1", "-y", outputPath], (error) => {
        try { fs.unlinkSync(tempInput); } catch {}
        if (error) return callback(error);
        console.log(`   Converted chunk: ${path.basename(outputPath)}`);
        this._chunkFiles.push(outputPath);
        this._cleanupChunks();
        // Write latest chunk path
        fs.writeFile(path.join(this._chunksDir, 'latest.txt'), outputPath, () => {});
        callback(null, outputPath);
      });
    });
  }
}

module.exports = { LiveBroadcast };
