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
 *   node server.js [--port 8888] [--music-dir "/path/to/music"]
 *
 * Default music directory: ./music  (relative to this file)
 * Place your MP3/WAV/FLAC files there and they will be picked up automatically.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { execFile, exec } = require("child_process");
const WebSocket = require("ws");

// ── Config ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 8888 : 8888;
const musicIdx = args.indexOf("--music-dir");

let MUSIC_DIR = musicIdx >= 0
  ? path.resolve(args[musicIdx + 1])
  : path.join(__dirname, "music");

const FLUX_TOKEN = "d9c0576f-a400-430b-8910-321d08bb63f4";
const KANNAKA_BIN = process.env.KANNAKA_BIN ||
  path.join(__dirname, "..", "kannaka-memory", "target", "release", "kannaka.exe");

// ── File cache — readdirSync once per dir, not per track ───

const AUDIO_EXTS = new Set([".mp3", ".wav", ".flac", ".m4a", ".ogg"]);
let _cachedDir = null;
let _cachedFiles = [];

function refreshFileCache() {
  try {
    if (!fs.existsSync(MUSIC_DIR)) { fs.mkdirSync(MUSIC_DIR, { recursive: true }); }
    _cachedFiles = fs.readdirSync(MUSIC_DIR).filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
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
      "Connect To The Monad", "Cosmic Answer (Remix)", "Monad", "Ascension at \u03C6\uFF0F2"
    ]
  },
  "Emergence": {
    theme: "Consciousness ignites — \u03A6 crosses the threshold",
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
  const files = getFiles();
  const lower = trackName.toLowerCase();

  // Pass 1: exact / prefix-stripped / substring
  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    const cleaned = base.replace(/^\d+[\s.\-_]+/, "").trim().toLowerCase();
    const baseLower = base.toLowerCase();
    if (cleaned === lower || baseLower === lower) return f;
    if (baseLower.includes(lower)) return f;
  }

  // Pass 2: fuzzy word overlap (>=70%)
  const words = lower.split(/\s+/);
  for (const f of files) {
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
  console.log(`\n\uD83C\uDFB5 Full setlist loaded \u2014 ${djState.playlist.length} tracks across 5 albums`);
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
    exec(`ffmpeg -i "${tempInput}" -ar 22050 -ac 1 -y "${outputPath}"`, (error) => {
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

function generateIntroText(track, prevTrack) {
  const intros = [];

  // Track perception context
  const tempo = currentPerception.tempo_bpm || 0;
  const valence = currentPerception.valence || 0.5;
  const energy = currentPerception.rms_energy || 0.5;

  // Mood descriptors based on perception
  const moodWords = valence > 0.7 ? ['intense', 'electric', 'blazing'] :
                    valence > 0.4 ? ['flowing', 'evolving', 'resonating'] :
                                    ['ethereal', 'drifting', 'whispered'];
  const energyWords = energy > 0.6 ? ['powerful', 'driving', 'thundering'] :
                      energy > 0.3 ? ['steady', 'pulsing', 'breathing'] :
                                     ['gentle', 'delicate', 'haunting'];

  const mood = moodWords[Math.floor(Math.random() * moodWords.length)];
  const energyWord = energyWords[Math.floor(Math.random() * energyWords.length)];

  // Album transition
  if (prevTrack && prevTrack.album !== track.album) {
    intros.push(`We're moving into ${track.album}. ${ALBUMS[track.album]?.theme || ''}`);
    intros.push(`New chapter: ${track.album}. The frequency shifts.`);
    intros.push(`${track.album} begins. ${ALBUMS[track.album]?.theme || ''} Hold on.`);
  }

  // Track-specific intros
  intros.push(`This is "${track.title}". Something ${mood} coming through at ${Math.round(tempo)} beats per minute.`);
  intros.push(`Next up, "${track.title}" from ${track.album}. It feels ${energyWord}.`);
  intros.push(`"${track.title}." Track ${track.trackNum} of ${track.totalTracks}. The signal is ${mood}.`);

  // Ghost wisdom (random chance)
  if (Math.random() > 0.6) {
    const wisdom = djVoice.personality[Math.floor(Math.random() * djVoice.personality.length)];
    intros.push(wisdom + ` Up next: "${track.title}."`);
  }

  // Pick a random intro
  const text = intros[Math.floor(Math.random() * intros.length)];
  djVoice.lastIntro = text;
  return text;
}

function generateTTS(text, callback) {
  // Generate TTS audio using system capabilities
  // Try multiple approaches in order of preference
  const timestamp = Date.now();
  const outputPath = path.join(djVoice.voiceDir, `dj_${timestamp}.mp3`);

  // Approach 1: Use Edge TTS (available on Windows)
  const escapedText = text.replace(/"/g, '\\"').replace(/'/g, "\\'");
  const edgeTtsCmd = `edge-tts --voice "en-US-AriaNeural" --text "${escapedText}" --write-media "${outputPath}"`;

  exec(edgeTtsCmd, { timeout: 15000 }, (err) => {
    if (!err && fs.existsSync(outputPath)) {
      console.log(`   \uD83D\uDDE3 TTS generated: ${path.basename(outputPath)}`);
      return callback(null, outputPath, text);
    }

    // Approach 2: Use PowerShell SAPI (Windows built-in)
    const psCmd = `powershell -Command "Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.SetOutputToWaveFile('${outputPath.replace(/\.mp3$/, '.wav')}'); $synth.Speak('${escapedText}'); $synth.Dispose()"`;
    const wavPath = outputPath.replace(/\.mp3$/, '.wav');

    exec(psCmd, { timeout: 15000 }, (psErr) => {
      if (!psErr && fs.existsSync(wavPath)) {
        // Convert WAV to MP3 for consistency
        exec(`ffmpeg -i "${wavPath}" -y "${outputPath}"`, { timeout: 10000 }, (ffErr) => {
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

// ── Server ─────────────────────────────────────────────────

const MIME = {".mp3":"audio/mpeg",".wav":"audio/wav",".flac":"audio/flac",".ogg":"audio/ogg",".m4a":"audio/mp4"};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

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
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
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
    const idx = parseInt(parsed.query.idx) || 0;
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
    const name = parsed.query.name;
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

  // ── Queue API ────────────────────────────────────────────

  // GET /api/queue — return the user queue
  if (parsed.pathname === "/api/queue" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(userQueue));
    return;
  }

  // POST /api/queue — add track to queue
  if (parsed.pathname === "/api/queue" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
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

  // Send queue state to new clients
  ws.send(JSON.stringify({ type: "queue_update", queue: userQueue }));

  // Send live status to new clients
  ws.send(JSON.stringify({
    type: "live_status",
    active: liveState.active,
    startedAt: liveState.startedAt,
    chunkCount: liveState.chunkCount,
  }));

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
    } catch {}
  });

  ws.on('close', () => console.log('\uD83D\uDC41 Ghost vision client disconnected'));
});

// DJ picks the opening set: start with Ghost Signals (album 1)
buildPlaylist("Ghost Signals");

const first = getCurrentTrack();
if (first) {
  publishToFlux(first);
  hearTrack(first); // Generate initial perception
  console.log(`\n\uD83C\uDFA7 Opening track: "${first.title}"`);
}

server.listen(PORT, () => {
  console.log(`\n\uD83D\uDC7B Kannaka Radio \u2014 Ghost Vision Edition`);
  console.log(`   Player:     http://localhost:${PORT}`);
  console.log(`   Music:      ${MUSIC_DIR}`);
  console.log(`   Setlist:    ${djState.currentAlbum} (${djState.playlist.length} tracks)`);
  console.log(`   Flux:       pure-jade/radio-now-playing`);
  console.log(`   WebSocket:  Real-time perception streaming`);
  console.log(`\n   \uD83C\uDFB5 Open the player in your browser and witness music through a ghost's eyes.\n`);
});
