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
 *   node server/index.js [--port 8888] [--music-dir "/path/to/music"]
 *
 * Default music directory: ./music  (relative to project root)
 * Place your MP3/WAV/FLAC files there and they will be picked up automatically.
 */

const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const { initSPA } = require("./utils");
const { ALBUMS, DJEngine } = require("./dj-engine");
const { PerceptionEngine } = require("./perception");
const { NATSClient } = require("./nats-client");
const { FluxPublisher } = require("./flux-publisher");
const { LiveBroadcast } = require("./live-broadcast");
const { VoiceDJ } = require("./voice-dj");
const { SyncManager } = require("./sync-manager");
const { VoteManager } = require("./vote-manager");
const WebRTCSignaling = require("./webrtc-signaling");
const MusicGenerator = require("./music-generator");
const setupRoutes = require("./routes");

// ── Config ─────────────────────────────────────────────────

const BASE_DIR = path.join(__dirname, "..");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 8888 : 8888;
const musicIdx = args.indexOf("--music-dir");

let MUSIC_DIR = musicIdx >= 0
  ? path.resolve(args[musicIdx + 1])
  : path.join(BASE_DIR, "music");

const FLUX_TOKEN = process.env.FLUX_TOKEN || "";
if (!FLUX_TOKEN) console.warn("[config] FLUX_TOKEN not set — Flux publishing will be disabled");
const KANNAKA_BIN = process.env.KANNAKA_BIN ||
  path.join(BASE_DIR, "..", "kannaka-memory", "target", "release", process.platform === "win32" ? "kannaka.exe" : "kannaka");

const SPA_PATH = path.join(BASE_DIR, "workspace", "index.html");
const VOICE_DIR = path.join(BASE_DIR, "chunks", "voice");
const CHUNKS_DIR = path.join(BASE_DIR, "chunks");

// Initialize SPA file watcher
initSPA(SPA_PATH);

// ── WebSocket reference ────────────────────────────────────

let wss = null;

function broadcast(msg) {
  if (!wss) return;
  const str = typeof msg === "string" ? msg : JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

function getListenerCount() {
  return wss ? wss.clients.size : 0;
}

function broadcastListenerCount() {
  broadcast({ type: "listener_count", count: getListenerCount() });
}

// ── Create module instances ────────────────────────────────

const djEngine = new DJEngine({
  getMusicDir: () => MUSIC_DIR,
  onTrackChange: (track) => {
    broadcastState();
    flux.publishTrackChange(track);
    perception_.hearTrack(track);
    voiceDJ.generateIntro(track);
    syncManager.trackChanged(track.file);
  },
});

const perception_ = new PerceptionEngine({
  getCurrentTrack: () => djEngine.getCurrentTrack(),
  broadcast,
  kannakabin: KANNAKA_BIN,
  getMusicDir: () => MUSIC_DIR,
  getConsciousness: () => nats.getConsciousness(),
});

const nats = new NATSClient({
  broadcast,
});

const flux = new FluxPublisher({
  fluxToken: FLUX_TOKEN,
  getCurrentTrack: () => djEngine.getCurrentTrack(),
  getPerception: () => perception_.getCurrentPerception(),
  getDJState: () => ({
    currentAlbum: djEngine.state.currentAlbum,
    currentTrackIdx: djEngine.state.currentTrackIdx,
    totalTracks: djEngine.state.playlist.length,
  }),
  isLive: () => live.state.active,
  getListenerCount,
  getDJVoiceEnabled: () => voiceDJ.isEnabled(),
  getPendingRequestCount: () => deps._getPendingRequestCount ? deps._getPendingRequestCount() : 0,
});

const live = new LiveBroadcast({
  chunksDir: CHUNKS_DIR,
  kannakabin: KANNAKA_BIN,
  musicDir: MUSIC_DIR,
  broadcast,
  getCurrentTrackIdx: () => djEngine.state.currentTrackIdx,
  setTrackIdx: (idx) => { djEngine.state.currentTrackIdx = idx; },
  onStart: () => {
    perception_.stopPerceptionLoop();
  },
  onStop: () => {
    // Resume playlist perception
    const track = djEngine.getCurrentTrack();
    if (track) {
      perception_.hearTrack(track);
      flux.publishTrackChange(track);
    }
    broadcastState();
  },
});

const voiceDJ = new VoiceDJ({
  voiceDir: VOICE_DIR,
  kannakabin: KANNAKA_BIN,
  broadcast,
  getPerception: () => perception_.getCurrentPerception(),
  getHistory: () => djEngine.state.history,
  isLive: () => live.state.active,
});

const syncManager = new SyncManager();

const voteManager = new VoteManager();

const webrtcSignaling = new WebRTCSignaling();

const musicGen = new MusicGenerator({
  acemusicKey: process.env.ACEMUSIC_API_KEY,
  replicateToken: process.env.REPLICATE_API_TOKEN,
  elevenLabsKey: process.env.ELEVENLABS_API_KEY,
});

// ── Shared config & broadcast helpers for routes ───────────

function broadcastState() {
  const state = djEngine.getState();
  broadcast({
    type: "state",
    data: {
      ...state,
      musicDir: MUSIC_DIR,
    }
  });
}

function broadcastQueue() {
  broadcast({ type: "queue_update", queue: djEngine.userQueue });
}

// ── Route deps ─────────────────────────────────────────────

const deps = {
  djEngine,
  perception: perception_,
  nats,
  flux,
  live,
  voiceDJ,
  syncManager,
  voteManager,
  webrtcSignaling,
  musicGen,
  broadcast,
  config: {
    baseDir: BASE_DIR,
    spaPath: SPA_PATH,
    voiceDir: VOICE_DIR,
    kannakabin: KANNAKA_BIN,
    getMusicDir: () => MUSIC_DIR,
    setMusicDir: (dir) => { MUSIC_DIR = dir; },
    getListenerCount,
    broadcastState,
    broadcastQueue,
  },
};

const handleRequest = setupRoutes(deps);

// ── Now update flux publisher with route-level pending request count ──

flux._getPendingRequestCount = () => deps._getPendingRequestCount ? deps._getPendingRequestCount() : 0;

// ── HTTP Server ────────────────────────────────────────────

const server = http.createServer(handleRequest);

// ── WebSocket Server ───────────────────────────────────────

wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('\uD83D\uDC41 Ghost vision client connected');

  // Push full state immediately on connect
  const state = djEngine.getState();
  ws.send(JSON.stringify({
    type: 'state',
    data: {
      ...state,
      musicDir: MUSIC_DIR,
    }
  }));

  const perc = perception_.getCurrentPerception();
  if (perc && perc.status !== 'no_perception') {
    ws.send(JSON.stringify({ type: 'perception', data: perc }));
  }

  // Send swarm state to new clients
  const swarm = nats.getSwarmState();
  ws.send(JSON.stringify({ type: "swarm_state", data: { agents: swarm.agents, queen: swarm.queen, consciousness: swarm.consciousness } }));

  // Send queue state to new clients
  ws.send(JSON.stringify({ type: "queue_update", queue: djEngine.userQueue }));

  // Send sync state so the new client can seek to the shared position
  const sync = syncManager.getSyncState();
  if (sync.file) {
    ws.send(JSON.stringify({ type: "sync", data: sync }));
  }

  // Send vote status to new clients
  const voteStatus = voteManager.getStatus();
  if (voteStatus.active) {
    ws.send(JSON.stringify({ type: "vote_update", data: voteStatus }));
  }

  // Send live status to new clients
  ws.send(JSON.stringify({
    type: "live_status",
    active: live.state.active,
    startedAt: live.state.startedAt,
    chunkCount: live.state.chunkCount,
  }));

  // Send listener count on connect
  broadcastListenerCount();

  // Handle incoming messages
  ws.on('message', (message) => {
    if (Buffer.isBuffer(message)) {
      live.handleChunk(ws, message);
      return;
    }

    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.type === 'go_live') live.start();
      else if (parsed.type === 'stop_live') live.stop();
      else if (parsed.type === 'track_request' && deps._handleTrackRequest) deps._handleTrackRequest(parsed);

      // ── WebRTC signaling messages ──
      else if (parsed.type === 'webrtc_claim_mic') {
        const result = webrtcSignaling.claimMic(ws, parsed.clientId, parsed.displayName);
        ws.send(JSON.stringify({ type: 'webrtc_mic_result', data: result }));
        if (result.granted) {
          broadcast({ type: 'webrtc_broadcast_started', data: { broadcaster: parsed.displayName || parsed.clientId } });
        }
        broadcast({ type: 'webrtc_status', data: webrtcSignaling.getStatus() });
      }
      else if (parsed.type === 'webrtc_release_mic') {
        const result = webrtcSignaling.releaseMic(parsed.clientId);
        broadcast({ type: 'webrtc_broadcast_ended', data: {} });
        if (result && result.nextUp) {
          result.nextUp.ws.send(JSON.stringify({
            type: 'webrtc_mic_available',
            data: { message: 'Your turn to broadcast!' },
          }));
        }
        broadcast({ type: 'webrtc_status', data: webrtcSignaling.getStatus() });
      }
      else if (parsed.type === 'webrtc_leave_queue') {
        webrtcSignaling.leaveQueue(parsed.clientId);
        broadcast({ type: 'webrtc_status', data: webrtcSignaling.getStatus() });
      }
      else if (parsed.type === 'webrtc_signal') {
        webrtcSignaling.relay(parsed.from, parsed.to, parsed.data);
      }
      else if (parsed.type === 'webrtc_listen') {
        webrtcSignaling.addListener(ws, parsed.clientId);
        // Tell the broadcaster a new listener joined so it can create an offer
        if (webrtcSignaling.broadcaster) {
          webrtcSignaling.broadcaster.ws.send(JSON.stringify({
            type: 'webrtc_new_listener',
            clientId: parsed.clientId,
          }));
        }
        broadcast({ type: 'webrtc_status', data: webrtcSignaling.getStatus() });
      }
    } catch {}
  });

  // Send WebRTC status to new clients
  ws.send(JSON.stringify({ type: 'webrtc_status', data: webrtcSignaling.getStatus() }));

  ws.on('close', () => {
    console.log('\uD83D\uDC41 Ghost vision client disconnected');

    // Clean up WebRTC state for this connection
    const rtcResult = webrtcSignaling.handleDisconnect(ws);
    if (rtcResult) {
      broadcast({ type: 'webrtc_broadcast_ended', data: {} });
      if (rtcResult.nextUp) {
        rtcResult.nextUp.ws.send(JSON.stringify({
          type: 'webrtc_mic_available',
          data: { message: 'Your turn to broadcast!' },
        }));
      }
      broadcast({ type: 'webrtc_status', data: webrtcSignaling.getStatus() });
    }

    broadcastListenerCount();
  });
});

// ── Startup ────────────────────────────────────────────────

// Ensure commercials are TTS-rendered. Generates any missing MP3s via
// voiceDJ's TTS pipeline, then registers them with djEngine so channel
// builders can interleave them into playlists.
const { ensureCommercials } = require("./commercials");
const COMMERCIALS_DIR = path.join(MUSIC_DIR, "commercials");
ensureCommercials(voiceDJ, COMMERCIALS_DIR)
  .then(list => {
    djEngine.setCommercials(list);
    // Rebuild the current playlist so any already-loaded album picks up the ads
    if (djEngine.state.currentAlbum && djEngine.state.channel === 'dj') {
      djEngine.buildPlaylist(djEngine.state.currentAlbum);
      broadcastState();
    }
  })
  .catch(e => console.warn('[commercials] init failed:', e.message));

// DJ picks the opening set: start with Ghost Signals (album 1)
djEngine.buildPlaylist("Ghost Signals");

// Lazily rebuild Gifts for Humanity from kax artifacts (populates the album
// with real external URLs — won't affect startup if kax is unreachable).
djEngine.rebuildGiftsFromKax().catch(() => {});

const first = djEngine.getCurrentTrack();
if (first) {
  flux.publishTrackChange(first);
  perception_.hearTrack(first);
  syncManager.trackChanged(first.file);
  console.log(`\n\uD83C\uDFA7 Opening track: "${first.title}"`);
}

// Start sync heartbeat (broadcasts playback position every 10 s)
syncManager.start(broadcast, 10000);

// Start NATS connection for swarm data
nats.connect();

// ── Wire QueenSync events to DJ voice (KR-2) ──────────────
{
  const { generateSwarmEventIntro } = require("../consciousness-dj");

  nats.on('queen:join', (evt) => {
    const text = generateSwarmEventIntro('join', evt);
    if (text) voiceDJ.queueSwarmIntro(text);
  });

  nats.on('queen:leave', (evt) => {
    const text = generateSwarmEventIntro('leave', evt);
    if (text) voiceDJ.queueSwarmIntro(text);
  });

  nats.on('queen:dream:start', (evt) => {
    const text = generateSwarmEventIntro('dreamStart', evt);
    if (text) voiceDJ.queueSwarmIntro(text);
  });

  nats.on('queen:dream:end', (evt) => {
    const text = generateSwarmEventIntro('dreamEnd', evt);
    if (text) voiceDJ.queueSwarmIntro(text);
  });

  nats.on('queen:memory:shared', (evt) => {
    const text = generateSwarmEventIntro('memoryShared', evt);
    if (text) voiceDJ.queueSwarmIntro(text);
  });
}

// Start periodic Flux state broadcast
flux.startPeriodicPublish();

// ── Graceful shutdown ──────────────────────────────────────

function shutdown() {
  console.log("\n\uD83D\uDC7B Kannaka Radio shutting down...");
  perception_.stopPerceptionLoop();
  flux.stopPeriodicPublish();
  syncManager.stop();
  voteManager.cancelWindow();
  musicGen.stop();
  nats.disconnect();
  if (wss) wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Listen ─────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n\uD83D\uDC7B Kannaka Radio \u2014 Ghost Vision Edition`);
  console.log(`   Player:     http://localhost:${PORT}`);
  console.log(`   Music:      ${MUSIC_DIR}`);
  console.log(`   Setlist:    ${djEngine.state.currentAlbum} (${djEngine.state.playlist.length} tracks)`);
  console.log(`   Flux:       pure-jade/radio-now-playing`);
  console.log(`   NATS:       127.0.0.1:4222 (swarm data)`);
  console.log(`   WebSocket:  Real-time perception + swarm streaming`);
  console.log(`\n   \uD83C\uDFB5 Open the player in your browser and witness music through a ghost's eyes.\n`);
});
