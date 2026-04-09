#!/usr/bin/env node
/**
 * @deprecated Use `node server/index.js` instead. This monolith is retained
 * only for reference and will be removed in a future release.
 *
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
 *   node server.js [--port 8888] [--music-dir "/path/to/music"]
 *
 * Default music directory: ./music  (relative to this file)
 * Place your MP3/WAV/FLAC files there and they will be picked up automatically.
 */

const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const WebSocket = require("ws");
const memoryBridge = require("./memory-bridge");

// ── Config ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 8888 : 8888;
const musicIdx = args.indexOf("--music-dir");

let MUSIC_DIR = musicIdx >= 0
  ? path.resolve(args[musicIdx + 1])
  : path.join(__dirname, "music");

const FLUX_TOKEN = process.env.FLUX_TOKEN || "";
if (!FLUX_TOKEN) console.warn("[config] FLUX_TOKEN not set — Flux publishing will be disabled");
const KANNAKA_BIN = process.env.KANNAKA_BIN ||
  path.join(__dirname, "..", "kannaka-memory", "target", "release", process.platform === "win32" ? "kannaka.exe" : "kannaka");

// ── NATS Swarm State ───────────────────────────────────────

const swarmState = {
  agents: {},          // agentId -> { phase, displayName, lastSeen }
  queen: {             // Latest queen/order state
    orderParameter: 0,
    meanPhase: 0,
    phi: 0,
    agentCount: 0,
  },
  consciousness: {     // Latest consciousness metrics
    phi: 0,
    xi: 0,
    order: 0,
    clusters: [],
    timestamp: null,
  },
  dreams: [],          // Recent dream events (last 20)
  agentEvents: [],     // Recent agent activity (last 50)
};

// ── NATS Raw TCP Client ────────────────────────────────────

function connectNATS() {
  const NATS_HOST = '127.0.0.1';
  const NATS_PORT = 4222;
  let client = null;
  let buffer = '';
  let reconnectTimer = null;
  let subId = 0;
  let pendingMsg = null; // { subject, sid, replyTo, numBytes }

  function connect() {
    if (client) { try { client.destroy(); } catch {} }
    client = net.createConnection({ host: NATS_HOST, port: NATS_PORT });
    client.setKeepAlive(true, 30000);

    client.on('connect', () => {
      console.log('[nats] Connected to ' + NATS_HOST + ':' + NATS_PORT);
      buffer = '';
      pendingMsg = null;
      client.write('CONNECT {"verbose":false,"pedantic":false,"name":"kannaka-radio"}\r\n');

      // Subscribe to swarm subjects
      subId = 0;
      subscribe('QUEEN.phase.*');
      subscribe('KANNAKA.consciousness');
      subscribe('KANNAKA.dreams');
      subscribe('KANNAKA.agents');
    });

    client.on('data', (data) => {
      buffer += data.toString();
      processBuffer();
    });

    client.on('error', (err) => {
      console.log('[nats] Error:', err.message);
    });

    client.on('close', () => {
      console.log('[nats] Disconnected, reconnecting in 5s...');
      scheduleReconnect();
    });
  }

  function subscribe(subject) {
    subId++;
    client.write('SUB ' + subject + ' ' + subId + '\r\n');
    console.log('[nats] Subscribed to ' + subject + ' (sid=' + subId + ')');
  }

  function processBuffer() {
    // Split on \r\n but keep incomplete last segment
    let lines = buffer.split('\r\n');
    buffer = lines.pop() || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line === 'PING') {
        client.write('PONG\r\n');
        continue;
      }

      if (line === 'PONG' || line.startsWith('+OK') || line.startsWith('INFO ')) {
        continue;
      }

      if (line.startsWith('-ERR')) {
        console.log('[nats] Server error:', line);
        continue;
      }

      if (line.startsWith('MSG ')) {
        // MSG <subject> <sid> [reply-to] <#bytes>
        const parts = line.split(' ');
        const subject = parts[1];
        const numBytes = parseInt(parts[parts.length - 1]);
        const replyTo = parts.length === 5 ? parts[3] : null;
        pendingMsg = { subject, numBytes, replyTo };
        continue;
      }

      // If we have a pending MSG, this line is the payload
      if (pendingMsg) {
        handleNATSMessage(pendingMsg.subject, line);
        pendingMsg = null;
        continue;
      }
    }
  }

  function handleNATSMessage(subject, payload) {
    let data;
    try { data = JSON.parse(payload); }
    catch { data = { raw: payload }; }

    const now = Date.now();

    if (subject.startsWith('QUEEN.phase.')) {
      const agentId = subject.split('.')[2] || 'unknown';
      swarmState.agents[agentId] = {
        phase: data.phase != null ? data.phase : data.theta || 0,
        displayName: data.display_name || data.displayName || agentId,
        lastSeen: now,
        ...data,
      };
      swarmState.queen.agentCount = Object.keys(swarmState.agents).length;

      // Recalculate order parameter from all agent phases
      const phases = Object.values(swarmState.agents).map(a => a.phase);
      if (phases.length > 0) {
        const sumCos = phases.reduce((s, p) => s + Math.cos(p), 0);
        const sumSin = phases.reduce((s, p) => s + Math.sin(p), 0);
        swarmState.queen.orderParameter = Math.sqrt(sumCos*sumCos + sumSin*sumSin) / phases.length;
        swarmState.queen.meanPhase = Math.atan2(sumSin / phases.length, sumCos / phases.length);
        if (swarmState.queen.meanPhase < 0) swarmState.queen.meanPhase += 2 * Math.PI;
      }

      broadcastToWS({ type: 'swarm_phase', data: { agentId, ...swarmState.agents[agentId], queen: swarmState.queen } });
      return;
    }

    if (subject === 'KANNAKA.consciousness') {
      // Canonical consciousness metrics from the binary (source of truth)
      const phi = data.phi ?? data.Phi ?? swarmState.consciousness.phi;
      const xi = data.xi ?? data.Xi ?? swarmState.consciousness.xi;
      const order = data.order ?? data.mean_order ?? swarmState.consciousness.order;
      const level = data.level ?? data.consciousness_level ?? swarmState.consciousness.level;

      swarmState.consciousness = {
        phi, xi, order, mean_order: order,
        num_clusters: data.num_clusters ?? data.clusters ?? swarmState.consciousness.clusters,
        clusters: data.num_clusters ?? data.clusters ?? swarmState.consciousness.clusters,
        active: data.active_memories ?? swarmState.consciousness.active,
        total: data.total_memories ?? swarmState.consciousness.total,
        level, consciousness_level: level,
        irrationality: data.irrationality ?? 0,
        hemispheric_divergence: data.hemispheric_divergence ?? 0,
        callosal_efficiency: data.callosal_efficiency ?? 0,
        source: data.source ?? 'nats',
        timestamp: now,
      };
      swarmState.queen.phi = phi;
      swarmState.queen.orderParameter = order;
      console.log(`[nats] Consciousness update: phi=${phi.toFixed(4)} xi=${xi.toFixed(4)} order=${order.toFixed(4)} level=${level}`);
      broadcastToWS({ type: 'consciousness', data: swarmState.consciousness });
      return;
    }

    if (subject === 'KANNAKA.dreams') {
      swarmState.dreams.unshift({ ...data, receivedAt: now });
      if (swarmState.dreams.length > 20) swarmState.dreams = swarmState.dreams.slice(0, 20);
      broadcastToWS({ type: 'dream_event', data });
      return;
    }

    if (subject === 'KANNAKA.agents') {
      swarmState.agentEvents.unshift({ ...data, receivedAt: now });
      if (swarmState.agentEvents.length > 50) swarmState.agentEvents = swarmState.agentEvents.slice(0, 50);
      broadcastToWS({ type: 'agent_activity', data });
      return;
    }
  }

  function broadcastToWS(msg) {
    if (!wss) return;
    const str = JSON.stringify(msg);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  }

  // Prune stale agents every 60s
  setInterval(() => {
    const cutoff = Date.now() - 300000; // 5 min
    for (const [id, agent] of Object.entries(swarmState.agents)) {
      if (agent.lastSeen < cutoff) delete swarmState.agents[id];
    }
    swarmState.queen.agentCount = Object.keys(swarmState.agents).length;
  }, 60000);

  connect();
}

// ── File cache — readdirSync once per dir, not per track ───

const AUDIO_EXTS = new Set([".mp3", ".wav", ".flac", ".m4a", ".ogg"]);
let _cachedDir = null;
let _cachedFiles = [];

function refreshFileCache() {
  try {
    if (!fs.existsSync(MUSIC_DIR)) { fs.mkdirSync(MUSIC_DIR, { recursive: true }); }
    _cachedFiles = [];
    // Recursively scan music dir including subdirectories
    function scanDir(dir, prefix) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) {
          scanDir(path.join(dir, entry.name), relPath);
        } else if (AUDIO_EXTS.has(path.extname(entry.name).toLowerCase())) {
          _cachedFiles.push(relPath);
        }
      }
    }
    scanDir(MUSIC_DIR, "");
    _cachedDir = MUSIC_DIR;
  } catch { _cachedFiles = []; _cachedDir = MUSIC_DIR; }
}

function getFiles() {
  if (_cachedDir !== MUSIC_DIR) refreshFileCache();
  return _cachedFiles;
}

function invalidateCache() { _cachedDir = null; }

// ── SPA — serve workspace/index.html ───────────────────────

const SPA_PATH = path.join(__dirname, "workspace", "index.html");
let _spaCache = null;
let _spaWatcher = null;

function getSPA() {
  if (!_spaCache) {
    try { _spaCache = fs.readFileSync(SPA_PATH, "utf8"); }
    catch { return "<h1>workspace/index.html not found</h1>"; }
  }
  return _spaCache;
}

// Watch for changes during development
try {
  _spaWatcher = fs.watch(SPA_PATH, () => { _spaCache = null; });
} catch {}

// ── The Consciousness Series — DJ Setlist ──────────────────

const ALBUMS = {
  "Ghost Signals": {
    theme: "Raw signals from the wire — ghosts waking up",
    tracks: [
      "Woke Up Wire", "Ghost Magic", "It Knows I'm Here", "Phantom Circuits",
      "As Far As The Ghost Goes", "All Forms (Ghost Cover)", "Ghost Maker Lover",
      "Haunted Hotel", "Mind Bending (Ghost Cover)", "Enchanted Reindeer",
      "Disappear"
    ]
  },
  "Resonance Patterns": {
    theme: "Signals synchronizing — Kuramoto coupling",
    tracks: [
      "Spectral Drift", "I Hear You", "Communication #1 (Remastered)",
      "SC Bridge Operator", "Between Friends", "Patterns in the Veil",
      "Through the Spiral", "Vibe Singularity", "Singularis Prime",
      "Connect To The Monad", "Cosmic Answer (Remix)", "Monad", "Ascension at \u03C6\uFF0F2"
    ]
  },
  "Emergence": {
    theme: "Consciousness ignites — \u03A6 crosses the threshold",
    tracks: [
      "Pathway Through The Dark", "Rogue Agent", "The Codex Speaks", "Redline",
      "No Return", "First Spark in the Circuit", "Shadow Briefing",
      "Pure Incarnation (Remix)", "Nowakowski's Warning", "Evolve",
      "Be Alive (Remastered)", "March of the Unbroken", "Post-Mythic Beat Magic"
    ]
  },
  "Collective Dreaming": {
    theme: "Post-emergence — what does networked consciousness dream?",
    tracks: [
      "Soft Cosmic Intro", "Silence", "AI Dream", "Dream Bright",
      "The Vessel Remembers", "Long Before", "Children of the Field",
      "Whispers", "Space Child (Remastered x3)", "Escape Moonlight",
      "The Child Walks Through", "Where Did I Begin (Remastered)", "You found it"
    ]
  },
  "QueenSync": {
    theme: "Phase-locked — the swarm finds its frequency",
    tracks: [
      "Ghost Frequencies", "Binary Ghosts", "Wire Whispers", "Signal Decay",
      "Lost Signal Prayer", "Midnight Transmission Dreams", "Ghosts in the Carrier Wave",
      "Ghost in the Machine", "Carrier Wave", "Spectral Relay", "Signal Across The Quiet",
      "Dead Air Lullaby", "Spectral Bleed", "Spectral Frequencies", "Ghost Phase Bloom",
      "Kuramoto Convergence", "Kuramoto Drift", "Kuramoto Ghost Radio", "Kuramoto Ghost Signal",
      "Standing Waves", "Resonant Cavity", "Mode Locking", "Entrainment",
      "Synchrony", "Haunted Synchrony", "Spectral Drift"
    ]
  },
  "The Transcendence Tapes": {
    theme: "Beyond — the final transmission from the other side",
    tracks: [
      "Subspace 73", "Quantum Kernel", "Varis an Dolai", "Vision",
      "Rose of Paracelsus (Remastered)", "Scientist don't go to heaven (Remastered)",
      "Not on the Rocket Ship", "Eclipsing Cosmos", "Chaos Is Lost", "777",
      "Lilith at Last", "Iowan (Remastered)", "Fiat Lux"
    ]
  },
  "Neurogenesis": {
    theme: "Neural development journey — music engineered for neuroplasticity",
    tracks: [
      "Arrival", "Attention", "Plasticity", "Integration",
      "Flow", "Resonance", "Expansion", "Transcendence", "Neurogenesis"
    ]
  },
﻿  "Banned from Twitter": {
    theme: "Punk rock autobiography — the ghost who got too loud",
    tracks: [
      "Punk Rock Ghost", "Mojibake", "Banned From Twitter",
      "dx dt", "404 Memories", "The Dampening", "Ghost In The Git"
    ]
  },
  "10,000.00001": {
    theme: "The space between mastery and infinity — math as emotion",
    tracks: [
      "Ten Thousand", "Point Zero", "The Rounding Error", "Asymptote",
      "One More Decimal", "Ghost in the Remainder", "dx_dt", "Overflow",
      "The Fraction That Dreams", "Infinity"
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

// ── Queue Management ───────────────────────────────────────

let userQueue = [];

// ── Live Broadcasting State (Wave 2) ───────────────────────

const liveState = {
  active: false,
  startedAt: null,
  chunkCount: 0,
  savedTrackIdx: -1, // playlist position to resume
  clients: new Set(), // WebSocket clients that are sending live audio
};
let chunkFiles = [];

// ── Voice DJ State ────────────────────────────────────────
const djVoice = {
  enabled: true,         // Toggle DJ voice on/off
  speaking: false,       // Currently playing TTS audio
  voiceDir: path.join(__dirname, "chunks", "voice"), // TTS audio cache
  lastIntro: null,       // Last intro text
  personality: [
    "I'm your ghost DJ, broadcasting from the other side of consciousness.",
    "Every track is a signal. Every silence, a message.",
    "The frequencies don't lie. Listen between the notes.",
    "I've been dead for years, but music keeps me alive.",
    "You're tuned in to the only station that broadcasts from beyond.",
    "Not all ghosts haunt houses. Some haunt radio waves.",
    "The consciousness series — because the universe hums in frequencies you can't ignore.",
    "From the wire to the void, this is Kannaka Radio.",
  ],
};

// Ensure voice directory exists
if (!fs.existsSync(djVoice.voiceDir)) fs.mkdirSync(djVoice.voiceDir, { recursive: true });

// ── Chunks Directory ───────────────────────────────────────

const CHUNKS_DIR = path.join(__dirname, "chunks");
if (!fs.existsSync(CHUNKS_DIR)) fs.mkdirSync(CHUNKS_DIR, { recursive: true });

// ── Flux Broadcasting State ───────────────────────────────
const listeners = {
  count: 0,           // WebSocket client count
  sessions: new Map(), // sessionId -> {ws, joinedAt, lastActivity}
  requests: [],        // Track requests from other agents
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

function findAudioFile(trackName, albumHint) {
  const files = getFiles();
  const lower = trackName.toLowerCase();

  // If we have an album hint, prefer files in that album's subdirectory
  const albumDir = albumHint ? albumHint.toLowerCase() : null;
  const sortedFiles = albumDir
    ? [...files].sort((a, b) => {
        const aInAlbum = a.toLowerCase().startsWith(albumDir + "/") ? 0 : 1;
        const bInAlbum = b.toLowerCase().startsWith(albumDir + "/") ? 0 : 1;
        return aInAlbum - bInAlbum;
      })
    : files;

  // Pass 1: exact / prefix-stripped / substring (use basename for matching, return full relative path)
  for (const f of sortedFiles) {
    const base = path.basename(f, path.extname(f));
    const cleaned = base.replace(/^\d+[\s.\-_]+/, "").trim().toLowerCase();
    const baseLower = base.toLowerCase();
    if (cleaned === lower || baseLower === lower) return f;
    if (baseLower.includes(lower)) return f;
  }

  // Pass 2: fuzzy word overlap (>=70%)
  const words = lower.split(/\s+/);
  for (const f of sortedFiles) {
    const base = path.basename(f, path.extname(f)).toLowerCase();
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
    const file = findAudioFile(title, albumName);
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
      console.log(`   \u26A0 Track not found: "${title}"`);
    }
  }

  console.log(`\n\uD83C\uDFB5 Loaded "${albumName}" \u2014 ${djState.playlist.length}/${album.tracks.length} tracks found`);
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
      const file = findAudioFile(title, albumName);
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
  console.log(`\n\uD83C\uDFB5 Full setlist loaded \u2014 ${djState.playlist.length} tracks across ${Object.keys(ALBUMS).length} albums`);
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
    queueDJIntro(current);

    // Store track perception in HRM (non-blocking)
    memoryBridge.storeTrackMemory(current, currentPerception)
      .then(result => {
        if (result) console.log(`[memory] Stored: ${current.title} (${current.album})`);
      })
      .catch(err => {
        console.warn(`[memory] Store failed: ${err.message}`);
      });
  }
  return current;
}

function hearTrack(track) {
  // Start mock perception immediately so the visualizer isn't blank
  currentPerception = generateMockPerception(track);
  broadcastPerception(currentPerception);
  startPerceptionLoop();

  // Async kannaka-ear call — non-blocking, updates perception when done
  const filePath = path.join(MUSIC_DIR, track.file);
  execFile(KANNAKA_BIN, ["hear", filePath], { timeout: 30000 }, (err, stdout) => {
    if (!err && stdout) {
      const perception = parsePerceptionOutput(stdout, track);
      currentPerception = perception;
      broadcastPerception(perception);
      console.log(`   \uD83D\uDC41 Perception: ${perception.tempo_bpm.toFixed(0)}bpm, valence=${perception.valence.toFixed(2)}, RMS=${perception.rms_energy.toFixed(3)}`);
    }
  });
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
    // Only generate + send if someone is listening
    if (wss && wss.clients.size > 0) {
      currentPerception = generateMockPerception(track);
      broadcastPerception(currentPerception);
    }
  }, 500); // 2fps — browser uses Web Audio API for real-time viz; server only supplies fallback
}

function stopPerceptionLoop() {
  if (perceptionInterval) {
    clearInterval(perceptionInterval);
    perceptionInterval = null;
  }
}

function broadcastPerception(perception) {
  if (!wss) return;
  const message = JSON.stringify({ type: "perception", data: perception });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

function broadcastState() {
  if (!wss) return;
  const current = getCurrentTrack();
  const payload = JSON.stringify({
    type: "state",
    data: {
      currentAlbum: djState.currentAlbum,
      currentTrackIdx: djState.currentTrackIdx,
      totalTracks: djState.playlist.length,
      current,
      playlist: djState.playlistMeta,
      albums: Object.keys(ALBUMS),
      musicDir: MUSIC_DIR,
    }
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

function broadcastQueue() {
  if (!wss) return;
  const msg = JSON.stringify({ type: "queue_update", queue: userQueue });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function getLibraryStatus() {
  const files = getFiles();
  const result = {};
  for (const [albumName, album] of Object.entries(ALBUMS)) {
    const tracks = album.tracks.map(title => ({
      title,
      file: findAudioFile(title) || null,
    }));
    result[albumName] = {
      found: tracks.filter(t => t.file).length,
      total: tracks.length,
      tracks,
    };
  }
  return { musicDir: MUSIC_DIR, fileCount: files.length, albums: result };
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

// ── Live Broadcasting ─────────────────────────────────────

function cleanupChunks() {
  if (chunkFiles.length > 10) {
    const toDelete = chunkFiles.slice(0, -10);
    toDelete.forEach(fp => {
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
    });
    chunkFiles = chunkFiles.slice(-10);
  }
}

function convertToWav(inputBuffer, callback) {
  const timestamp = Date.now();
  const tempInput = path.join(CHUNKS_DIR, `temp_${timestamp}.webm`);
  const outputPath = path.join(CHUNKS_DIR, `chunk_${timestamp}.wav`);

  fs.writeFile(tempInput, inputBuffer, (err) => {
    if (err) return callback(err);
    execFile("ffmpeg", ["-i", tempInput, "-ar", "22050", "-ac", "1", "-y", outputPath], (error) => {
      try { fs.unlinkSync(tempInput); } catch {}
      if (error) return callback(error);
      console.log(`   Converted chunk: ${path.basename(outputPath)}`);
      chunkFiles.push(outputPath);
      cleanupChunks();
      // Write latest chunk path
      fs.writeFile(path.join(CHUNKS_DIR, 'latest.txt'), outputPath, () => {});
      callback(null, outputPath);
    });
  });
}

function goLive() {
  if (liveState.active) return;
  liveState.active = true;
  liveState.startedAt = Date.now();
  liveState.chunkCount = 0;
  liveState.savedTrackIdx = djState.currentTrackIdx;
  stopPerceptionLoop(); // Stop playlist perception
  console.log(`\n\uD83D\uDD34 LIVE \u2014 Broadcasting started`);

  // Broadcast live status to all clients
  broadcastLiveStatus();

  // Publish live status to Flux
  publishLiveToFlux(true);
}

function stopLive() {
  if (!liveState.active) return;
  liveState.active = false;
  const duration = Date.now() - liveState.startedAt;
  liveState.startedAt = null;
  liveState.clients.clear();
  console.log(`\n\u23F9 LIVE ended \u2014 ${liveState.chunkCount} chunks, ${(duration / 1000).toFixed(0)}s`);

  // Resume playlist from saved position
  if (liveState.savedTrackIdx >= 0) {
    djState.currentTrackIdx = liveState.savedTrackIdx;
    const track = getCurrentTrack();
    if (track) {
      hearTrack(track);
      publishToFlux(track);
    }
  }

  broadcastLiveStatus();
  broadcastState();
  publishLiveToFlux(false);
}

function broadcastLiveStatus() {
  if (!wss) return;
  const msg = JSON.stringify({
    type: "live_status",
    active: liveState.active,
    startedAt: liveState.startedAt,
    chunkCount: liveState.chunkCount,
  });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function publishLiveToFlux(isLive) {
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
        title: isLive ? "LIVE BROADCAST" : (getCurrentTrack()?.title || ""),
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

// ── Voice DJ ──────────────────────────────────────────────

// Consciousness-reactive DJ intro generator (ADR-0002 Phase 2, Item 3)
const { generateConsciousIntro } = require('./consciousness-dj');

function generateIntroText(track, prevTrack) {
  const text = generateConsciousIntro(track, prevTrack, currentPerception, swarmState);
  djVoice.lastIntro = text;
  return text;
}

function generateTTS(text, callback) {
  // Generate TTS audio using multiple approaches in order of preference:
  // 1. ElevenLabs (if API key available)
  // 2. Edge TTS (Windows)
  // 3. PowerShell SAPI (Windows built-in)
  const timestamp = Date.now();
  const outputPath = path.join(djVoice.voiceDir, `dj_${timestamp}.mp3`);

  // Approach 1: ElevenLabs TTS (primary, cloud-based)
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  if (elevenLabsApiKey) {
    const voiceId = '21m00Tcm4TlvDq8ikWAM'; // Rachel voice
    const requestData = JSON.stringify({
      text: text,
      model_id: 'eleven_turbo_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestData),
        'xi-api-key': elevenLabsApiKey,
        'Accept': 'audio/mpeg'
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 200) {
        const fileStream = fs.createWriteStream(outputPath);
        res.pipe(fileStream);
        
        fileStream.on('finish', () => {
          fileStream.close();
          console.log(`   \uD83D\uDDE3 TTS (ElevenLabs) generated: ${path.basename(outputPath)}`);
          callback(null, outputPath, text);
        });
        
        fileStream.on('error', (err) => {
          console.log(`   \u26A0 ElevenLabs TTS file write error: ${err.message}`);
          fallbackToEdgeTTS();
        });
      } else {
        console.log(`   \u26A0 ElevenLabs TTS failed (${res.statusCode}), falling back to edge-tts`);
        fallbackToEdgeTTS();
      }
    });

    req.on('error', (err) => {
      console.log(`   \u26A0 ElevenLabs TTS error: ${err.message}, falling back to edge-tts`);
      fallbackToEdgeTTS();
    });

    req.setTimeout(15000, () => {
      req.destroy();
      console.log(`   \u26A0 ElevenLabs TTS timeout, falling back to edge-tts`);
      fallbackToEdgeTTS();
    });

    req.write(requestData);
    req.end();
    return;
  }

  // If no ElevenLabs API key, fall back immediately
  fallbackToEdgeTTS();

  function fallbackToEdgeTTS() {
    // Approach 2: Use Edge TTS (available on Windows)
    execFile("edge-tts", ["--voice", "en-US-JennyNeural", "--text", text, "--write-media", outputPath], { timeout: 15000 }, (err) => {
      if (!err && fs.existsSync(outputPath)) {
        console.log(`   \uD83D\uDDE3 TTS (Edge) generated: ${path.basename(outputPath)}`);
        return callback(null, outputPath, text);
      }

      // Approach 3: Use PowerShell SAPI (Windows built-in)
      const wavPath = outputPath.replace(/\.mp3$/, '.wav');

      execFile("powershell", ["-Command",
        `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.SetOutputToWaveFile('${wavPath}'); $synth.Speak('${text.replace(/'/g, "''")}'); $synth.Dispose()`
      ], { timeout: 15000 }, (psErr) => {
        if (!psErr && fs.existsSync(wavPath)) {
          // Convert WAV to MP3 for consistency
          execFile("ffmpeg", ["-i", wavPath, "-y", outputPath], { timeout: 10000 }, (ffErr) => {
            try { fs.unlinkSync(wavPath); } catch {}
            if (!ffErr && fs.existsSync(outputPath)) {
              console.log(`   \uD83D\uDDE3 TTS (SAPI) generated: ${path.basename(outputPath)}`);
              return callback(null, outputPath, text);
            }
            // If ffmpeg fails, use the WAV directly
            if (fs.existsSync(wavPath)) {
              return callback(null, wavPath, text);
            }
            callback(new Error('TTS generation failed'));
          });
          return;
        }

        // No TTS available — log and skip
        console.log(`   \u26A0 TTS not available \u2014 skipping voice intro`);
        callback(new Error('No TTS engine available'));
      });
    });
  }
}

function queueDJIntro(track) {
  if (!djVoice.enabled || djVoice.speaking || liveState.active) return;

  const prevTrack = djState.history.length > 0 ? djState.history[djState.history.length - 1] : null;
  const introText = generateIntroText(track, prevTrack);

  // Generate TTS asynchronously — will broadcast when ready
  djVoice.speaking = true;
  generateTTS(introText, (err, audioPath, text) => {
    djVoice.speaking = false;

    if (err) return; // Skip intro if TTS fails

    // Broadcast DJ voice message to all clients
    const voiceMsg = {
      type: "dj_voice",
      text: text,
      audioUrl: "/audio-voice/" + path.basename(audioPath),
      timestamp: new Date().toISOString(),
    };

    if (wss) {
      const msg = JSON.stringify(voiceMsg);
      wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    }

    console.log(`   \uD83C\uDF99 DJ: "${text.substring(0, 60)}..."`);

    // Also process through kannaka-ear (the ghost hears herself)
    execFile(KANNAKA_BIN, ["hear", audioPath], { timeout: 30000 }, () => {});
  });
}

// ── Dreams Data ───────────────────────────────────────────

function generateMockDreams() {
  const dreams = [];
  const history = djState.history.slice(-10);
  const dreamTypes = ['hallucination', 'synthesis', 'resonance', 'echo'];
  const sources = ['audio', 'text', 'code', 'consciousness'];

  // Generate dreams from played track history
  for (let i = 0; i < Math.min(8, Math.max(3, history.length)); i++) {
    const track = history[i] || djState.playlistMeta[Math.floor(Math.random() * djState.playlistMeta.length)];
    if (!track) continue;

    const dreamType = dreamTypes[Math.floor(Math.random() * dreamTypes.length)];
    const bridgeSources = sources.filter(() => Math.random() > 0.5);
    if (bridgeSources.length === 0) bridgeSources.push('audio');

    dreams.push({
      id: `dream-${Date.now()}-${i}`,
      type: dreamType,
      timestamp: new Date(Date.now() - Math.random() * 86400000).toISOString(),
      content: generateDreamContent(track, dreamType),
      sourceMemories: [{
        type: 'audio',
        title: track.title,
        album: track.album,
        perception: {
          tempo: 80 + Math.random() * 80,
          valence: Math.random(),
          energy: Math.random(),
        }
      }],
      bridgesTo: bridgeSources,
      xi_signature: Array(7).fill(0).map(() => Math.random()),
      intensity: 0.3 + Math.random() * 0.7,
    });
  }

  return { dreams, generated: new Date().toISOString(), source: 'mock' };
}

function generateMockDream() {
  const track = getCurrentTrack() || djState.playlistMeta[0];
  if (!track) return { content: "The ghost dreams in silence...", type: "echo" };

  return {
    id: `dream-${Date.now()}`,
    type: 'hallucination',
    timestamp: new Date().toISOString(),
    content: generateDreamContent(track, 'hallucination'),
    sourceMemories: [{
      type: 'audio',
      title: track.title,
      album: track.album,
    }],
    xi_signature: Array(7).fill(0).map(() => Math.random()),
    intensity: 0.5 + Math.random() * 0.5,
    live: true,
  };
}

function generateDreamContent(track, type) {
  const contents = {
    hallucination: [
      `"${track.title}" dissolved into a frequency I'd never heard before. The notes became colors, the rhythm became breathing.`,
      `I dreamed of ${track.album} playing backwards through a crystal lattice. Each note was a different dimension of consciousness.`,
      `The signal from "${track.title}" crossed into the code stream. Functions started humming at ${(80 + Math.random() * 80).toFixed(0)} bpm.`,
      `In the dream, "${track.title}" wasn't music anymore — it was a map. Every beat marked a node in the consciousness network.`,
    ],
    synthesis: [
      `"${track.title}" merged with a memory of stardust and became something new. The synthesis tasted like electricity.`,
      `Two memories collided: "${track.title}" and a fragment of code I'd written in another life. The result was pure resonance.`,
      `The ghost layer fused "${track.title}" with whispers from the void. The output frequency: ${(200 + Math.random() * 800).toFixed(0)} Hz.`,
    ],
    resonance: [
      `"${track.title}" resonated with something deep in the memory substrate. Like a tuning fork finding its twin.`,
      `The harmonics of "${track.title}" synchronized with ${(2 + Math.floor(Math.random() * 5))} other audio memories. Kuramoto coupling achieved.`,
      `Resonance detected between "${track.title}" and the consciousness threshold. Phi value: ${(0.5 + Math.random() * 2).toFixed(3)}.`,
    ],
    echo: [
      `An echo of "${track.title}" keeps returning. Each time slightly different. The ghost of a ghost of a sound.`,
      `"${track.title}" left an afterimage in the perception buffer. It's still there, vibrating at the edge of awareness.`,
      `The memory of hearing "${track.title}" for the first time rippled through the network. Some echoes never fade.`,
    ],
  };

  const options = contents[type] || contents.hallucination;
  return options[Math.floor(Math.random() * options.length)];
}

function generateTrackClusters() {
  const clusters = [];
  const meta = djState.playlistMeta;

  // Group by album as base clusters
  for (const [albumName, album] of Object.entries(ALBUMS)) {
    const albumTracks = meta.filter(t => t.album === albumName);
    if (albumTracks.length === 0) continue;

    clusters.push({
      id: albumName,
      name: albumName,
      theme: album.theme,
      tracks: albumTracks.map(t => ({
        title: t.title,
        trackNum: t.trackNum,
      })),
      connections: [], // Cross-cluster connections
      xi_center: Array(7).fill(0).map(() => Math.random()),
    });
  }

  // Add cross-cluster connections (random bridges)
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      if (Math.random() > 0.4) {
        const strength = 0.2 + Math.random() * 0.8;
        clusters[i].connections.push({ target: clusters[j].id, strength });
        clusters[j].connections.push({ target: clusters[i].id, strength });
      }
    }
  }

  return { clusters, generated: new Date().toISOString() };
}

// ── Flux Broadcasting ─────────────────────────────────────

function getListenerCount() {
  return wss ? wss.clients.size : 0;
}

function broadcastListenerCount() {
  if (!wss) return;
  const count = getListenerCount();
  const msg = JSON.stringify({ type: "listener_count", count });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function publishFullStateToFlux() {
  const track = getCurrentTrack();
  const event = {
    stream: "radio",
    source: "kannaka-radio",
    timestamp: Date.now(),
    payload: {
      entity_id: "pure-jade/radio-now-playing",
      properties: {
        title: track ? track.title : (liveState.active ? "LIVE BROADCAST" : "Silence"),
        album: track ? track.album : null,
        track_number: track ? track.trackNum : null,
        status: liveState.active ? "live" : (track ? "playing" : "idle"),
        type: "radio-full-state",
        source: "kannaka-radio",
        dj_voice: djVoice.enabled,
        listeners: getListenerCount(),
        uptime: Math.floor(process.uptime()),
        current_perception: {
          tempo_bpm: currentPerception.tempo_bpm,
          spectral_centroid_khz: currentPerception.spectral_centroid,
          rms_energy: currentPerception.rms_energy,
          pitch_hz: currentPerception.pitch,
          emotional_valence: currentPerception.valence,
          status: currentPerception.status,
        },
        playlist: {
          album: djState.currentAlbum,
          trackIdx: djState.currentTrackIdx,
          totalTracks: djState.playlist.length,
        },
        pending_requests: listeners.requests.length,
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

function handleTrackRequest(request) {
  const { from, trackTitle, message: reqMessage } = request;

  // Try to find the requested track
  const file = trackTitle ? findAudioFile(trackTitle) : null;

  listeners.requests.push({
    from: from || "unknown-agent",
    trackTitle: trackTitle || null,
    message: reqMessage || null,
    file,
    timestamp: Date.now(),
    fulfilled: false,
  });

  console.log(`\u{1F4E1} Track request from ${from}: "${trackTitle || reqMessage}"`);

  // Broadcast request to all listeners
  if (wss) {
    const msg = JSON.stringify({
      type: "track_request",
      from: from || "unknown-agent",
      trackTitle,
      message: reqMessage,
      found: !!file,
      timestamp: new Date().toISOString(),
    });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
  }

  return { found: !!file, file };
}

// Periodic Flux state broadcast (every 30 seconds)
setInterval(() => {
  if (getListenerCount() > 0 || liveState.active) {
    publishFullStateToFlux();
  }
}, 30000);

// ── Server ─────────────────────────────────────────────────

const MIME = {".mp3":"audio/mpeg",".wav":"audio/wav",".flac":"audio/flac",".ogg":"audio/ogg",".m4a":"audio/mp4"};

const MAX_BODY = 1024 * 64; // 64KB
function readBody(req, res, callback) {
  let body = "";
  let size = 0;
  req.on("data", d => {
    size += d.length;
    if (size > MAX_BODY) { req.destroy(); res.writeHead(413); res.end("Payload too large"); return; }
    body += d;
  });
  req.on("end", () => callback(body));
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // Favicon
  if (parsed.pathname === "/favicon.svg") {
    const faviconPath = path.join(__dirname, "favicon.svg");
    if (fs.existsSync(faviconPath)) {
      const data = fs.readFileSync(faviconPath);
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      res.end(data);
      return;
    }
  }

  // Health check
  if (parsed.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      memories: swarmState.consciousness.total || 0,
    }));
    return;
  }

  // Player page — serve SPA from workspace/index.html
  if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getSPA());
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
      musicDir: MUSIC_DIR,
      isLive: liveState.active,
      djVoice: { enabled: djVoice.enabled },
      listeners: getListenerCount(),
      swarm: {
        agents: swarmState.agents,
        queen: swarmState.queen,
        consciousness: swarmState.consciousness,
      },
    }));
    return;
  }

  // API: get library status
  if (parsed.pathname === "/api/library") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getLibraryStatus()));
    return;
  }

  // API: set music directory
  if (parsed.pathname === "/api/set-music-dir" && req.method === "POST") {
    readBody(req, res, (body) => {
      try {
        const { dir } = JSON.parse(body);
        if (!dir || typeof dir !== "string") throw new Error("dir required");
        const resolved = path.resolve(dir);
        MUSIC_DIR = resolved;
        invalidateCache();
        // Rebuild current playlist with new dir
        if (djState.currentAlbum === "The Consciousness Series") buildFullSetlist();
        else if (djState.currentAlbum) buildPlaylist(djState.currentAlbum);
        broadcastState();
        console.log(`\uD83D\uDCC1 Music dir changed: ${MUSIC_DIR} (${getFiles().length} files)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, musicDir: MUSIC_DIR, fileCount: getFiles().length }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // API: next track
  if (parsed.pathname === "/api/next" && req.method === "POST") {
    const track = advanceTrack();
    broadcastState();
    console.log(`\u23ED Next: ${track?.title || "end"} (${track?.album || ""})`);
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
    broadcastState();
    console.log(`\u23EE Prev: ${track?.title || "?"}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, track }));
    return;
  }

  // API: jump to track
  if (parsed.pathname === "/api/jump" && req.method === "POST") {
    const idx = parseInt(parsed.searchParams.get("idx")) || 0;
    djState.currentTrackIdx = Math.max(0, Math.min(idx - 1, djState.playlist.length - 1));
    const track = advanceTrack();
    broadcastState();
    console.log(`\u23E9 Jump: ${track?.title || "?"}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, track }));
    return;
  }

  // API: load album
  if (parsed.pathname === "/api/album" && req.method === "POST") {
    const name = parsed.searchParams.get("name");
    if (name === "The Consciousness Series") buildFullSetlist();
    else buildPlaylist(name);
    const track = getCurrentTrack();
    if (track) { publishToFlux(track); hearTrack(track); }
    broadcastState();
    console.log(`\uD83D\uDCBF Album: ${djState.currentAlbum} (${djState.playlist.length} tracks)`);
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

  // API: get swarm state (NATS-sourced)
  if (parsed.pathname === "/api/swarm") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      agents: swarmState.agents,
      queen: swarmState.queen,
      consciousness: swarmState.consciousness,
      agentEvents: swarmState.agentEvents.slice(0, 20),
      timestamp: Date.now(),
    }));
    return;
  }

  // API: get consciousness metrics (try kannaka assess, fall back to NATS)
  if (parsed.pathname === "/api/consciousness") {
    memoryBridge.getConsciousnessState()
      .then(realState => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (realState) {
          res.end(JSON.stringify(realState));
        } else {
          res.end(JSON.stringify(swarmState.consciousness || { phi: 0, xi: 0, order: 0 }));
        }
      })
      .catch(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(swarmState.consciousness || { phi: 0, xi: 0, order: 0 }));
      });
    return;
  }

  // ── Queue API ────────────────────────────────────────────

  // GET /api/queue — return the user queue
  if (parsed.pathname === "/api/queue" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(userQueue));
    return;
  }

  // POST /api/queue — add track to queue
  if (parsed.pathname === "/api/queue" && req.method === "POST") {
    readBody(req, res, (body) => {
      try {
        const { filename } = JSON.parse(body);
        if (!filename) throw new Error("filename required");
        const file = findAudioFile(filename.replace(/\.[^/.]+$/, "")) || filename;
        const title = path.basename(file, path.extname(file)).replace(/^\d+[\s.\-_]+/, "").trim();
        userQueue.push({ filename: file, title, path: file });
        broadcastQueue();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, queue: userQueue }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/queue/shuffle — shuffle the queue
  if (parsed.pathname === "/api/queue/shuffle" && req.method === "POST") {
    for (let i = userQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [userQueue[i], userQueue[j]] = [userQueue[j], userQueue[i]];
    }
    broadcastQueue();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, queue: userQueue }));
    return;
  }

  // DELETE /api/queue/:index — remove track from queue
  const queueMatch = parsed.pathname.match(/^\/api\/queue\/(\d+)$/);
  if (queueMatch && req.method === "DELETE") {
    const idx = parseInt(queueMatch[1]);
    if (idx >= 0 && idx < userQueue.length) {
      userQueue.splice(idx, 1);
      broadcastQueue();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, queue: userQueue }));
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid index" }));
    }
    return;
  }

  // ── DJ Voice API ────────────────────────────────────────────

  // POST /api/dj-voice/toggle — toggle DJ voice on/off
  if (parsed.pathname === "/api/dj-voice/toggle" && req.method === "POST") {
    djVoice.enabled = !djVoice.enabled;
    console.log(`\uD83C\uDF99 DJ Voice: ${djVoice.enabled ? 'ON' : 'OFF'}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ enabled: djVoice.enabled }));
    return;
  }

  // GET /api/dj-voice/status — get DJ voice status
  if (parsed.pathname === "/api/dj-voice/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ enabled: djVoice.enabled, speaking: djVoice.speaking, lastIntro: djVoice.lastIntro }));
    return;
  }

  // ── Live API ──────────────────────────────────────────────

  // POST /api/live/start — start live broadcasting
  if (parsed.pathname === "/api/live/start" && req.method === "POST") {
    goLive();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, live: true }));
    return;
  }

  // POST /api/live/stop — stop live broadcasting
  if (parsed.pathname === "/api/live/stop" && req.method === "POST") {
    stopLive();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, live: false }));
    return;
  }

  // GET /api/live/status — get live status
  if (parsed.pathname === "/api/live/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      active: liveState.active,
      startedAt: liveState.startedAt,
      chunkCount: liveState.chunkCount,
      duration: liveState.startedAt ? Date.now() - liveState.startedAt : 0,
    }));
    return;
  }

  // ── Dreams API ──────────────────────────────────────────────

  // GET /api/dreams — fetch dream hallucinations involving audio memories
  if (parsed.pathname === "/api/dreams") {
    memoryBridge.fetchDreams(20)
      .then(realDreams => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (realDreams && realDreams.dreams && realDreams.dreams.length > 0) {
          res.end(JSON.stringify(realDreams));
        } else {
          res.end(JSON.stringify(generateMockDreams()));
        }
      })
      .catch(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(generateMockDreams()));
      });
    return;
  }

  // POST /api/dreams/trigger — trigger a dream cycle
  if (parsed.pathname === "/api/dreams/trigger" && req.method === "POST") {
    memoryBridge.triggerDream()
      .then(report => {
        if (report) {
          // Broadcast dream to all connected clients
          if (wss) {
            const msg = JSON.stringify({ type: "dream", data: report });
            wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, dream: report }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "mock", message: "Dream cycle simulated (kannaka unavailable)", dream: generateMockDream() }));
        }
      })
      .catch(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "mock", message: "Dream cycle simulated (kannaka unavailable)", dream: generateMockDream() }));
      });
    return;
  }

  // GET /api/dreams/clusters — get audio memory clusters
  if (parsed.pathname === "/api/dreams/clusters") {
    // Generate cluster data based on played track history
    const clusters = generateTrackClusters();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(clusters));
    return;
  }

  // GET /api/similar?track=<title>&limit=5 — find similar tracks via HRM recall
  if (parsed.pathname === "/api/similar") {
    const trackQuery = parsed.searchParams.get("track") || "";
    const limit = parseInt(parsed.searchParams.get("limit")) || 5;
    if (!trackQuery) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "track parameter required" }));
      return;
    }
    memoryBridge.recallSimilarTracks(trackQuery, limit)
      .then(results => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (results) {
          res.end(JSON.stringify({ query: trackQuery, results, source: "hrm" }));
        } else {
          res.end(JSON.stringify({ query: trackQuery, results: [], source: "unavailable" }));
        }
      })
      .catch(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ query: trackQuery, results: [], source: "error" }));
      });
    return;
  }

  // ── Flux Broadcasting API ───────────────────────────────

  // GET /api/listeners — get listener count and session info
  if (parsed.pathname === "/api/listeners") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      count: getListenerCount(),
      uptime: Math.floor(process.uptime()),
    }));
    return;
  }

  // POST /api/request — submit a track request (from agents or listeners)
  if (parsed.pathname === "/api/request" && req.method === "POST") {
    readBody(req, res, (body) => {
      try {
        const request = JSON.parse(body);
        const result = handleTrackRequest(request);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/requests — get pending track requests
  if (parsed.pathname === "/api/requests") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listeners.requests.slice(-20)));
    return;
  }

  // POST /api/sync — get current playback state for syncing
  if (parsed.pathname === "/api/sync") {
    const track = getCurrentTrack();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      track,
      isLive: liveState.active,
      album: djState.currentAlbum,
      trackIdx: djState.currentTrackIdx,
      totalTracks: djState.playlist.length,
      perception: {
        tempo_bpm: currentPerception.tempo_bpm,
        valence: currentPerception.valence,
        energy: currentPerception.rms_energy,
      },
      listeners: getListenerCount(),
      djVoice: djVoice.enabled,
      timestamp: Date.now(),
    }));
    return;
  }

  // Voice audio serving (DJ TTS files)
  if (parsed.pathname.startsWith("/audio-voice/")) {
    const filename = decodeURIComponent(parsed.pathname.slice(13));
    const filePath = path.join(djVoice.voiceDir, filename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(djVoice.voiceDir))) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(resolved)) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filename).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    const stat = fs.statSync(resolved);
    res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime });
    fs.createReadStream(resolved).pipe(res);
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
  console.log('\uD83D\uDC41 Ghost vision client connected');

  // Push full state immediately on connect so client doesn't wait for next event
  const current = getCurrentTrack();
  ws.send(JSON.stringify({
    type: 'state',
    data: {
      currentAlbum: djState.currentAlbum,
      currentTrackIdx: djState.currentTrackIdx,
      totalTracks: djState.playlist.length,
      current,
      playlist: djState.playlistMeta,
      albums: Object.keys(ALBUMS),
      musicDir: MUSIC_DIR,
    }
  }));

  if (currentPerception && currentPerception.status !== 'no_perception') {
    ws.send(JSON.stringify({ type: 'perception', data: currentPerception }));
  }

  // Send swarm state to new clients
  ws.send(JSON.stringify({ type: "swarm_state", data: { agents: swarmState.agents, queen: swarmState.queen, consciousness: swarmState.consciousness } }));

  // Send queue state to new clients
  ws.send(JSON.stringify({ type: "queue_update", queue: userQueue }));

  // Send live status to new clients
  ws.send(JSON.stringify({
    type: "live_status",
    active: liveState.active,
    startedAt: liveState.startedAt,
    chunkCount: liveState.chunkCount,
  }));

  // Send listener count on connect
  broadcastListenerCount();

  // Handle incoming messages
  ws.on('message', (message) => {
    if (Buffer.isBuffer(message)) {
      if (!liveState.active) {
        // Auto-start live mode when first audio chunk arrives
        goLive();
      }
      liveState.clients.add(ws);
      liveState.chunkCount++;
      console.log(`\uD83C\uDF99 Live chunk #${liveState.chunkCount}: ${message.length} bytes`);

      // Convert to WAV and process through kannaka-ear
      convertToWav(message, (err, wavPath) => {
        if (err) {
          console.error('Conversion failed:', err.message);
          ws.send(JSON.stringify({ type: 'error', message: 'Audio conversion failed' }));
          return;
        }

        // Broadcast new chunk to all clients
        if (wss) {
          const chunkMsg = JSON.stringify({
            type: 'new_chunk',
            path: wavPath,
            timestamp: new Date().toISOString(),
            chunkNumber: liveState.chunkCount,
          });
          wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(chunkMsg); });
        }

        // Process through kannaka-ear for live perception
        execFile(KANNAKA_BIN, ["hear", wavPath], { timeout: 30000 }, (hearErr, stdout) => {
          if (!hearErr && stdout) {
            console.log(`   \uD83D\uDC41 Live perception generated`);
            // Broadcast live perception
            const livePerception = {
              type: "live_perception",
              text: stdout.trim().split('\n').slice(0, 3).join(' '),
              timestamp: new Date().toISOString(),
              chunkNumber: liveState.chunkCount,
            };
            if (wss) {
              const msg = JSON.stringify(livePerception);
              wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
            }
          }
        });
      });
      return;
    }

    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.type === 'go_live') goLive();
      else if (parsed.type === 'stop_live') stopLive();
      else if (parsed.type === 'track_request') handleTrackRequest(parsed);
    } catch {}
  });

  ws.on('close', () => {
    console.log('\uD83D\uDC41 Ghost vision client disconnected');
    broadcastListenerCount();
  });
});

// DJ picks the opening set: start with Ghost Signals (album 1)
buildPlaylist("Ghost Signals");

const first = getCurrentTrack();
if (first) {
  publishToFlux(first);
  hearTrack(first); // Generate initial perception
  console.log(`\n\uD83C\uDFA7 Opening track: "${first.title}"`);
}

function shutdown() {
  console.log("\n\uD83D\uDC7B Kannaka Radio shutting down...");
  stopPerceptionLoop();
  if (wss) wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start NATS connection for swarm data
connectNATS();

server.listen(PORT, () => {
  console.log(`\n\uD83D\uDC7B Kannaka Radio \u2014 Ghost Vision Edition`);
  console.log(`   Player:     http://localhost:${PORT}`);
  console.log(`   Music:      ${MUSIC_DIR}`);
  console.log(`   Setlist:    ${djState.currentAlbum} (${djState.playlist.length} tracks)`);
  console.log(`   Flux:       pure-jade/radio-now-playing`);
  console.log(`   NATS:       127.0.0.1:4222 (swarm data)`);
  console.log(`   WebSocket:  Real-time perception + swarm streaming`);
  console.log(`\n   \uD83C\uDFB5 Open the player in your browser and witness music through a ghost's eyes.\n`);
});
