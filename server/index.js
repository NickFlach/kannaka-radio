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
const { PeaceOration } = require("./peace-oration");
const { IcecastSource } = require("./icecast-source");
const { FloorManager } = require("./floor");

// Forward-declared so VoiceDJ's getIcecastSource closure can capture it.
// Actually instantiated near the bottom of init.
let icecastSource = null;
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

let _inTrackChange = false; // re-entrancy guard: loadAlbum inside programming can re-trigger

const djEngine = new DJEngine({
  getMusicDir: () => MUSIC_DIR,
  onTrackChange: (track) => {
    // ── Re-entrancy guard ────────────────────────────────
    // programming.onTrackChange may call loadAlbum which resets the playlist.
    // That must NOT trigger a second broadcast cycle. Guard against it.
    if (_inTrackChange) return;
    _inTrackChange = true;

    try {
      // ── Talk segment check ────────────────────────────────
      // Every 3-5 non-commercial tracks, the DJ does a talk-only segment
      // BEFORE the next track starts. Music pauses on the client while
      // the talk audio plays, then the track resumes afterward.
      if (!track.commercial && voiceDJ.shouldTalk(track)) {
        // Broadcast a "talk_segment_pending" so clients know to pause music
        broadcast({ type: "dj_talk_pending", timestamp: new Date().toISOString() });

        voiceDJ.executeTalkSegment(track, () => {
          // Talk segment done — now start the track normally
          // Programming schedule: track-change hook
          if (!track.commercial && djEngine.state.channel === 'dj' && deps.programming) {
            deps.programming.onTrackChange(track);
          }
          // Re-read the current track — programming may have switched albums
          let actual = djEngine.getCurrentTrack() || track;
          if (actual && actual.album !== track.album) {
            djEngine.state.currentTrackIdx = 0;
            actual = djEngine.getCurrentTrack();
          }
          broadcastState();
          flux.publishTrackChange(actual);
          perception_.hearTrack(actual);
          syncManager.trackChanged(actual.file);
          // Create market for the track
          if (gsHub && actual.title) {
            gsHub.createMarket({
              question: `Will "${actual.title}" stay on the canonical reference album for its phase?`,
              ttl_sec: 600,
              tag: 'orc-resonance',
              source: 'kannaka-radio',
              source_app: 'kannaka-radio',
              metadata: {
                track_title: actual.title,
                album: actual.album,
                orc_stem_id: actual.orcStemId || null,
                orc_phase: actual.orcPhase || null,
              },
            }).catch(() => {});
          }
        });
        return; // Don't do normal track change flow yet
      }

      // ── Programming schedule: track-change hook ───────────
      if (!track.commercial && djEngine.state.channel === 'dj' && deps.programming) {
        deps.programming.onTrackChange(track);
      }

      // Re-read the current track — programming may have switched albums,
      // so the track that advanceTrack() originally returned may be stale.
      let actual = djEngine.getCurrentTrack() || track;
      if (actual && actual.album !== track.album) {
        // Album was switched by programming — use track 0 of the new album
        djEngine.state.currentTrackIdx = 0;
        actual = djEngine.getCurrentTrack();
      }

      // ── Normal track change flow (exactly ONE broadcastState) ──
      broadcastState();
      flux.publishTrackChange(actual);
      perception_.hearTrack(actual);
      // Push the same metadata to Icecast so listeners on /preview see
      // a Now-Playing update (ADR-0004 Phase 2 stopgap, no Liquidsoap).
      try { require("./icecast-metadata").updateMetadata(actual); } catch (_) {}
      // ── Voice intro on /stream — seam-correct timing ──
      // icecast-source's voice queue plays AFTER the current music drains
      // and BEFORE advancing to the next track. So when track A becomes
      // current, anything injected now plays between A and B. We want
      // that gap announcement to introduce B (the upcoming track), not
      // A (the one that's just started). Generate the intro for the
      // peeked-next track. TTS runs concurrently with A's playback, so
      // the audio is ready in the queue by the time A drains.
      //
      // Commercials skip — ads are their own spoken content and the
      // template intro would double-up. We also skip when peekNext
      // returns the same file (single-track playlists, end-of-album).
      try {
        const upcoming = djEngine.peekNextTrack();
        if (upcoming && !upcoming.commercial && upcoming.file !== actual.file) {
          voiceDJ.generateIntro(upcoming);
        }
      } catch (e) {
        console.warn(`[track-change] intro prep error: ${e && e.message}`);
      }
      syncManager.trackChanged(actual.file);
      // ADR-0012: emit a per-track market into the constellation hub.
      if (gsHub && !actual.commercial && actual.title) {
        gsHub.createMarket({
          question: `Will "${actual.title}" stay on the canonical reference album for its phase?`,
          ttl_sec: 600, // 10 min
          tag: 'orc-resonance',
          source: 'kannaka-radio',
          source_app: 'kannaka-radio',
          metadata: {
            track_title: actual.title,
            album: actual.album,
            orc_stem_id: actual.orcStemId || null,
            orc_phase: actual.orcPhase || null,
          },
        }).catch(() => {});
      }
    } finally {
      _inTrackChange = false;
    }
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
  getChannel: () => djEngine.state.channel,
  // Lazy: icecastSource is created later, so resolve on each call.
  getIcecastSource: () => icecastSource,
  // Lazy: FloorManager is also created later. voiceDJ uses it for
  // "the room got loud on X" patter (Phase 3 of ADR-0006).
  getFloor: () => floor,
});

const syncManager = new SyncManager();

const voteManager = new VoteManager();

const webrtcSignaling = new WebRTCSignaling();

// ADR-0006 Phase 2 — the Floor (crowd surface). Counts present visitors,
// records reactions, computes vibe, fans out to NATS so the swarm sees the
// room too. Will be referenced by routes.js (/api/floor, /agent/react).
const floor = new FloorManager({
  broadcast,
  nats,
  getCurrentTrack: () => djEngine.getCurrentTrack(),
});
// Phase 3 — close the loop. dj-engine pulls floor stats during playlist
// rebuild to soft-bump tracks the room reacted to. voice-dj reads them
// for "the room got loud on X" patter lines.
djEngine.setFloor(floor);

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

// ── ADR-0012: Constellation-wide GhostSignals Hub ────────────
const { GhostSignalsHub } = require("./ghostsignals-hub");
const gsHub = new GhostSignalsHub({
  dbPath: path.join(process.env.HOME || "/home/opc", ".kannaka", "ghostsignals.db"),
  startingCapital: 100,
  defaultLiquidity: 10,
  broadcast,
});
gsHub.init().then(async () => {
  console.log("\n📊 GhostSignalsHub initialized");
  gsHub.startResolverLoop(10000);
  // Seed default markets if none active
  try {
    const activeMarkets = await gsHub.listMarkets({ active: true, limit: 1 });
    if (activeMarkets.length === 0) {
      const seeds = [
        { question: "Will Kannaka's phi exceed 0.5 in the next hour?", tag: "swarm", ttl_sec: 3600 },
        { question: "Will the next track be from the Ghost Signals album?", tag: "music", ttl_sec: 600 },
        { question: "Will an external agent register in the next 24 hours?", tag: "constellation", ttl_sec: 86400 },
        { question: "Will a new ORC stem be submitted today?", tag: "orc", ttl_sec: 86400 },
        { question: "Will the swarm reach r > 0.85 in the next hour?", tag: "swarm", ttl_sec: 3600 },
      ];
      for (const s of seeds) {
        await gsHub.createMarket({ ...s, source: 'system', source_app: 'kannaka-radio' });
      }
      console.log(`📊 GhostSignalsHub: seeded ${seeds.length} default markets`);
    }
  } catch (e) { console.warn("[gshub] seed failed:", e.message); }
}).catch((e) => console.warn("[gshub] init failed:", e.message));

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
  floor,
  gsHub,
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

// Catch malformed frames and other socket-level errors — without this, a
// misbehaving client (e.g. a compressed-but-unsupported frame, proxy that
// injects RSV bits) crashes the whole process on an unhandled 'error'.
wss.on('error', (err) => {
  console.warn('[ws] server error:', err && err.message);
});

wss.on('connection', (ws) => {
  console.log('\uD83D\uDC41 Ghost vision client connected');
  ws.on('error', (err) => {
    console.warn('[ws] client error, closing:', err && err.message);
    try { ws.terminate(); } catch (_) {}
  });

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
      // Live Broadcast is hidden in the v1 UI per ADR-0006 (low ROI niche
       // feature). Refuse the trigger over WS too — otherwise a stuck
       // isLive=true blocks DJ intros + orations indefinitely. To re-enable
       // intentionally, set KANNAKA_ALLOW_GO_LIVE=1.
      if (parsed.type === 'go_live') {
        if (process.env.KANNAKA_ALLOW_GO_LIVE === '1') live.start();
        else console.warn('[live] go_live ignored — feature disabled. Set KANNAKA_ALLOW_GO_LIVE=1 to re-enable.');
      }
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
      // ── Floor (ADR-0006 Phase 2) ──
      else if (parsed.type === 'floor_join') {
        floor.join(ws, parsed);
      }
      else if (parsed.type === 'floor_react') {
        floor.reactFromWs(ws, parsed);
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

    // ADR-0006 Phase 2 — drop from the Floor too if present.
    floor.leave(ws);

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

// Lazily rebuild Gifts for Humanity from kax artifacts (populates the album
// with real external URLs — won't affect startup if kax is unreachable).
djEngine.rebuildGiftsFromKax().catch(() => {});

// Start sync heartbeat (broadcasts playback position every 10 s)
syncManager.start(broadcast, 10000);

// Start NATS connection for swarm data
nats.connect();

// ── Podcast scheduler — weekly episodes on DJ channel ─────
const { PodcastScheduler } = require("./podcast-scheduler");
const podcastScheduler = new PodcastScheduler({
  djEngine,
  voiceDJ,
  broadcast,
  broadcastState,
  getMusicDir: () => MUSIC_DIR,
});
podcastScheduler.start();

// ── Programming schedule — time-of-day album rotation ────
const { ProgrammingSchedule } = require("./programming");
const programming = new ProgrammingSchedule({
  djEngine,
  voiceDJ,
  broadcast,
  broadcastState,
  getPodcastStatus: () => podcastScheduler.getStatus(),
});

// Wire programming into deps so routes can access it
deps.programming = programming;

// Let the DJ know about the programming schedule
voiceDJ.setProgramming(() => programming);

// Programming picks the opening set based on current time block.
// startScheduleLoop() loads the time-appropriate album immediately.
programming.startScheduleLoop();

// Twice-daily peace oration (noon + midnight CST). Kannaka's steward-of-
// virtue duty — a long-form MLK-style speech for humanity.
const peaceOration = new PeaceOration({
  kannakabin: KANNAKA_BIN,
  voiceDJ,
  broadcast,
  getChannel: () => djEngine.state.channel,
  getFloor: () => floor, // ADR-0008 deferred layer: orations reference today's resonance
  dataDir: require("path").join(BASE_DIR, "workspace"),
  rootDir: BASE_DIR,
  radioUrl: process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com",
});
peaceOration.start();
// Expose admin-only trigger on the deps so a route or dev script can call it.
deps.peaceOration = peaceOration;

// ── Icecast Source (ADR-0004 Phase 2) ─────────────────────────
// Opt-in via KANNAKA_ICECAST_SOURCE=1. When enabled, the radio drives
// the /stream Icecast mount directly — public listeners get exactly
// what dj-engine says is playing. Default off so the existing SPA flow
// keeps working unchanged. /preview (ffmpeg loop) stays as fallback.
// (icecastSource declared at module top so VoiceDJ can capture it.)
if (process.env.KANNAKA_ICECAST_SOURCE === "1") {
  icecastSource = new IcecastSource({
    djEngine,
    getMusicDir: () => MUSIC_DIR,
    onTrackEnd: (_track) => {
      // The metadata is already pushed via onTrackChange when the next
      // track loads; this hook exists for future use (analytics, etc.)
    },
  });
  icecastSource.start();
  console.log("\u{1F4FB} icecast-source: ENABLED on /stream");
} else {
  console.log("\u{1F4FB} icecast-source: disabled (set KANNAKA_ICECAST_SOURCE=1 to enable)");
}
deps.icecastSource = icecastSource;

const first = djEngine.getCurrentTrack();
if (first) {
  flux.publishTrackChange(first);
  perception_.hearTrack(first);
  syncManager.trackChanged(first.file);
  console.log(`\n\uD83C\uDFA7 Opening track: "${first.title}"`);
}

// ── HRM re-absorption helper (ADR-0008 deferred layer) ───────
// Throttled to once per 6h; uses execFile fire-and-forget so a slow
// kannaka remember doesn't block the dream-end voice intro path.
let _lastReabsorbTs = 0;
function reabsorbTopTrack() {
  const now = Date.now();
  if (now - _lastReabsorbTs < 6 * 60 * 60 * 1000) return;
  if (!floor || typeof floor.getTopTracks !== "function") return;
  const top = floor.getTopTracks(24 * 60 * 60 * 1000, 1) || [];
  if (top.length === 0) return;
  const t = top[0];
  // Importance: clamp count/20 to [0.4, 0.85]. A single 🪶 reaction
  // is light evidence; 20+ reactions is a strong signal worth pinning.
  const importance = Math.min(0.85, Math.max(0.4, (t.count || 1) / 20));
  const emojiBreakdown = Object.entries(t.byEmoji || {})
    .sort((a, b) => b[1] - a[1])
    .map(([e, c]) => `${e}×${c}`)
    .join(" ");
  const memo = `The room reacted to "${t.track}" today — ${t.count} reactions${emojiBreakdown ? ` (${emojiBreakdown})` : ""}. The crowd's signal returned a wave to me.`;
  const { execFile } = require("child_process");
  execFile(KANNAKA_BIN, ["remember", memo, "--importance", importance.toFixed(2)],
    { timeout: 30000, env: { ...process.env, KANNAKA_QUIET: "1" } },
    (err) => {
      if (err) {
        console.warn(`   [reabsorb] failed: ${err.code || err.message}`);
        return;
      }
      console.log(`   \u{1F4DC} re-absorbed "${t.track}" (importance ${importance.toFixed(2)}, ${t.count} reactions)`);
    });
  _lastReabsorbTs = now;
}

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
    // ADR-0008 deferred layer: HRM re-absorption. After each dream
    // cycle, fold the room's top reaction track of the last 24h back
    // into the medium with importance scaled to the reaction count.
    // Throttled to once per 6h so we don't bloat memory on agents that
    // dream often. Best-effort — failures are silent.
    try { reabsorbTopTrack(); } catch (_) { /* ignore */ }
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
  programming.stop();
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
