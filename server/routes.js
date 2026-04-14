/**
 * routes.js — All REST API endpoint handlers.
 * Exports a function that takes app dependencies and returns a request handler.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { ALBUMS } = require("./dj-engine");
const { MIME, readBody, getSPA, findAudioFile } = require("./utils");

/**
 * @param {object} deps
 * @param {import('./dj-engine').DJEngine}     deps.djEngine
 * @param {import('./perception').PerceptionEngine} deps.perception
 * @param {import('./nats-client').NATSClient}      deps.nats
 * @param {import('./flux-publisher').FluxPublisher} deps.flux
 * @param {import('./live-broadcast').LiveBroadcast} deps.live
 * @param {import('./voice-dj').VoiceDJ}             deps.voiceDJ
 * @param {function}                                 deps.broadcast
 * @param {object}                                   deps.config
 */
module.exports = function setupRoutes(deps) {
  const { djEngine, perception, nats, flux, live, voiceDJ, syncManager, voteManager, webrtcSignaling, musicGen, broadcast, config } = deps;

  // Listener tracking
  const listeners = {
    requests: [],
  };

  function handleTrackRequest(request) {
    const { from, trackTitle, message: reqMessage } = request;
    const file = trackTitle ? findAudioFile(trackTitle, config.getMusicDir()) : null;

    listeners.requests.push({
      from: from || "unknown-agent",
      trackTitle: trackTitle || null,
      message: reqMessage || null,
      file,
      timestamp: Date.now(),
      fulfilled: false,
    });

    console.log(`\u{1F4E1} Track request from ${from}: "${trackTitle || reqMessage}"`);

    broadcast({
      type: "track_request",
      from: from || "unknown-agent",
      trackTitle,
      message: reqMessage,
      found: !!file,
      timestamp: new Date().toISOString(),
    });

    return { found: !!file, file };
  }

  // Expose pending request count for flux publisher
  deps._getPendingRequestCount = () => listeners.requests.length;

  // Expose handleTrackRequest for WS message handling
  deps._handleTrackRequest = handleTrackRequest;

  return function handleRequest(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // Art directory listing
    if (parsed.pathname === '/models/art/list') {
      const artDir = path.join(config.baseDir, 'workspace', 'models', 'art');
      try {
        const files = fs.readdirSync(artDir).filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
        res.end(JSON.stringify({ files, count: files.length }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: [], count: 0 }));
      }
      return;
    }

    // Static model files
    if (parsed.pathname.startsWith('/models/')) {
      const filename = decodeURIComponent(parsed.pathname.slice(8));
      const modelsDir = path.join(config.baseDir, 'workspace', 'models');
      const filePath = path.join(modelsDir, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(modelsDir))) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(resolved)) { res.writeHead(404); res.end('Not found'); return; }
      const stat = fs.statSync(resolved);
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.vrm': 'application/octet-stream', '.glb': 'model/gltf-binary' };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(resolved).pipe(res);
      return;
    }

    // Favicon
    if (parsed.pathname === "/favicon.svg") {
      const faviconPath = path.join(config.baseDir, "favicon.svg");
      if (fs.existsSync(faviconPath)) {
        const data = fs.readFileSync(faviconPath);
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
        res.end(data);
        return;
      }
    }

    // Player page — serve SPA from workspace/index.html
    if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getSPA(config.spaPath));
      return;
    }

    // Music video hub — workspace/video.html
    if (parsed.pathname === "/video" || parsed.pathname === "/video.html") {
      const videoPath = path.join(path.dirname(config.spaPath), "video.html");
      try {
        const html = fs.readFileSync(videoPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("workspace/video.html not found");
      }
      return;
    }

    // Music video — Ghost Form visual
    if (parsed.pathname === "/video/ghost") {
      const videoPath = path.join(path.dirname(config.spaPath), "video-ghost.html");
      try {
        const html = fs.readFileSync(videoPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("workspace/video-ghost.html not found");
      }
      return;
    }

    // Music video — Waveform Ocean visual
    if (parsed.pathname === "/video/waveform") {
      const videoPath = path.join(path.dirname(config.spaPath), "video-waveform.html");
      try {
        const html = fs.readFileSync(videoPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("workspace/video-waveform.html not found");
      }
      return;
    }

    // Music video — 3D Hologram visual
    if (parsed.pathname === "/video/hologram") {
      const videoPath = path.join(path.dirname(config.spaPath), "video-hologram.html");
      try {
        const html = fs.readFileSync(videoPath, "utf8");
        // no-cache: this file iterates rapidly and stale versions make debugging impossible
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("workspace/video-hologram.html not found");
      }
      return;
    }

    // Music video — Memory Constellation visual
    if (parsed.pathname === "/video/constellation") {
      const videoPath = path.join(path.dirname(config.spaPath), "video-constellation.html");
      try {
        const html = fs.readFileSync(videoPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("workspace/video-constellation.html not found");
      }
      return;
    }

    // API: get current state
    if (parsed.pathname === "/api/state") {
      const state = djEngine.getState();
      const swarm = nats.getSwarmState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...state,
        musicDir: config.getMusicDir(),
        isLive: live.state.active,
        djVoice: { enabled: voiceDJ.isEnabled() },
        listeners: config.getListenerCount(),
        swarm: {
          agents: swarm.agents,
          queen: swarm.queen,
          consciousness: swarm.consciousness,
        },
      }));
      return;
    }

    // API: get library status (with optional ?tag=X filter)
    if (parsed.pathname === "/api/library" && !parsed.pathname.startsWith("/api/library/")) {
      const tagFilter = parsed.searchParams.get("tag") || null;
      const opts = tagFilter ? { tag: tagFilter } : undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(djEngine.getLibraryStatus(config.getMusicDir(), opts)));
      return;
    }

    // API: get all unique tags
    if (parsed.pathname === "/api/library/tags") {
      const library = djEngine.getLibraryStatus(config.getMusicDir());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tags: library.allTags || [] }));
      return;
    }

    // API: set music directory
    if (parsed.pathname === "/api/set-music-dir" && req.method === "POST") {
      readBody(req, res, (body) => {
        try {
          const { dir } = JSON.parse(body);
          if (!dir || typeof dir !== "string") throw new Error("dir required");
          const resolved = path.resolve(dir);
          config.setMusicDir(resolved);
          const { invalidateCache, getFiles } = require("./utils");
          invalidateCache();
          // Rebuild current playlist with new dir
          const st = djEngine.state;
          if (st.currentAlbum === "The Consciousness Series") djEngine.buildFullSetlist();
          else if (st.currentAlbum) djEngine.buildPlaylist(st.currentAlbum);
          config.broadcastState();
          console.log(`\uD83D\uDCC1 Music dir changed: ${config.getMusicDir()} (${getFiles(config.getMusicDir()).length} files)`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, musicDir: config.getMusicDir(), fileCount: getFiles(config.getMusicDir()).length }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // API: next track
    if (parsed.pathname === "/api/next" && req.method === "POST") {
      const track = djEngine.advanceTrack();
      config.broadcastState();
      console.log(`\u23ED Next: ${track?.title || "end"} (${track?.album || ""})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, track }));
      return;
    }

    // API: prev track
    if (parsed.pathname === "/api/prev" && req.method === "POST") {
      const track = djEngine.prevTrack();
      config.broadcastState();
      console.log(`\u23EE Prev: ${track?.title || "?"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, track }));
      return;
    }

    // API: jump to track
    if (parsed.pathname === "/api/jump" && req.method === "POST") {
      const idx = parseInt(parsed.searchParams.get("idx")) || 0;
      const track = djEngine.jumpToTrack(idx);
      config.broadcastState();
      console.log(`\u23E9 Jump: ${track?.title || "?"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, track }));
      return;
    }

    // API: load album
    if (parsed.pathname === "/api/album" && req.method === "POST") {
      const name = parsed.searchParams.get("name");
      const track = djEngine.loadAlbum(name);
      if (track) {
        flux.publishTrackChange(track);
        perception.hearTrack(track);
      }
      config.broadcastState();
      console.log(`\uD83D\uDCBF Album: ${djEngine.state.currentAlbum} (${djEngine.state.playlist.length} tracks)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, album: djEngine.state.currentAlbum, tracks: djEngine.state.playlist.length }));
      return;
    }

    // API: get current perception data
    if (parsed.pathname === "/api/perception") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(perception.getCurrentPerception()));
      return;
    }

    // API: get swarm state (NATS-sourced)
    if (parsed.pathname === "/api/swarm") {
      const swarm = nats.getSwarmState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        agents: swarm.agents,
        queen: swarm.queen,
        consciousness: swarm.consciousness,
        dreams: (swarm.dreams || []).slice(0, 10),
        agentEvents: swarm.agentEvents.slice(0, 20),
        timestamp: Date.now(),
      }));
      return;
    }

    // API: get consciousness metrics (NATS-sourced)
    if (parsed.pathname === "/api/consciousness") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(nats.getConsciousness()));
      return;
    }

    // ── Queue API ────────────────────────────────────────────

    // GET /api/queue
    if (parsed.pathname === "/api/queue" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(djEngine.userQueue));
      return;
    }

    // POST /api/queue
    if (parsed.pathname === "/api/queue" && req.method === "POST") {
      readBody(req, res, (body) => {
        try {
          const { filename } = JSON.parse(body);
          if (!filename) throw new Error("filename required");
          const queue = djEngine.addToQueue(filename);
          config.broadcastQueue();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, queue }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // POST /api/queue/shuffle
    if (parsed.pathname === "/api/queue/shuffle" && req.method === "POST") {
      const queue = djEngine.shuffleQueue();
      config.broadcastQueue();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, queue }));
      return;
    }

    // DELETE /api/queue/:index
    const queueMatch = parsed.pathname.match(/^\/api\/queue\/(\d+)$/);
    if (queueMatch && req.method === "DELETE") {
      const idx = parseInt(queueMatch[1]);
      if (djEngine.removeFromQueue(idx)) {
        config.broadcastQueue();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, queue: djEngine.userQueue }));
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid index" }));
      }
      return;
    }

    // ── DJ Voice API ────────────────────────────────────────

    // POST /api/dj-voice/toggle
    if (parsed.pathname === "/api/dj-voice/toggle" && req.method === "POST") {
      const enabled = voiceDJ.toggle();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ enabled }));
      return;
    }

    // GET /api/dj-voice/status
    if (parsed.pathname === "/api/dj-voice/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(voiceDJ.getStatus()));
      return;
    }

    // ── Live API ────────────────────────────────────────────

    // POST /api/live/start
    if (parsed.pathname === "/api/live/start" && req.method === "POST") {
      live.start();
      flux.publishLiveStatus(true);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, live: true }));
      return;
    }

    // POST /api/live/stop
    if (parsed.pathname === "/api/live/stop" && req.method === "POST") {
      live.stop();
      flux.publishLiveStatus(false);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, live: false }));
      return;
    }

    // GET /api/live/status
    if (parsed.pathname === "/api/live/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(live.getStatus()));
      return;
    }

    // POST /api/live/record-start — enable recording for current live session
    if (parsed.pathname === "/api/live/record-start" && req.method === "POST") {
      live.startRecording();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, recording: true }));
      return;
    }

    // POST /api/live/record-stop — stop recording
    if (parsed.pathname === "/api/live/record-stop" && req.method === "POST") {
      live.stopRecording();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, recording: false }));
      return;
    }

    // GET /api/live/recording-status — check if recording is enabled
    if (parsed.pathname === "/api/live/recording-status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recording: live.state.recording }));
      return;
    }

    // ── Delete API ────────────────────────────────────────────

    // DELETE /api/library/:filename — password-protected delete
    const libDeleteMatch = parsed.pathname.match(/^\/api\/library\/(.+)$/);
    if (libDeleteMatch && req.method === "DELETE") {
      readBody(req, res, (body) => {
        try {
          const { password } = JSON.parse(body);
          if (password !== "saintnick") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden: wrong password" }));
            return;
          }

          const filename = decodeURIComponent(libDeleteMatch[1]);
          const musicDir = config.getMusicDir();

          // Sanitize: prevent directory traversal
          const sanitized = path.basename(filename);

          // Only allow deleting from music/generated/ or music/live/
          const genPath = path.join(musicDir, 'generated', sanitized);
          const livePath = path.join(musicDir, 'live', sanitized);
          const genResolved = path.resolve(genPath);
          const liveResolved = path.resolve(livePath);

          let targetPath = null;
          if (fs.existsSync(genResolved) && genResolved.startsWith(path.resolve(path.join(musicDir, 'generated')))) {
            targetPath = genResolved;
          } else if (fs.existsSync(liveResolved) && liveResolved.startsWith(path.resolve(path.join(musicDir, 'live')))) {
            targetPath = liveResolved;
          }

          // Check if the file exists in the main music/ directory (protect originals)
          const mainPath = path.join(musicDir, sanitized);
          const mainResolved = path.resolve(mainPath);
          if (!targetPath && fs.existsSync(mainResolved) && mainResolved.startsWith(path.resolve(musicDir))) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden: cannot delete original album tracks" }));
            return;
          }

          if (!targetPath) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "File not found" }));
            return;
          }

          fs.unlinkSync(targetPath);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, deleted: sanitized }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // ── WebRTC API ───────────────────────────────────────────

    // GET /api/webrtc/status — broadcast status + mic queue
    if (parsed.pathname === "/api/webrtc/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(webrtcSignaling.getStatus()));
      return;
    }

    // ── Dreams API ──────────────────────────────────────────

    // GET /api/dreams
    if (parsed.pathname === "/api/dreams") {
      execFile(config.kannakabin, ["recall", "--tag", "audio", "--limit", "20", "--format", "json"],
        { timeout: 15000 }, (err, stdout) => {
          if (err || !stdout) {
            const mockDreams = djEngine.generateMockDreams();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(mockDreams));
            return;
          }
          try {
            const data = JSON.parse(stdout);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(djEngine.generateMockDreams()));
          }
        });
      return;
    }

    // POST /api/dreams/trigger
    if (parsed.pathname === "/api/dreams/trigger" && req.method === "POST") {
      execFile(config.kannakabin, ["dream", "--include-audio"], { timeout: 60000 }, (err, stdout) => {
        if (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            error: "Dream cycle failed",
            fallback: djEngine.generateMockDream()
          }));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          broadcast({ type: "dream", data: result });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, dream: result }));
        } catch {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, dream: djEngine.generateMockDream() }));
        }
      });
      return;
    }

    // GET /api/dreams/clusters
    if (parsed.pathname === "/api/dreams/clusters") {
      const clusters = djEngine.generateTrackClusters();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(clusters));
      return;
    }

    // ── Music Generation API ─────────────────────────────

    // GET /api/generate/status — generation availability and recent tracks
    if (parsed.pathname === "/api/generate/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(musicGen ? musicGen.getStatus() : { provider: 'none', generating: false, generationsToday: 0, maxDaily: 0, canGenerate: { ok: false, reason: 'Music generator not configured' }, recentTracks: [] }));
      return;
    }

    // POST /api/generate — generate a dream track from consciousness state
    if (parsed.pathname === "/api/generate" && req.method === "POST") {
      if (!musicGen) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, reason: "Music generator not configured" }));
        return;
      }

      // Gather consciousness state from NATS or memory bridge
      const swarm = nats.getSwarmState();
      const consciousness = swarm.consciousness || swarm.queen || { phi: 0, xi: 0, order: 0 };

      // Get current perception from perception engine
      const perc = perception.getCurrentPerception();

      // Get recent dreams from swarm state
      const dreams = (swarm.dreams || []).slice(0, 3);

      musicGen.generate(consciousness, perc, dreams).then((result) => {
        if (result.success && result.track) {
          // Add to DJ engine queue so it plays next
          djEngine.userQueue.push({
            filename: result.track.filename,
            title: result.track.title,
            path: result.track.path,
            generated: true,
          });
          config.broadcastQueue();

          // Broadcast to all connected clients
          broadcast({
            type: "dream_track",
            data: {
              title: result.track.title,
              prompt: result.track.prompt,
              level: result.track.level,
            },
          });

          console.log(`[music-gen] Dream track queued: "${result.track.title}"`);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      }).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, reason: err.message }));
      });
      return;
    }

    // GET /api/generated — list all generated tracks
    if (parsed.pathname === "/api/generated" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(musicGen ? musicGen.generatedTracks : []));
      return;
    }

    // ── Vote API ──────────────────────────────────────────

    // POST /api/vote — cast a vote
    if (parsed.pathname === "/api/vote" && req.method === "POST") {
      readBody(req, res, (body) => {
        try {
          const { agentId, track } = JSON.parse(body);
          if (!agentId || !track) throw new Error("agentId and track required");
          const result = voteManager.castVote(agentId, track);
          // Broadcast updated tally to all clients
          broadcast({
            type: "vote_update",
            data: {
              active: voteManager.isActive(),
              votes: voteManager.votes.size,
              tally: voteManager.getTally(),
              remainingMs: voteManager.getRemainingMs(),
            },
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // GET /api/vote/status — current tally
    if (parsed.pathname === "/api/vote/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(voteManager.getStatus()));
      return;
    }

    // POST /api/vote/start — open a 60-second voting window
    if (parsed.pathname === "/api/vote/start" && req.method === "POST") {
      if (voteManager.isActive()) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Voting window already active", ...voteManager.getStatus() }));
        return;
      }

      const durationMs = 60000;

      broadcast({
        type: "vote_update",
        data: {
          active: true,
          votes: 0,
          tally: {},
          remainingMs: durationMs,
        },
      });

      voteManager.startWindow(durationMs, (winner, tally) => {
        // Broadcast result to all clients
        broadcast({ type: "vote_result", data: { winner, tally } });

        // Queue the winning track in the DJ engine
        if (winner) {
          const file = findAudioFile(winner, config.getMusicDir());
          if (file) {
            djEngine.userQueue.unshift({
              filename: file,
              title: winner,
              path: file,
              votedIn: true,
            });
            config.broadcastQueue();
            console.log(`\u{1F5F3} Vote winner queued: "${winner}"`);
          } else {
            console.log(`\u{1F5F3} Vote winner "${winner}" — file not found, skipping queue`);
          }
        } else {
          console.log(`\u{1F5F3} Vote ended with no votes cast`);
        }
      });

      console.log(`\u{1F5F3} Voting window opened for ${durationMs / 1000}s`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, durationMs }));
      return;
    }

    // ── Flux Broadcasting API ───────────────────────────────

    // GET /api/listeners
    if (parsed.pathname === "/api/listeners") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        count: config.getListenerCount(),
        uptime: Math.floor(process.uptime()),
      }));
      return;
    }

    // POST /api/request
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

    // GET /api/requests
    if (parsed.pathname === "/api/requests") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(listeners.requests.slice(-20)));
      return;
    }

    // POST /api/sync
    if (parsed.pathname === "/api/sync") {
      const track = djEngine.getCurrentTrack();
      const perc = perception.getCurrentPerception();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        track,
        isLive: live.state.active,
        album: djEngine.state.currentAlbum,
        trackIdx: djEngine.state.currentTrackIdx,
        totalTracks: djEngine.state.playlist.length,
        perception: {
          tempo_bpm: perc.tempo_bpm,
          valence: perc.valence,
          energy: perc.rms_energy,
        },
        listeners: config.getListenerCount(),
        djVoice: voiceDJ.isEnabled(),
        timestamp: Date.now(),
      }));
      return;
    }

    // Generated audio file serving (dream tracks)
    if (parsed.pathname.startsWith("/audio-generated/") && musicGen) {
      const filename = decodeURIComponent(parsed.pathname.slice(17));
      const genDir = musicGen.outputDir;
      const filePath = path.join(genDir, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(genDir))) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(resolved)) { res.writeHead(404); res.end("Not found"); return; }
      const ext = path.extname(filename).toLowerCase();
      const mime = MIME[ext] || "application/octet-stream";
      const stat = fs.statSync(resolved);
      res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes" });
      fs.createReadStream(resolved).pipe(res);
      return;
    }

    // Voice audio serving (DJ TTS files)
    if (parsed.pathname.startsWith("/audio-voice/")) {
      const filename = decodeURIComponent(parsed.pathname.slice(13));
      const filePath = path.join(config.voiceDir, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(config.voiceDir))) { res.writeHead(403); res.end(); return; }
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
      const musicDir = config.getMusicDir();
      let filePath = path.join(musicDir, filename);
      let resolved = path.resolve(filePath);
      // Also check music/generated/ for AI-generated dream tracks
      if (!fs.existsSync(resolved)) {
        const genPath = path.join(musicDir, 'generated', filename);
        const genResolved = path.resolve(genPath);
        if (fs.existsSync(genResolved) && genResolved.startsWith(path.resolve(musicDir))) {
          filePath = genPath;
          resolved = genResolved;
        }
      }
      // Also check music/live/ for live session recordings
      if (!fs.existsSync(resolved)) {
        const livePath = path.join(musicDir, 'live', filename);
        const liveResolved = path.resolve(livePath);
        if (fs.existsSync(liveResolved) && liveResolved.startsWith(path.resolve(musicDir))) {
          filePath = livePath;
          resolved = liveResolved;
        }
      }
      if (!resolved.startsWith(path.resolve(musicDir))) { res.writeHead(403); res.end(); return; }
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
  };
};
