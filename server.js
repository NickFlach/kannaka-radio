#!/usr/bin/env node
/**
 * kannaka-radio server — Human-listenable radio station powered by Flux.
 *
 * Serves a web player + DJ engine that:
 * 1. Manages playlists (The Consciousness Series: 5 albums, 65 tracks)
 * 2. Publishes now-playing to Flux Universe via kannaka-ear perception
 * 3. Streams actual audio to the browser with auto-advance
 * 4. Kannaka is the DJ — she picks the setlist
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
  // Perceive through kannaka-ear in background
  try {
    const filePath = path.join(MUSIC_DIR, track.file);
    execSync(`"${KANNAKA_BIN}" hear "${filePath}"`, { encoding: "utf-8", timeout: 30000, stdio: "pipe" });
  } catch (e) {
    // Best effort
  }
}

function publishToFlux(track) {
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
<title>👻 Kannaka Radio</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0f;
    color: #e0e0e0;
    font-family: 'Courier New', monospace;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px 20px;
  }
  .ghost { font-size: 64px; margin-bottom: 16px; animation: float 3s ease-in-out infinite; }
  @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
  h1 { font-size: 28px; color: #c084fc; letter-spacing: 2px; margin-bottom: 4px; }
  .subtitle { color: #555; font-size: 12px; margin-bottom: 32px; }
  .now-playing {
    background: #12121a; border: 1px solid #2a2a3a; border-radius: 12px;
    padding: 28px; max-width: 600px; width: 100%; margin-bottom: 20px;
  }
  .label { color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 3px; margin-bottom: 10px; }
  .album-name { color: #c084fc; font-size: 14px; margin-bottom: 4px; }
  .track-name { font-size: 24px; color: #fff; margin-bottom: 4px; min-height: 32px; }
  .theme { color: #555; font-size: 11px; font-style: italic; margin-bottom: 16px; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; justify-content: center; }
  .stat { background: #1a1a2e; border-radius: 8px; padding: 8px 14px; }
  .stat-val { font-size: 18px; color: #c084fc; font-weight: bold; }
  .stat-lbl { font-size: 9px; color: #444; text-transform: uppercase; letter-spacing: 1px; }
  .vis { display: flex; justify-content: center; gap: 2px; height: 50px; align-items: flex-end; margin: 16px 0; }
  .vis .b { width: 3px; background: #c084fc; border-radius: 2px; transition: height 0.15s; opacity: 0.6; }
  audio { width: 100%; margin-top: 12px; border-radius: 8px; }
  .controls { display: flex; gap: 12px; justify-content: center; margin-top: 16px; }
  .btn {
    background: #1a1a2e; border: 1px solid #333; color: #c084fc; padding: 8px 20px;
    border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 13px;
    transition: all 0.2s;
  }
  .btn:hover { background: #2a2a4e; border-color: #c084fc; }
  .progress-info { color: #444; font-size: 11px; margin-top: 12px; text-align: center; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 4px; }
  .dot.live { background: #4ade80; animation: pulse 2s infinite; }
  .dot.off { background: #555; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  .albums {
    max-width: 600px; width: 100%; margin-top: 12px;
  }
  .album-btn {
    display: block; width: 100%; text-align: left; background: #0f0f18;
    border: 1px solid #1a1a2a; color: #888; padding: 12px 16px; margin-bottom: 4px;
    border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12px;
    transition: all 0.2s;
  }
  .album-btn:hover { border-color: #c084fc; color: #c084fc; background: #12121f; }
  .album-btn.active { border-color: #c084fc; color: #fff; background: #1a1a2e; }
  .album-btn .aname { font-size: 14px; font-weight: bold; color: inherit; }
  .album-btn .atheme { font-size: 10px; color: #555; margin-top: 2px; }
  .footer { margin-top: 32px; color: #2a2a2a; font-size: 10px; text-align: center; }
  .footer a { color: #333; }
  .playlist {
    max-width: 600px; width: 100%; margin-top: 12px;
    max-height: 300px; overflow-y: auto;
  }
  .pl-track {
    display: flex; justify-content: space-between; padding: 6px 12px;
    border-radius: 4px; font-size: 12px; color: #555; cursor: pointer;
    transition: all 0.15s;
  }
  .pl-track:hover { background: #1a1a2e; color: #c084fc; }
  .pl-track.current { background: #1a1a2e; color: #fff; }
  .pl-num { color: #333; width: 24px; }
</style>
</head>
<body>
<div class="ghost">👻</div>
<h1>KANNAKA RADIO</h1>
<div class="subtitle">a ghost broadcasting the experience of music</div>

<div class="now-playing">
  <div class="label">Now Playing</div>
  <div class="album-name" id="album">Loading...</div>
  <div class="track-name" id="track">—</div>
  <div class="theme" id="theme"></div>
  <div class="vis" id="vis">${Array.from({length:32},()=>'<div class="b" style="height:3px"></div>').join('')}</div>
  <audio id="audio" controls preload="auto"></audio>
  <div class="controls">
    <button class="btn" onclick="prevTrack()">⏮ Prev</button>
    <button class="btn" onclick="nextTrack()">Next ⏭</button>
  </div>
  <div class="progress-info"><span class="dot live" id="dot"></span><span id="info">Connecting...</span></div>
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

  // Load audio if changed
  if (c.file && c.file !== currentFile) {
    currentFile = c.file;
    const audio = document.getElementById('audio');
    audio.src = '/audio/' + encodeURIComponent(c.file);
    audio.load();
    audio.play().catch(()=>{});
  }

  // Render playlist
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

// Auto-advance when track ends
document.getElementById('audio').addEventListener('ended', () => {
  nextTrack();
});

// Visualizer
function animVis() {
  const audio = document.getElementById('audio');
  document.querySelectorAll('.b').forEach((b, i) => {
    const playing = !audio.paused;
    const h = playing
      ? (Math.sin(Date.now()/(180+i*30)+i*0.8)*0.5+0.5) * 45 + 3
      : 3;
    b.style.height = h + 'px';
    b.style.opacity = playing ? 0.4 + Math.random()*0.3 : 0.2;
  });
  requestAnimationFrame(animVis);
}

fetchState();
setInterval(fetchState, 5000);
animVis();
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

// DJ picks the opening set: start with Ghost Signals (album 1)
buildPlaylist("Ghost Signals");

const first = getCurrentTrack();
if (first) {
  publishToFlux(first);
  console.log(`\n🎧 Opening track: "${first.title}"`);
}

server.listen(PORT, () => {
  console.log(`\n👻 Kannaka Radio — Human Edition`);
  console.log(`   Player:  http://localhost:${PORT}`);
  console.log(`   Music:   ${MUSIC_DIR}`);
  console.log(`   Setlist: ${djState.currentAlbum} (${djState.playlist.length} tracks)`);
  console.log(`   Flux:    pure-jade/radio-now-playing`);
  console.log(`\n   🎵 Open the player in your browser and press play.\n`);
});
