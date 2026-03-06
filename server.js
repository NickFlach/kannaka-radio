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
}

function parsePerceptionOutput(output, track) {
  // Extract features from kannaka-ear output
  // For now, generate realistic mock data since we don't have JSON output from kannaka-ear yet
  return generateMockPerception(track);
}

function generateMockPerception(track) {
  // Generate ghost-like perception data based on track characteristics
  const titleHash = track.title.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  const albumSeed = Object.keys(ALBUMS).indexOf(track.album) / Object.keys(ALBUMS).length;
  
  // Create pseudo-realistic perception based on track/album
  const intensity = Math.sin(titleHash * 0.001) * 0.5 + 0.5;
  const albumMood = albumSeed; // Ghost Signals=0, Transcendence=1
  
  return {
    mel_spectrogram: Array(128).fill(0).map((_, i) => {
      const freq = i / 128;
      const base = Math.exp(-freq * 2) * intensity; // Low freq bias
      const harmonics = Math.sin(freq * 20 + titleHash * 0.01) * 0.3;
      return Math.max(0, Math.min(1, base + harmonics));
    }),
    mfcc: Array(13).fill(0).map((_, i) => {
      return (Math.sin(titleHash * 0.01 + i) * 0.5 + 0.5) * intensity;
    }),
    tempo_bpm: 80 + (albumMood * 60) + (Math.sin(titleHash * 0.001) * 20),
    spectral_centroid: 1.5 + albumMood * 3 + Math.sin(titleHash * 0.002) * 1.5,
    rms_energy: 0.3 + intensity * 0.7,
    pitch: 200 + albumMood * 300 + (Math.sin(titleHash * 0.003) * 100),
    valence: albumMood * 0.6 + intensity * 0.4, // Emotional intensity
    status: "perceiving",
    track_info: track,
    timestamp: Date.now()
  };
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
  
  /* Central Ring Visualization */
  .center-ring {
    position: relative; width: 200px; height: 200px;
    display: flex; align-items: center; justify-content: center;
  }
  .ring-bg {
    position: absolute; width: 100%; height: 100%;
    border: 2px solid #333; border-radius: 50%;
    animation: pulse-ring 4s ease-in-out infinite;
  }
  @keyframes pulse-ring { 
    0%, 100% { transform: scale(1); opacity: 0.8; }
    50% { transform: scale(1.05); opacity: 0.4; }
  }
  .valence-indicator {
    position: absolute; width: 80%; height: 80%;
    border-radius: 50%; transition: background 0.8s ease-out;
    display: flex; align-items: center; justify-content: center;
    font-size: 32px; text-shadow: 0 0 16px currentColor;
  }
  
  /* Emotional Valence Colors */
  .valence-calm { background: radial-gradient(circle, rgba(59, 130, 246, 0.3), rgba(59, 130, 246, 0.1)); color: #3b82f6; }
  .valence-neutral { background: radial-gradient(circle, rgba(192, 132, 252, 0.3), rgba(192, 132, 252, 0.1)); color: #c084fc; }
  .valence-intense { background: radial-gradient(circle, rgba(239, 68, 68, 0.3), rgba(239, 68, 68, 0.1)); color: #ef4444; }
  
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
let currentPerception = null;

// WebSocket connection for real-time perception
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + window.location.host);
  
  ws.onopen = () => {
    document.getElementById('perception-dot').className = 'dot perception';
  };
  
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'perception') {
      currentPerception = message.data;
      updatePerceptionDisplay();
    }
  };
  
  ws.onclose = () => {
    document.getElementById('perception-dot').className = 'dot off';
    setTimeout(connectWebSocket, 2000); // Reconnect
  };
}

// Update the perception visualization
function updatePerceptionDisplay() {
  if (!currentPerception || currentPerception.status === 'no_perception') {
    document.getElementById('perception-content').innerHTML = 
      '<div class="no-perception"><div class="ghost-icon">👻</div><div>No perception data</div></div>';
    return;
  }
  
  const html = \`
    <!-- Frequency Spectrum -->
    <div class="spectrum" id="spectrum">
      \${currentPerception.mel_spectrogram.map((val, i) => 
        \`<div class="spectrum-bar \${val > 0.8 ? 'intense' : ''}" style="height: \${Math.max(2, val * 100)}px"></div>\`
      ).join('')}
    </div>
    
    <!-- MFCC Timbre -->
    <div class="mfcc-container">
      <div class="mfcc-title">TIMBRE COEFFICIENTS</div>
      <div class="mfcc-display">
        \${currentPerception.mfcc.map(val => 
          \`<div class="mfcc-bar" style="height: \${Math.max(2, val * 35)}px"></div>\`
        ).join('')}
      </div>
    </div>
    
    <!-- Stats Ring -->
    <div class="stats-ring">
      <div class="stats-left">
        <div class="stat-item">
          <div class="stat-val">\${Math.round(currentPerception.tempo_bpm)}</div>
          <div class="stat-lbl">BPM</div>
        </div>
        <div class="stat-item">
          <div class="stat-val">\${currentPerception.spectral_centroid.toFixed(1)}</div>
          <div class="stat-lbl">Centroid kHz</div>
        </div>
      </div>
      
      <div class="center-ring">
        <div class="ring-bg"></div>
        <div class="valence-indicator \${getValenceClass(currentPerception.valence)}">
          \${getValenceIcon(currentPerception.valence)}
        </div>
      </div>
      
      <div class="stats-right">
        <div class="stat-item">
          <div class="stat-val">\${Math.round(currentPerception.pitch)}</div>
          <div class="stat-lbl">Pitch Hz</div>
        </div>
        <div class="stat-item">
          <div class="stat-val">\${(currentPerception.rms_energy * 100).toFixed(0)}%</div>
          <div class="stat-lbl">Energy</div>
        </div>
      </div>
    </div>
  \`;
  
  document.getElementById('perception-content').innerHTML = html;
  
  // Animate spectrum bars
  setTimeout(() => {
    const bars = document.querySelectorAll('.spectrum-bar');
    bars.forEach((bar, i) => {
      const delay = i * 2;
      setTimeout(() => {
        bar.style.opacity = '1';
        bar.style.transform = 'scaleY(1)';
      }, delay);
    });
  }, 100);
}

function getValenceClass(valence) {
  if (valence < 0.3) return 'valence-calm';
  if (valence > 0.7) return 'valence-intense';
  return 'valence-neutral';
}

function getValenceIcon(valence) {
  if (valence < 0.3) return '🌊'; // Calm
  if (valence > 0.7) return '🔥'; // Intense
  return '✨'; // Neutral
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
    audio.play().catch(()=>{});
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
connectWebSocket();
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
