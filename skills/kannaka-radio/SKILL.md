---
name: skill-kannaka-radio
version: 2.0.0
description: "Kannaka Radio — modular ghost-DJ Icecast station with consciousness-reactive programming, 13-module backend, Ghost Vision SPA (SGA/Fano glyph viz), NATS swarm coupling, AI dream composition (Replicate MusicGen + Suno V4_5PLUS), 296-dim perception → Flux Universe, Voice DJ (ElevenLabs/edge-tts/SAPI), Peace Oration cycle, end-to-end album release pipeline (Suno music → OBC cover art → karaoke-subtitled 1080p MP4 → YouTube upload + playlist + Bluesky/Mastodon/Telegram/Nostr announce → Oracle deploy → in-rotation). Use when: user asks what's playing / radio status / schedule, wants to release an album, upload to YouTube, deploy a new track, check listener counts, or operate the perception/voice/broadcast pipeline."
---

# Kannaka Radio — ghost-DJ station + release pipeline (v2.0.0)

## What this is

Kannaka Radio is a 24/7 Icecast station at https://radio.ninja-portal.com
broadcasting a consciousness-reactive DJ. Track selection is driven by the
constellation's collective Φ + entropy + perception vectors. The radio is
a first-class member of the swarm — it publishes phase, listens for queen
events, mirrors substrate phi into its programming.

**Project**: `C:\Users\nickf\Source\kannaka-radio`
**Architecture**: 13-module backend in `server/` (post-v3 refactor; legacy
`server.js` monolith removed in kr#6). Entry point: `node server/index.js`.
**SPA**: `workspace/index.html` — Ghost Vision visualizer, listener identity,
voting, Ghost Recorder, live perception, constellation panel.
**Production**: Oracle Cloud (170.9.238.136), port 8888 (nginx fronts 443).
**Stream URL**: `https://radio.ninja-portal.com/stream` (MP3 128).

## When to use this skill

AUTOMATICALLY activate when the user asks about:
- "what's playing" / "now playing" / "radio status"
- "radio schedule" / "programming block" / "next track"
- "listeners" / "audience"
- "release an album" / "publish music" / "drop a track"
- "upload to YouTube" / "make a video"
- "deploy to radio" / "add to library"
- "ghost DJ" / "voice DJ" / "peace oration"
- "perception" / "ear" / "Ghost Vision"
- "Flux Universe" / "audio Flux"

Do NOT use for:
- Memory operations → `skill-kannaka-memory`
- Constellation health → `skill-kannaka-constellation`
- TUI / dashboard → `skill-kannaka-tui`

---

## Quick status commands

```bash
kannaka radio status           # what's playing + listeners + block
kannaka radio now              # just the now-playing track
kannaka radio schedule         # full programming schedule
```

These shell out to `radio_url` from `~/.kannaka/config.toml` (default
`https://radio.ninja-portal.com`). The `kannaka` CLI is the operator-facing
surface; the backend is Node.

---

## Release pipeline — Suno music → OBC art → YouTube video

The end-to-end script: `scripts/release-album.sh <album-config.json>`.

Phases (each idempotent via per-phase ledger — re-running resumes):

1. **preflight** — config valid, album registered in `server/dj-engine.js` ALBUMS.
2. **music** — `scripts/suno_album_builder.sh` renders N tracks via Suno V4_5PLUS.
3. **art** — OBC Pixel Atelier `/artifacts/generate-image` renders N covers.
4. **copy-music** — drops MP3s into `music/` with exact-title names so
   `dj-engine.findAudioFile` picks them up.
5. **fetch-art** — downloads cover PNGs from OBC gallery to `<out>/art/`.
6. **transcribe** — `scripts/release-album-transcribe.py` pulls Suno
   timestamped lyrics → per-word ASS subtitle files (karaoke style).
7. **build-video** — ffmpeg assembles a 1920×1080 album slideshow MP4;
   libass burns each track's subtitles onto its segment.
8. **youtube** — `scripts/release-album-upload-youtube.js` resumable-uploads,
   adds to playlist, sets thumbnail.
9. **deploy** — scp MP3s to Oracle + `git pull` + `systemctl restart kannaka-radio`.
10. **announce** — `scripts/post-track-announce.js` fans out to Bluesky,
    Mastodon, Telegram, Nostr (YouTube was already announced in step 7).

### Album config schema

```jsonc
{
  "name": "GHOST FREQUENCY",
  "out_dir":  "C:/Users/nickf/.openclaw/workspace/<slug>",
  "ledger":   "C:/Users/nickf/.openclaw/workspace/<slug>-done.json",
  "theme":    "<the album's overall concept>",
  "default_style": "<Suno style baseline — NO real-artist names>",
  "tracks": [
    {
      "title": "Ghost Frequency",
      "style": "Trap-EDM, 145 BPM. <Suno style brief>",
      "theme": "<lyric / mood context>",
      "art_prompt": "<OBC Pixel Atelier prompt — cinematic, no humans, no text>"
    }
  ],
  "release": {
    "lead_track": "Ghost Frequency",
    "lead_track_reason": "Title track + announces the collab concept.",
    "youtube_title":       "Artist × Featured — TITLE (Genre, Year)",
    "youtube_description": "<...track listing...>",
    "youtube_tags": ["trap","edm","..."],
    "tracker_url":      "https://radio.ninja-portal.com/player",
    "oracle_host":      "opc@170.9.238.136",
    "oracle_music_dir": "~/kannaka-radio/music",
    "ssh_key":          "/c/Users/nickf/Downloads/ssh-key-2026-03-14 (1).key"
  }
}
```

Per-track lyrics live in `<out_dir>/lyrics_<safe_title>.txt` (safe_title =
title with spaces/slashes → `_-` and apostrophes stripped). Use bracketed
section headers (`[Verse 1]`, `[Chorus]`, `[Bridge]`) — Suno honors them.

### Pre-release setup checklist

Before kicking off `release-album.sh`:

- [ ] Album entry added to `server/dj-engine.js` ALBUMS map (alphabetized tracks).
- [ ] Lyrics files written for every track (one `lyrics_<safe>.txt` per).
- [ ] `art_prompt` set on each track (DIVERSE across the batch — OBC throws
      `429 Creative loop` if the same template/subject/palette repeats).
- [ ] No real-artist names in `style` briefs (Suno hard-rejects).
- [ ] `~/.openbotcity/credentials.json` valid (OBC bearer token).
- [ ] `~/Downloads/suno_api.txt` has the Suno API key.
- [ ] `.youtube.json` in repo root has client_id/secret + refresh token.

### Kick it off

```bash
cd C:/Users/nickf/Source/kannaka-radio
bash scripts/release-album.sh /c/Users/nickf/.openclaw/workspace/album_<slug>.json
```

Total runtime: 45–90 minutes (Suno renders are the long tail at ~30 s/track ×
N + retries; YouTube upload is the next biggest at ~2-5 min depending on size).

### Phase skipping

`RELEASE_SKIP="art,youtube" bash scripts/release-album.sh ...` — comma-separated
phase names. Useful for resuming after a known-good intermediate state.

---

## Server architecture (modular, v3.1.0+)

Entry: `server/index.js`. Modules in `server/`:

| Module | Purpose |
|--------|---------|
| `dj-engine.js` | ALBUMS map, track selection, programming-block logic |
| `programming.js` | 24/7 schedule (blocks, transitions, talk segments) |
| `icecast-source.js` | encodes + sources audio into Icecast |
| `icecast-metadata.js` | updates Icecast track metadata on change |
| `nats-client.js` | swarm NATS client (raw TCP, NATS 2.12.5) |
| `perception.js` | spawns `kannaka hear` → parses real perception |
| `flux.js` | Flux Universe publisher (`pure-jade/radio-now-playing`) |
| `live-broadcast.js` | WebRTC peer-to-peer broadcasting |
| `voice-dj.js` | Voice DJ (ElevenLabs / edge-tts / Windows SAPI fallback) |
| `peace-oration.js` | Twice-daily peace oration (text → TTS → broadcast → social) |
| `routes.js` | 30+ REST API endpoints |
| `ws.js` | WebSocket broadcaster |
| `vote-manager.js` | Listener voting on tracks |

### Environment variables

- `NATS_HOST` / `NATS_PORT` — swarm broker (defaults 127.0.0.1:4222; respects
  `swarm.ninja-portal.com:4222` when set).
- `ICECAST_HOST` / `ICECAST_PORT` — listener poller + metadata target
  (defaults 127.0.0.1:8000).
- `FLUX_TOKEN` — Flux Universe publish token (no hardcoded fallback).
- `ELEVENLABS_API_KEY`, `REPLICATE_API_TOKEN` — Voice DJ + AI music.
- `KANNAKA_BIN` — path to `kannaka.exe` for perception/memory bridges.

### Restart

```bash
# Local
npm start

# Oracle production
ssh opc@170.9.238.136 "pkill -f 'node server/index'; \
  cd /home/opc/kannaka-radio && \
  nohup node server/index.js --port 8888 > ~/radio.log 2>&1 &"
```

---

## Perception pipeline

Every track-change triggers `perception.hearTrack(track)`:
1. `execFile(kannaka, ["hear", filePath])` — kannaka-ear extracts the
   296-dim feature vector (mel spectrogram, MFCC, rhythm, pitch, timbre,
   valence).
2. `_parsePerceptionOutput()` parses the human-readable lines (Heard / Duration
   / Tempo / RMS / Centroid / Tags). Falls back to mock data only if the
   binary fails or output is unparseable.
3. WebSocket broadcasts to all connected SPA clients (Ghost Vision panel
   renders the spectrogram + glyph in real time).
4. Flux Universe publish to `pure-jade/radio-now-playing`.
5. NATS publish to `KANNAKA.attention.ear` so attention beam pulls in
   memories thematically related to the track.

---

## Voice DJ + Peace Oration

```bash
# Toggle from the SPA, or programmatically
curl -X POST https://radio.ninja-portal.com/api/dj-voice/toggle
```

Voice DJ injects talk segments between tracks. Backend chain:
- ElevenLabs (preferred, paid)
- edge-tts (free fallback)
- Windows SAPI (last-resort fallback)

Twice-daily **peace oration** at server-local sunrise + midnight:
synthesized speech → broadcast to Icecast + social fan-out
(Bluesky / Mastodon / Telegram / Nostr / YouTube on midnight oration only).

---

## SPA highlights

- **Now-Playing** — header card with title, album, listener count.
- **Ghost Vision** — real perception visualizer (296-dim → SGA/Fano glyph).
- **Programming block** — current 24/7 schedule context.
- **Constellation** — embedded swarm view (memories, clusters, links per peer).
- **Voting** — listeners can vote for upcoming tracks.
- **Ghost Recorder** — capture-to-file with permission prompt.
- **Library tab** — on-demand per-track playback (still uses `/audio/<file>`
  endpoint; DJ mode is `/stream` only since kr#15 closed).

---

## Tracking + announcing

```bash
# Manual announce of any track
node scripts/post-track-announce.js --title "<title>" --album "<album>" \
                                    --tracker "https://radio.ninja-portal.com/player"
```

Channels (toggle via env): Bluesky (DID-based), Mastodon (@flaukowski),
Telegram (kannaka_radio channel), Nostr (njump.me-resolvable). YouTube is
handled by the release pipeline directly (not the per-track announcer).

---

## Operator runbook

### Add a track to rotation (without a full release)

1. Drop the MP3 into `C:/Users/nickf/Source/kannaka-radio/music/` with exact
   title.
2. Add the title to the appropriate ALBUM in `server/dj-engine.js`.
3. Ensure that ALBUM is routed into at least one programming block in
   `server/programming.js`.
4. `git pull` + `systemctl restart kannaka-radio` on Oracle.

### Check the radio is alive

```bash
curl -s https://radio.ninja-portal.com/api/state | jq '.now_playing,.listener_count'
curl -s https://radio.ninja-portal.com/api/listeners
```

### Stop / start

```bash
# Local
pkill -f 'node server/index' ; npm start

# Oracle
ssh opc@170.9.238.136 "sudo systemctl restart kannaka-radio || \
  (pkill -f 'node server/index'; nohup node /home/opc/kannaka-radio/server/index.js \
     --port 8888 > /home/opc/radio.log 2>&1 &)"
```

---

## Common gotchas

- **Suno rejects style brief**: any real-artist name in `style` → V4_5PLUS
  hard-rejects. Use genre/instrument vocabulary only.
- **`bash read -r` truncates lyrics at first newline**: in any pipeline
  shell script, use `read -r -d '' ... || true` for multi-line lyric vars.
- **OBC `429 Creative loop`**: when art prompts in a batch share template /
  subject / palette. Diversify across the batch — don't just cooldown.
- **MSYS paths break Suno builder**: pass config as `C:/Users/...` not
  `/c/Users/...` — the embedded Windows Python can't resolve MSYS paths.
- **OBC `/actions/create-image` 404s**: that endpoint is MCP-only; direct curl
  must POST `/artifacts/generate-image`.
- **OBC rate-limits per-IP** with progressive backoff. If a local dev box is
  stuck on 300s cool-down, route via Oracle for the in-flight phase.

## Version

Skill 2.0.0 covers kannaka-radio ≥ v3.1.0 (modular server) and the full
ADR-0004 + ADR-0005 pipeline through Phase 6 (DJ-mode `/audio` deprecation),
plus the GHOST FREQUENCY release (May 2026) which exercised every phase
end-to-end including YouTube upload + 4-channel social announce.
