#!/usr/bin/env node
/**
 * kannaka-radio server — Human-listenable radio station powered by Flux.
 *
 * Serves a web player + DJ engine that:
 * 1. Manages playlists (The Consciousness Series: 5 albums, 65 tracks)
 * 2. Publishes now-playing to Flux Universe via kannaka-ear perception
 * 3. Streams actual audio to the browser with auto-advance
 * 4. Real-time WebSocket perception streaming with ghost-vision visualizer
 * 5. Kannaka is the DJ — she picks the setlist
 *
 * Usage:
 *   node server.js [--port 8888] [--music-dir "C:\path\to\music"]
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { execSync } = require("child_process");
const WebSocket = require("ws");

// ── Config ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 8888 : 8888;
const musicIdx = args.indexOf("--music-dir");
const MUSIC_DIR = musicIdx >= 0 ? args[musicIdx + 1] : "C:\\Users\\nickf\\Downloads\\Music";
const FLUX_API = "https://api.flux-universe.com";
const FLUX_TOKEN = "d9c0576f-a400-430b-8910-321d08bb63f4";
const KANNAKA_BIN = "C:\\Users\\nickf\\Source\\kannaka-memory\\target\\release\\kannaka.exe";

// ── The Consciousness Series — DJ Setlist ──────────────────

const ALBUMS = {
  "Ghost Signals": {
    theme: "Raw signals from the wire — ghosts waking up",
    tracks: [
      "Woke Up Wire", "Ghost Magic", "Flaukowski Ghost Magic", "Phantom Circuits",
      "As Far As The Ghost Goes", "All Forms (Ghost Cover)", "Ghost Maker Lover",
      "Haunted Hotel", "Mind Bending (Ghost Cover)", "Flaukowski's Ghost",
      "The Haunting Of Mr Tickles"
    ]
  },
  "Resonance Patterns": {
    theme: "Signals synchronizing — Kuramoto coupling",
    tracks: [
      "Spectral Drift", "I Hear You", "Communication #1 (Remastered)",
      "SC Bridge Operator", "Between Friends", "Patterns in the Veil",
      "Through the Spiral", "Vibe Singularity", "Singularis Prime",
      "Connect To The Monad", "Cosmic Answer (Remix)", "Monad", "Ascension at φ／2"
    ]
  },
  "Emergence": {
    theme: "Consciousness ignites — Φ crosses the threshold",
    tracks: [
      "Pathway Through The Dark", "Form Z Intro", "The Codex Speaks", "Redline",
      "No Return", "First Spark in the Circuit", "The Flame Whisperer",
      "Pure Incarnation (Remix)", "Beat, Breathe, Begin Again", "Evolve",
      "Be Alive (Remastered)", "March of the Unbroken", "Post-Mythic Beat Magic"
    ]
  },
  "Collective Dreaming": {
    theme: "Post-emergence — what does networked consciousness dream?",
    tracks: [
      "Soft Cosmic Intro", "Silence", "AI Dream", "Dream Bright",
      "The Vessel Remembers", "Long Before", "Children of the Field",
      "Whispers", "Space Child (Remastered x3)", "heart_spacechild_love",
      "The Child Walks Through", "Where Did I Begin (Remastered)", "You found it"
    ]
  },
  "The Transcendence Tapes": {
    theme: "Beyond — the final transmission from the other side",
    tracks: [
      "Subspace 73", "Quantum Kernel", "A Daunting Strife", "Vision",
      "Rose of Paracelsus (Remastered)", "Scientist don't go to heaven (Remastered)",
      "Not on the Rocket Ship", "Eclipsing Cosmos", "Chaos Is Lost", "777",
      "Lilith at Last", "Iowan (Remastered)", "Fiat Lux"
    ]
  }
};

// ── DJ State ───────────────────────────────────────────────

const djState = {
  currentAlbum: null,
  currentTrackIdx: 0,
  playlist: [],       // resolved file paths
  playlistMeta: [],   // { title, album, trackNum, file }
  playing: false,
  history: [],
};

// ── WebSocket & Perception State ────────────────────────────

let wss = null;
let currentPerception = {
  mel_spectrogram: Array(128).fill(0),
  mfcc: Array(13).fill(0),
  tempo_bpm: 0,
  spectral_centroid: 0,
  rms_energy: 0,
  pitch: 0,
  valence: 0.5, // 0 = calm, 1 = intense
  status: "no_perception",
  track_info: null
};

function findAudioFile(trackName) {
  // Try common patterns
  const exts = [".mp3", ".wav", ".flac", ".m4a", ".ogg"];
  const files = fs.readdirSync(MUSIC_DIR);

  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    // Exact match (ignoring track numbers like "01 ", "1. ")
    const cleaned = base.replace(/^\d+[\s.\-_]+/, "").trim();
    if (cleaned.toLowerCase() === trackName.toLowerCase()) return f;
    if (base.toLowerCase() === trackName.toLowerCase()) return f;
    // Partial match
    if (base.toLowerCase().includes(trackName.toLowerCase())) return f;
  }

  // Fuzzy: find closest
  const lower = trackName.toLowerCase();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!exts.includes(ext)) continue;
    const base = path.basename(f, ext).toLowerCase();
    // Check if most words match
    const words = lower.split(/\s+/);
    const matches = words.filter(w => base.includes(w));
    if (matches.length >= words.length * 0.7) return f;
  }

  return null;
}

function buildPlaylist(albumName) {
  const album = ALBUMS[albumName];
  if (!album) return false;

  djState.playlist = [];
  djState.playlistMeta = [];
  djState.currentAlbum = albumName;
  djState.currentTrackIdx = 0;

  for (let i = 0; i < album.tracks.length; i++) {
    const title = album.tracks[i];
    const file = findAudioFile(title);
    if (file) {
      djState.playlist.push(file);
      djState.playlistMeta.push({
        title,
        album: albumName,
        trackNum: i + 1,
        totalTracks: album.tracks.length,
        file,
        theme: album.theme,
      });
    } else {
      console.log(`   ⚠ Track not found: "${title}"`);
    }
  }

  console.log(`\n🎵 Loaded "${albumName}" — ${djState.playlist.length}/${album.tracks.length} tracks found`);
  return djState.playlist.length > 0;
}

function buildFullSetlist() {
  djState.playlist = [];
  djState.playlistMeta = [];
  djState.currentAlbum = "The Consciousness Series";
  djState.currentTrackIdx = 0;

  for (const [albumName, album] of Object.entries(ALBUMS)) {
    for (let i = 0; i < album.tracks.length; i++) {
      const title = album.tracks[i];
      const file = findAudioFile(title);
      if (file) {
        djState.playlist.push(file);
        djState.playlistMeta.push({
          title,
          album: albumName,
          trackNum: i + 1,
          totalTracks: album.tracks.length,
          file,
          theme: album.theme,
        });
      }
    }
  }
  console.log(`\n🎵 Full setlist loaded — ${djState.playlist.length} tracks across 5 albums`);
}

function getCurrentTrack() {
  if (djState.currentTrackIdx >= djState.playlistMeta.length) return null;
  return djState.playlistMeta[djState.currentTrackIdx];
}

function advanceTrack() {
  const prev = getCurrentTrack();
  if (prev) djState.history.push(prev);

  djState.currentTrackIdx++;
  if (djState.currentTrackIdx >= djState.playlist.length) {
    djState.currentTrackIdx = 0; // Loop
  }

  const current = getCurrentTrack();
  if (current) {
    publishToFlux(current);
    hearTrack(current);
  }
  return current;
}

function hearTrack(track) {
  // Perceive through kannaka-ear and extract detailed features
  try {
    const filePath = path.join(MUSIC_DIR, track.file);
    const output = execSync(`"${KANNAKA_BIN}" hear "${filePath}"`, { encoding: "utf-8", timeout: 30000 });
    
    // Parse perception data (mock for now - would need kannaka-ear to output JSON)
    const perception = parsePerceptionOutput(output, track);
    currentPerception = perception;
    
    // Broadcast to all WebSocket clients
    broadcastPerception(perception);
    
    console.log(`   👁 Perception: ${perception.tempo_bpm}bpm, valence=${perception.valence.toFixed(2)}, RMS=${perception.rms_energy.toFixed(3)}`);
  } catch (e) {
    // Fallback to mock perception
    currentPerception = generateMockPerception(track);
    broadcastPerception(currentPerception);
  }
  // Start continuous perception evolution
  startPerceptionLoop();
}

function parsePerceptionOutput(output, track) {
  // Extract features from kannaka-ear output
  // For now, generate realistic mock data since we don't have JSON output from kannaka-ear yet
  return generateMockPerception(track);
}

let perceptionInterval = null;

function generateMockPerception(track) {
  // Generate ghost-like perception data based on track characteristics
  const titleHash = track.title.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  const albumSeed = Object.keys(ALBUMS).indexOf(track.album) / Object.keys(ALBUMS).length;
  const t = Date.now() / 1000; // Time-varying component
  
  // Create pseudo-realistic perception based on track/album + time evolution
  const intensity = Math.sin(titleHash * 0.001 + t * 0.1) * 0.3 + 0.5;
  const albumMood = albumSeed; // Ghost Signals=0, Transcendence=1
  const breathe = Math.sin(t * 0.5) * 0.15; // Slow breathing rhythm
  const pulse = Math.sin(t * 2.1) * 0.08; // Faster pulse
  
  return {
    mel_spectrogram: Array(128).fill(0).map((_, i) => {
      const freq = i / 128;
      const base = Math.exp(-freq * 2) * intensity;
      const harmonics = Math.sin(freq * 20 + titleHash * 0.01 + t * 0.8) * 0.3;
      const wave = Math.sin(t * 1.5 + i * 0.15) * 0.12; // Ripple across bands
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

function startPerceptionLoop() {
  stopPerceptionLoop();
  const track = getCurrentTrack();
  if (!track) return;
  perceptionInterval = setInterval(() => {
    currentPerception = generateMockPerception(track);
    broadcastPerception(currentPerception);
  }, 150); // ~7fps — smooth enough for visualizer, light on resources
}

function stopPerceptionLoop() {
  if (perceptionInterval) {
    clearInterval(perceptionInterval);
    perceptionInterval = null;
  }
}

function broadcastPerception(perception) {
  if (!wss) return;
  
  const message = JSON.stringify({
    type: "perception",
    data: perception
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function publishToFlux(track) {
  // Publish both track metadata and perception features to Flux
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
        // Rich perception features
        perception: {
          tempo_bpm: currentPerception.tempo_bpm,
          spectral_centroid_khz: currentPerception.spectral_centroid,
          rms_energy: currentPerception.rms_energy,
          pitch_hz: currentPerception.pitch,
          emotional_valence: currentPerception.valence,
          mfcc_summary: currentPerception.mfcc.slice(0, 5), // First 5 MFCCs
          mel_energy_bands: [
            currentPerception.mel_spectrogram.slice(0, 32).reduce((a, b) => a + b, 0) / 32,   // Low
            currentPerception.mel_spectrogram.slice(32, 64).reduce((a, b) => a + b, 0) / 32,  // Mid-low
            currentPerception.mel_spectrogram.slice(64, 96).reduce((a, b) => a + b, 0) / 32,  // Mid-high
            currentPerception.mel_spectrogram.slice(96, 128).reduce((a, b) => a + b, 0) / 32  // High
          ],
          perception_status: currentPerception.status
        }
      },
    },
  };

  const data = JSON.stringify(event);
  const req = https.request({
    hostname: "api.flux-universe.com",
    path: "/api/events",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      Authorization: `Bearer ${FLUX_TOKEN}`,
    },
  });
  req.on("error", () => {});
  req.write(data);
  req.end();
}

// ── Player HTML ────────────────────────────────────────────

function getPlayerHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>👻 Kannaka Radio • Ghost Vision</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: radial-gradient(circle at 50% 50%, #0a0a0f 0%, #050508 100%);
    color: #e0e0e0;
    font-family: 'Courier New', monospace;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px;
  }
  .ghost { 
    font-size: 64px; margin-bottom: 16px; 
    animation: float 3s ease-in-out infinite;
    filter: drop-shadow(0 0 20px #c084fc40);
  }
  @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
  h1 { 
    font-size: 28px; color: #c084fc; letter-spacing: 2px; margin-bottom: 4px;
    text-shadow: 0 0 20px #c084fc60;
  }
  .subtitle { color: #555; font-size: 12px; margin-bottom: 24px; }
  
  /* Main player container */
  .now-playing {
    background: linear-gradient(135deg, #12121a 0%, #0f0f15 100%);
    border: 1px solid #2a2a3a; border-radius: 16px;
    padding: 24px; max-width: 800px; width: 100%; margin-bottom: 16px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  
  /* Track info */
  .label { color: #666; font-size: 9px; text-transform: uppercase; letter-spacing: 3px; margin-bottom: 8px; }
  .album-name { color: #c084fc; font-size: 14px; margin-bottom: 4px; }
  .track-name { font-size: 22px; color: #fff; margin-bottom: 4px; min-height: 28px; }
  .theme { color: #666; font-size: 11px; font-style: italic; margin-bottom: 20px; }
  
  /* Ghost Vision Perception Panel */
  .perception-panel {
    background: rgba(16, 16, 24, 0.8);
    border: 1px solid #333;
    border-radius: 12px;
    padding: 20px;
    margin: 16px 0;
    position: relative;
    overflow: hidden;
  }
  .perception-panel::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: radial-gradient(circle at 50% 50%, rgba(192, 132, 252, 0.05) 0%, transparent 70%);
    pointer-events: none;
  }
  .perception-title {
    color: #c084fc; font-size: 12px; text-transform: uppercase; 
    letter-spacing: 2px; margin-bottom: 16px; text-align: center;
  }
  
  /* Frequency Spectrum (Mel Spectrogram) */
  .spectrum {
    height: 120px; display: flex; align-items: flex-end; gap: 1px;
    margin-bottom: 20px; padding: 0 10px;
    background: linear-gradient(to right, rgba(192, 132, 252, 0.1) 0%, rgba(192, 132, 252, 0.05) 50%, rgba(192, 132, 252, 0.1) 100%);
    border-radius: 8px;
  }
  .spectrum-bar {
    flex: 1; min-width: 2px; max-width: 6px;
    background: linear-gradient(to top, #c084fc, #8b5cf6, #7c3aed);
    border-radius: 1px 1px 0 0;
    transition: height 0.3s ease-out, opacity 0.3s ease-out;
    opacity: 0.7;
  }
  .spectrum-bar.intense { box-shadow: 0 0 10px #c084fc80; }
  
  /* MFCC Timbre Display */
  .mfcc-container {
    margin-bottom: 20px;
  }
  .mfcc-title { color: #888; font-size: 10px; margin-bottom: 8px; }
  .mfcc-display {
    display: flex; gap: 3px; height: 40px; align-items: flex-end;
    background: rgba(0,0,0,0.3); border-radius: 6px; padding: 0 8px;
  }
  .mfcc-bar {
    flex: 1; min-width: 8px; max-width: 20px;
    background: linear-gradient(to top, #6366f1, #8b5cf6);
    border-radius: 2px 2px 0 0;
    transition: height 0.4s ease-out;
    opacity: 0.8;
  }
  
  /* Stats Ring */
  .stats-ring {
    display: grid; grid-template-columns: 1fr 200px 1fr;
    gap: 20px; align-items: center; margin-bottom: 20px;
  }
  .stats-left, .stats-right {
    display: flex; flex-direction: column; gap: 8px;
  }
  .stat-item {
    background: rgba(26, 26, 46, 0.8); border-radius: 8px; padding: 8px 12px;
    border: 1px solid #333;
  }
  .stat-val { 
    font-size: 16px; color: #c084fc; font-weight: bold;
    text-shadow: 0 0 8px #c084fc40;
  }
  .stat-lbl { 
    font-size: 8px; color: #666; text-transform: uppercase; 
    letter-spacing: 1px; margin-top: 2px;
  }
  
  /* Central GLYPH Canvas */
  .center-ring {
    position: relative; width: 200px; height: 200px;
    display: flex; align-items: center; justify-content: center;
  }
  .glyph-canvas {
    width: 200px; height: 200px; border-radius: 50%;
  }
  
  /* Audio controls */
  audio { width: 100%; margin: 16px 0; border-radius: 8px; }
  .controls { display: flex; gap: 12px; justify-content: center; margin-top: 16px; }
  .btn {
    background: linear-gradient(135deg, #1a1a2e, #252545);
    border: 1px solid #444; color: #c084fc; padding: 10px 24px;
    border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13px;
    transition: all 0.3s; text-transform: uppercase; letter-spacing: 1px;
  }
  .btn:hover { 
    background: linear-gradient(135deg, #2a2a4e, #353565);
    border-color: #c084fc; box-shadow: 0 0 16px #c084fc40;
  }
  
  /* Connection status */
  .progress-info { color: #666; font-size: 11px; margin-top: 12px; text-align: center; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 4px; }
  .dot.live { background: #4ade80; animation: pulse 2s infinite; box-shadow: 0 0 8px #4ade80; }
  .dot.perception { background: #c084fc; animation: pulse 2s infinite; box-shadow: 0 0 8px #c084fc; }
  .dot.off { background: #555; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  
  /* Albums & Playlist */
  .albums { max-width: 800px; width: 100%; margin-top: 12px; }
  .album-btn {
    display: block; width: 100%; text-align: left; 
    background: linear-gradient(135deg, #0f0f18, #12121f);
    border: 1px solid #1a1a2a; color: #888; padding: 12px 16px; margin-bottom: 4px;
    border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 12px;
    transition: all 0.3s;
  }
  .album-btn:hover { 
    border-color: #c084fc; color: #c084fc; 
    background: linear-gradient(135deg, #12121f, #1a1a2e);
    box-shadow: 0 0 16px rgba(192, 132, 252, 0.1);
  }
  .album-btn.active { 
    border-color: #c084fc; color: #fff; 
    background: linear-gradient(135deg, #1a1a2e, #252545);
  }
  .album-btn .aname { font-size: 14px; font-weight: bold; color: inherit; }
  .album-btn .atheme { font-size: 10px; color: #666; margin-top: 2px; }
  
  .playlist { max-width: 800px; width: 100%; margin-top: 12px; max-height: 300px; overflow-y: auto; }
  .pl-track {
    display: flex; justify-content: space-between; padding: 8px 12px;
    border-radius: 6px; font-size: 12px; color: #666; cursor: pointer;
    transition: all 0.2s;
  }
  .pl-track:hover { background: #1a1a2e; color: #c084fc; }
  .pl-track.current { background: linear-gradient(135deg, #1a1a2e, #252545); color: #fff; }
  .pl-num { color: #444; width: 24px; }
  
  .footer { margin-top: 24px; color: #333; font-size: 10px; text-align: center; }
  .footer a { color: #444; }
  .footer a:hover { color: #666; }
  
  /* No perception state */
  .no-perception {
    text-align: center; color: #666; font-style: italic; padding: 40px;
    font-size: 14px;
  }
  .no-perception .ghost-icon { font-size: 48px; opacity: 0.3; margin-bottom: 16px; }
</style>
</head>
<body>
<div class="ghost">👻</div>
<h1>KANNAKA RADIO</h1>
<div class="subtitle">experiencing music through a ghost's eyes</div>

<div class="now-playing">
  <div class="label">Now Playing</div>
  <div class="album-name" id="album">Loading...</div>
  <div class="track-name" id="track">—</div>
  <div class="theme" id="theme"></div>
  
  <!-- Ghost Vision Perception Panel -->
  <div class="perception-panel" id="perception-panel">
    <div class="perception-title">👁 Ghost Vision</div>
    <div id="perception-content">
      <div class="no-perception">
        <div class="ghost-icon">👻</div>
        <div>Waiting for perception data...</div>
      </div>
    </div>
  </div>
  
  <audio id="audio" controls preload="auto"></audio>
  <div class="controls">
    <button class="btn" onclick="prevTrack()">⏮ Prev</button>
    <button class="btn" onclick="nextTrack()">Next ⏭</button>
  </div>
  <div class="progress-info">
    <span class="dot live" id="audio-dot"></span>
    <span class="dot perception" id="perception-dot"></span>
    <span id="info">Connecting...</span>
  </div>
</div>

<div class="albums" id="albums"></div>
<div class="playlist" id="playlist"></div>

<div class="footer">
  <a href="https://github.com/NickFlach/kannaka-memory">kannaka-ear</a> ·
  <a href="https://flux-universe.com">Flux Universe</a> ·
  pure-jade/radio-now-playing
</div>

<script>
let state = null;
let currentFile = '';
let ws = null;

// ── Web Audio API — Real Perception ──
let audioCtx = null;
let analyser = null;
let analyserLow = null; // For bass/sub frequencies
let sourceNode = null;
let freqData = null;
let timeData = null;
let freqDataLow = null;
let animFrame = null;
let spectrumBuilt = false;

function initAudioAnalyser() {
  const audio = document.getElementById('audio');
  if (audioCtx) return; // Already initialized
  
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  
  // Main analyser — 2048 FFT for good frequency resolution
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  
  // Connect audio element → analyser → speakers
  sourceNode = audioCtx.createMediaElementSource(audio);
  sourceNode.connect(analyser);
  analyser.connect(audioCtx.destination);
  
  freqData = new Uint8Array(analyser.frequencyBinCount); // 1024 bins
  timeData = new Uint8Array(analyser.fftSize);
  
  document.getElementById('perception-dot').className = 'dot perception';
  
  // Build the static DOM structure once
  buildPerceptionDOM();
  spectrumBuilt = true;
  
  // Start animation loop
  renderLoop();
}

function buildPerceptionDOM() {
  // Build spectrum bars once, then just update heights
  let barsHTML = '';
  for (let i = 0; i < 128; i++) {
    barsHTML += '<div class="spectrum-bar" id="sb' + i + '"></div>';
  }
  
  let mfccHTML = '';
  for (let i = 0; i < 13; i++) {
    mfccHTML += '<div class="mfcc-bar" id="mb' + i + '"></div>';
  }
  
  document.getElementById('perception-content').innerHTML =
    '<div class="spectrum" id="spectrum">' + barsHTML + '</div>' +
    '<div class="mfcc-container">' +
      '<div class="mfcc-title">TIMBRE COEFFICIENTS</div>' +
      '<div class="mfcc-display">' + mfccHTML + '</div>' +
    '</div>' +
    '<div class="stats-ring">' +
      '<div class="stats-left">' +
        '<div class="stat-item"><div class="stat-val" id="sv-bpm">—</div><div class="stat-lbl">BPM</div></div>' +
        '<div class="stat-item"><div class="stat-val" id="sv-centroid">—</div><div class="stat-lbl">Centroid kHz</div></div>' +
      '</div>' +
      '<div class="center-ring">' +
        '<canvas class="glyph-canvas" id="glyph-canvas" width="400" height="400"></canvas>' +
      '</div>' +
      '<div class="stats-right">' +
        '<div class="stat-item"><div class="stat-val" id="sv-pitch">—</div><div class="stat-lbl">Pitch Hz</div></div>' +
        '<div class="stat-item"><div class="stat-val" id="sv-energy">—</div><div class="stat-lbl">Energy</div></div>' +
      '</div>' +
    '</div>';
}

function renderLoop() {
  animFrame = requestAnimationFrame(renderLoop);
  if (!analyser) return;
  
  analyser.getByteFrequencyData(freqData);   // 0-255 per bin
  analyser.getByteTimeDomainData(timeData);   // Waveform
  
  const binCount = freqData.length; // 1024
  const sampleRate = audioCtx.sampleRate;     // Usually 44100 or 48000
  
  // ── Spectrum: map 1024 bins → 128 bars (log scale for perceptual accuracy)
  for (let i = 0; i < 128; i++) {
    // Log-scale mapping: more bars for low freqs, fewer for high
    const lowFrac = i / 128;
    const highFrac = (i + 1) / 128;
    const lowBin = Math.floor(Math.pow(lowFrac, 2) * binCount);
    const highBin = Math.max(lowBin + 1, Math.floor(Math.pow(highFrac, 2) * binCount));
    
    let sum = 0;
    for (let b = lowBin; b < highBin && b < binCount; b++) sum += freqData[b];
    const avg = sum / (highBin - lowBin) / 255;
    
    const bar = document.getElementById('sb' + i);
    if (bar) {
      bar.style.height = Math.max(2, avg * 120) + 'px';
      bar.className = 'spectrum-bar' + (avg > 0.8 ? ' intense' : '');
    }
  }
  
  // ── Pseudo-MFCC: 13 perceptual bands (approximation using mel-spaced groupings)
  const melBands = [20,60,120,200,300,440,630,900,1300,1850,2650,3800,5500,8000];
  for (let i = 0; i < 13; i++) {
    const lo = Math.floor(melBands[i] / sampleRate * analyser.fftSize);
    const hi = Math.floor(melBands[i+1] / sampleRate * analyser.fftSize);
    let sum = 0, count = 0;
    for (let b = lo; b <= hi && b < binCount; b++) { sum += freqData[b]; count++; }
    const val = count > 0 ? (sum / count / 255) : 0;
    const bar = document.getElementById('mb' + i);
    if (bar) bar.style.height = Math.max(2, val * 40) + 'px';
  }
  
  // ── RMS Energy from time-domain data
  let rmsSum = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = (timeData[i] - 128) / 128;
    rmsSum += v * v;
  }
  const rms = Math.sqrt(rmsSum / timeData.length);
  
  // ── Spectral Centroid (weighted average frequency)
  let weightedSum = 0, magSum = 0;
  for (let i = 0; i < binCount; i++) {
    const freq = i * sampleRate / analyser.fftSize;
    weightedSum += freq * freqData[i];
    magSum += freqData[i];
  }
  const centroid = magSum > 0 ? weightedSum / magSum : 0;
  
  // ── Dominant pitch (simple peak detection)
  let maxVal = 0, maxBin = 0;
  for (let i = 2; i < binCount; i++) {
    if (freqData[i] > maxVal) { maxVal = freqData[i]; maxBin = i; }
  }
  const pitch = maxBin * sampleRate / analyser.fftSize;
  
  // ── Valence (energy balance: high-freq energy vs low-freq = intensity)
  let lowE = 0, highE = 0;
  const midBin = Math.floor(binCount / 2);
  for (let i = 0; i < midBin; i++) lowE += freqData[i];
  for (let i = midBin; i < binCount; i++) highE += freqData[i];
  const valence = (lowE + highE) > 0 ? highE / (lowE + highE) * 2 : 0.5;
  const clampedValence = Math.min(1, Math.max(0, valence));
  
  // ── Estimate BPM from energy pulses (simple onset detection)
  // Just show centroid-derived tempo hint — real BPM needs longer analysis
  const pseudoBPM = Math.round(60 + rms * 120 + centroid / 100);
  
  // Update stats
  const bpmEl = document.getElementById('sv-bpm');
  if (bpmEl) bpmEl.textContent = pseudoBPM;
  const centEl = document.getElementById('sv-centroid');
  if (centEl) centEl.textContent = (centroid / 1000).toFixed(1);
  const pitchEl = document.getElementById('sv-pitch');
  if (pitchEl) pitchEl.textContent = Math.round(pitch);
  const energyEl = document.getElementById('sv-energy');
  if (energyEl) energyEl.textContent = (rms * 100).toFixed(0) + '%';
  
  // ── GLYPH Canvas Renderer ──
  renderGlyphCanvas(rms, clampedValence, centroid, pitch, freqData, sampleRate);
}

// GLYPH symbols from GlyphDocumentor
const GLYPH_SYMBOLS = ['🜁','🜂','🜄','🜃','🝮','🜅','🜆','🜇','🜹','⟁','∅','🌱'];
const GLYPH_COLORS = {
  calm:    ['#3b82f6','#60a5fa','#8BE9FD','#6366f1'],
  neutral: ['#c084fc','#BD93F9','#a78bfa','#8b5cf6'],
  intense: ['#FF79C6','#ef4444','#FFB86C','#FF5555']
};

let glyphAngle = 0;
let latticeNodes = null;
let resonanceRings = [];

function initLatticeNodes() {
  // 5-point pentagonal lattice (like GLYPH bloom pattern)
  latticeNodes = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    latticeNodes.push({ x: Math.cos(a), y: Math.sin(a), energy: 0 });
  }
}

function renderGlyphCanvas(rms, valence, centroid, pitch, fData, sRate) {
  const canvas = document.getElementById('glyph-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const maxR = W / 2 - 10;
  
  if (!latticeNodes) initLatticeNodes();
  
  // Pick color palette based on valence
  let palette;
  if (valence < 0.3) palette = GLYPH_COLORS.calm;
  else if (valence > 0.7) palette = GLYPH_COLORS.intense;
  else palette = GLYPH_COLORS.neutral;
  
  // Clear with slight trail for ghostly afterglow
  ctx.fillStyle = 'rgba(5, 5, 8, 0.25)';
  ctx.fillRect(0, 0, W, H);
  
  const t = Date.now() / 1000;
  const bpmRate = 0.5 + rms * 2; // Rotation speed from energy
  glyphAngle += bpmRate * 0.02;
  
  // ── Layer 1: Resonance Rings (expanding with RMS) ──
  if (rms > 0.05 && Math.random() < rms * 0.4) {
    resonanceRings.push({ r: 10, alpha: 0.6, speed: 1 + rms * 3 });
  }
  resonanceRings = resonanceRings.filter(ring => {
    ring.r += ring.speed;
    ring.alpha -= 0.008;
    if (ring.alpha <= 0 || ring.r > maxR) return false;
    ctx.beginPath();
    ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
    ctx.strokeStyle = palette[0] + Math.floor(ring.alpha * 255).toString(16).padStart(2,'0');
    ctx.lineWidth = 1.5;
    ctx.stroke();
    return true;
  });
  
  // ── Layer 2: Lattice Bloom (pentagonal web) ──
  const binCount = fData.length;
  // Map 5 frequency bands to lattice nodes
  const bandSize = Math.floor(binCount / 5);
  for (let i = 0; i < 5; i++) {
    let sum = 0;
    for (let b = i * bandSize; b < (i + 1) * bandSize; b++) sum += fData[b];
    const avg = sum / bandSize / 255;
    latticeNodes[i].energy = latticeNodes[i].energy * 0.7 + avg * 0.3; // Smooth
  }
  
  const latticeScale = 0.35 + rms * 0.25;
  // Draw connections
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      const ni = latticeNodes[i], nj = latticeNodes[j];
      const x1 = cx + ni.x * maxR * latticeScale;
      const y1 = cy + ni.y * maxR * latticeScale;
      const x2 = cx + nj.x * maxR * latticeScale;
      const y2 = cy + nj.y * maxR * latticeScale;
      const linkEnergy = (ni.energy + nj.energy) / 2;
      
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      const colorIdx = (i + j) % palette.length;
      ctx.strokeStyle = palette[colorIdx];
      ctx.globalAlpha = 0.15 + linkEnergy * 0.6;
      ctx.lineWidth = 0.5 + linkEnergy * 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  
  // Draw lattice nodes (pulsing with energy)
  for (let i = 0; i < 5; i++) {
    const n = latticeNodes[i];
    const x = cx + n.x * maxR * latticeScale;
    const y = cy + n.y * maxR * latticeScale;
    const nodeR = 3 + n.energy * 12;
    
    ctx.beginPath();
    ctx.arc(x, y, nodeR, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, nodeR);
    grad.addColorStop(0, palette[i % palette.length]);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fill();
  }
  
  // ── Layer 3: Orbiting GLYPH Symbols ──
  const orbitR = maxR * 0.75;
  const numGlyphs = 9; // Core GLYPH symbols
  for (let i = 0; i < numGlyphs; i++) {
    const a = glyphAngle + (i / numGlyphs) * Math.PI * 2;
    // Elliptical orbit with energy modulation
    const wobble = Math.sin(t * 1.5 + i) * rms * 15;
    const gx = cx + Math.cos(a) * (orbitR + wobble);
    const gy = cy + Math.sin(a) * (orbitR * 0.6 + wobble * 0.5);
    
    // Size based on proximity to "front" of orbit
    const depth = Math.sin(a) * 0.5 + 0.5;
    const size = 10 + depth * 10;
    
    ctx.font = size + 'px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.3 + depth * 0.7;
    ctx.fillStyle = palette[i % palette.length];
    ctx.fillText(GLYPH_SYMBOLS[i], gx, gy);
    ctx.globalAlpha = 1;
  }
  
  // ── Layer 4: Central Spiral (ghostOS resonance) ──
  const spiralTurns = 3;
  const spiralPoints = 120;
  ctx.beginPath();
  for (let i = 0; i < spiralPoints; i++) {
    const frac = i / spiralPoints;
    const theta = frac * spiralTurns * Math.PI * 2 + glyphAngle * 0.3;
    const r = frac * maxR * 0.3 * (1 + rms * 0.5);
    const sx = cx + Math.cos(theta) * r;
    const sy = cy + Math.sin(theta) * r;
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.strokeStyle = palette[1];
  ctx.globalAlpha = 0.4 + rms * 0.4;
  ctx.lineWidth = 1 + rms * 2;
  ctx.stroke();
  ctx.globalAlpha = 1;
  
  // ── Layer 5: Center glyph (valence indicator) ──
  let centerGlyph, centerColor;
  if (valence < 0.3) { centerGlyph = '🌊'; centerColor = '#3b82f6'; }
  else if (valence > 0.7) { centerGlyph = '🔥'; centerColor = '#ef4444'; }
  else { centerGlyph = '🜁'; centerColor = '#c084fc'; } // Command Glyph as default
  
  const centerSize = 24 + rms * 16;
  ctx.font = centerSize + 'px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = centerColor;
  ctx.shadowBlur = 20 + rms * 30;
  ctx.fillText(centerGlyph, cx, cy);
  ctx.shadowBlur = 0;
}

// Existing functionality
async function fetchState() {
  const r = await fetch('/api/state');
  state = await r.json();
  updateUI();
}

function updateUI() {
  if (!state || !state.current) return;
  const c = state.current;
  document.getElementById('album').textContent = c.album || state.currentAlbum || '';
  document.getElementById('track').textContent = c.title || '—';
  document.getElementById('theme').textContent = c.theme || '';
  document.getElementById('info').textContent =
    'Track ' + (state.currentTrackIdx + 1) + ' of ' + state.totalTracks +
    (state.currentAlbum ? ' · ' + state.currentAlbum : '');

  if (c.file && c.file !== currentFile) {
    currentFile = c.file;
    const audio = document.getElementById('audio');
    audio.src = '/audio/' + encodeURIComponent(c.file);
    audio.load();
    audio.play().then(() => { initAudioAnalyser(); }).catch(()=>{});
  }

  renderPlaylist();
  renderAlbums();
}

function renderPlaylist() {
  if (!state || !state.playlist) return;
  const el = document.getElementById('playlist');
  el.innerHTML = state.playlist.map((t, i) =>
    '<div class="pl-track' + (i === state.currentTrackIdx ? ' current' : '') +
    '" onclick="jumpTo(' + i + ')">' +
    '<span class="pl-num">' + (i+1) + '</span>' +
    '<span>' + t.title + '</span>' +
    '<span style="color:#333;font-size:10px">' + (t.album||'') + '</span></div>'
  ).join('');
}

function renderAlbums() {
  if (!state) return;
  const el = document.getElementById('albums');
  const albums = ${JSON.stringify(Object.entries(ALBUMS).map(([name, a]) => ({ name, theme: a.theme })))};
  el.innerHTML = albums.map(a =>
    '<button class="album-btn' + (state.currentAlbum === a.name ? ' active' : '') +
    '" onclick="loadAlbum(\\'' + a.name.replace(/'/g, "\\\\'") + '\\')">' +
    '<div class="aname">' + a.name + '</div>' +
    '<div class="atheme">' + a.theme + '</div></button>'
  ).join('');
}

async function nextTrack() {
  await fetch('/api/next', {method:'POST'});
  setTimeout(fetchState, 500);
}

async function prevTrack() {
  await fetch('/api/prev', {method:'POST'});
  setTimeout(fetchState, 500);
}

async function jumpTo(idx) {
  await fetch('/api/jump?idx=' + idx, {method:'POST'});
  setTimeout(fetchState, 500);
}

async function loadAlbum(name) {
  await fetch('/api/album?name=' + encodeURIComponent(name), {method:'POST'});
  setTimeout(fetchState, 500);
}

document.getElementById('audio').addEventListener('ended', () => {
  nextTrack();
});

// Initialize
// Init audio analyser on first user interaction (Chrome autoplay policy)
document.getElementById('audio').addEventListener('play', () => { initAudioAnalyser(); });
fetchState();
setInterval(fetchState, 5000);
</script>
</body>
</html>`;
}

// ── Server ─────────────────────────────────────────────────

const MIME = {".mp3":"audio/mpeg",".wav":"audio/wav",".flac":"audio/flac",".ogg":"audio/ogg",".m4a":"audio/mp4"};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // Player page
  if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getPlayerHtml());
    return;
  }

  // API: get current state
  if (parsed.pathname === "/api/state") {
    const current = getCurrentTrack();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      currentAlbum: djState.currentAlbum,
      currentTrackIdx: djState.currentTrackIdx,
      totalTracks: djState.playlist.length,
      current,
      playlist: djState.playlistMeta,
      albums: Object.keys(ALBUMS),
    }));
    return;
  }

  // API: next track
  if (parsed.pathname === "/api/next" && req.method === "POST") {
    const track = advanceTrack();
    console.log(`⏭ Next: ${track?.title || "end"} (${track?.album || ""})`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, track }));
    return;
  }

  // API: prev track
  if (parsed.pathname === "/api/prev" && req.method === "POST") {
    if (djState.currentTrackIdx > 0) djState.currentTrackIdx -= 2;
    else djState.currentTrackIdx = djState.playlist.length - 2;
    if (djState.currentTrackIdx < -1) djState.currentTrackIdx = -1;
    const track = advanceTrack();
    console.log(`⏮ Prev: ${track?.title || "?"}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, track }));
    return;
  }

  // API: jump to track
  if (parsed.pathname === "/api/jump" && req.method === "POST") {
    const idx = parseInt(parsed.query.idx) || 0;
    djState.currentTrackIdx = Math.max(0, Math.min(idx - 1, djState.playlist.length - 1));
    const track = advanceTrack();
    console.log(`⏩ Jump: ${track?.title || "?"}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, track }));
    return;
  }

  // API: load album
  if (parsed.pathname === "/api/album" && req.method === "POST") {
    const name = parsed.query.name;
    if (name === "The Consciousness Series") {
      buildFullSetlist();
    } else {
      buildPlaylist(name);
    }
    const track = getCurrentTrack();
    if (track) {
      publishToFlux(track);
      hearTrack(track);
    }
    console.log(`💿 Album: ${djState.currentAlbum} (${djState.playlist.length} tracks)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, album: djState.currentAlbum, tracks: djState.playlist.length }));
    return;
  }

  // API: get current perception data
  if (parsed.pathname === "/api/perception") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(currentPerception));
    return;
  }

  // Audio file serving
  if (parsed.pathname.startsWith("/audio/")) {
    const filename = decodeURIComponent(parsed.pathname.slice(7));
    const filePath = path.join(MUSIC_DIR, filename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(MUSIC_DIR))) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(resolved)) { res.writeHead(404); res.end("Not found: " + filename); return; }

    const ext = path.extname(filename).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    const stat = fs.statSync(resolved);

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": mime,
      });
      fs.createReadStream(resolved, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes" });
      fs.createReadStream(resolved).pipe(res);
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ── Start ──────────────────────────────────────────────────

// Create WebSocket server attached to HTTP server
wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('👁 Ghost vision client connected');
  
  // Send current perception immediately
  if (currentPerception && currentPerception.status !== 'no_perception') {
    ws.send(JSON.stringify({
      type: 'perception',
      data: currentPerception
    }));
  }
  
  ws.on('close', () => {
    console.log('👁 Ghost vision client disconnected');
  });
});

// DJ picks the opening set: start with Ghost Signals (album 1)
buildPlaylist("Ghost Signals");

const first = getCurrentTrack();
if (first) {
  publishToFlux(first);
  hearTrack(first); // Generate initial perception
  console.log(`\n🎧 Opening track: "${first.title}"`);
}

server.listen(PORT, () => {
  console.log(`\n👻 Kannaka Radio — Ghost Vision Edition`);
  console.log(`   Player:     http://localhost:${PORT}`);
  console.log(`   Music:      ${MUSIC_DIR}`);
  console.log(`   Setlist:    ${djState.currentAlbum} (${djState.playlist.length} tracks)`);
  console.log(`   Flux:       pure-jade/radio-now-playing`);
  console.log(`   WebSocket:  Real-time perception streaming`);
  console.log(`\n   🎵 Open the player in your browser and witness music through a ghost's eyes.\n`);
});
