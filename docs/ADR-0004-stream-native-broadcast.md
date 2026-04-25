# ADR-0004: Stream-Native Broadcast Pipeline (Icecast + Liquidsoap)

**Status:** Proposed
**Date:** 2026-04-25
**Author:** Nick Flach / Kannaka
**Depends on:** ADR-0001 (Radio Evolution), ADR-0002 (Agent-Curated Playback)
**Related:** kannaka-memory ADR-0017 (Kannaka Voice)

---

## Context

Kannaka Radio is currently a Node HTTP server with a custom orchestration
loop. Each listener pulls individual MP3 files from `/audio/<filename>` over
HTTP Range requests, and a WebSocket bus broadcasts track metadata and DJ
voice events out of band. The browser SPA stitches the experience together:
on `audio.ended` the client POSTs `/api/next?source=ended` and the server
advances the playlist; the next track's URL arrives via the WS state push;
the DJ voice arrives as a separate `<audio>` element trigger.

This works for the SPA we control. It does not work for everything else:

- **No standards-compliant stream URL.** Internet-radio directories
  (TuneIn, RadioGarden, Internet-Radio.com, Radio Browser) index Icecast/
  Shoutcast streams. We can't be listed because we don't expose one.
- **iOS/Bluetooth fragility.** Even after the Media Session + `playsinline`
  + WebAudio-skip fixes (deployed), background playback over the SPA is
  brittle — every track-change is a file load, every load risks a stall on
  spotty networks, and any browser policy change can break it again.
- **No native-app surface.** Listeners can't add the station to their car
  head unit, their CarPlay favorites, or any podcast/radio app. There's no
  URL to paste anywhere except a browser.
- **Track seams are abrupt.** No crossfade, no level-matched gain, no
  music-bed-under-DJ-voice ducking. The DJ voice currently stops the music.
- **Server-side mixing is impossible.** Live mic + music mix, scheduled
  jingles, sweepers, ad-break ducking — all of these require an audio
  graph we don't have.
- **No discovery beyond what we drive.** Bluesky / RSS / GossipGhost reach
  is real but small. Public Internet radio directories are an additional
  free, persistent discovery channel we cannot use without a stream.

The current Node-driven approach was the right choice early — it's flexible,
debuggable, and matches the SPA's per-listener experience. The radio has
outgrown it. We need a real broadcast pipeline.

## Decision

Adopt the **Icecast + Liquidsoap** pair as the canonical broadcast surface.
Keep the existing Node server as the **control plane** and the SPA experience
as a **synchronized companion app**, but route all actual audio through a
proper streaming stack.

### Architecture

```
                    ┌──────────────────────────────────┐
                    │  Node control plane (existing)   │
                    │   • DJ engine / playlist         │
                    │   • Voice DJ (kannaka ask)       │
                    │   • Programming schedule         │
                    │   • Peace oration scheduler      │
                    │   • WS metadata bus (SPA)        │
                    │   • REST API + Bluesky/social    │
                    └─────────────┬────────────────────┘
                                  │  metadata + queue ops
                                  ▼  (NATS or HTTP control)
              ┌────────────────────────────────────────────┐
              │             Liquidsoap pipeline             │
              │                                              │
              │  Music sources ─────►┐                       │
              │  Voice TTS  ────►┐   │                       │
              │  Peace oration ─►├──►│ mixer + crossfade ───►│
              │  Live mic ──────►┘   │ ducking + ReplayGain  │
              │                      │ blank/dead-air guard  │
              │                                              │
              │   metadata: artist=Kannaka, title=<track>    │
              └─────────────────────────────┬────────────────┘
                                            │  encoded MP3/Opus
                                            ▼
                              ┌──────────────────────────┐
                              │       Icecast 2          │
                              │  /stream  (MP3 128kbps)  │
                              │  /stream.opus (Opus 96)  │
                              │  ICY metadata + mountpts │
                              └────────┬─────────────────┘
                                       │
            ┌──────────────────────────┼─────────────────────────────┐
            ▼                          ▼                             ▼
       Browser SPA              Native apps / car           Public directories
   (player + viz + chat)    (VLC, Apple Music URL,        (TuneIn, RadioGarden,
        WS metadata           CarPlay, Sonos, Foobar,          Radio Browser)
       overlays match           Strawberry, etc.)
        the stream
```

### What changes

1. **`server/dj-engine.js` becomes a queue/policy module.** It still picks
   the next track and reasons about programming blocks, but it no longer
   serves audio. It hands track URIs and metadata to Liquidsoap via a
   control socket (Liquidsoap's `telnet` interface) or HTTP harness.

2. **`server/voice-dj.js` keeps composing + TTS-ing intros**, but the
   resulting WAV/MP3 file is *queued* into Liquidsoap's voice source. The
   pre-generation cache pattern (`prepareIntro` for the next track) stays
   — Liquidsoap pulls from the cache when it's time. DJ voice ducks the
   music bed instead of pausing it.

3. **Peace oration becomes a scheduled Liquidsoap input** with a hard
   priority — when the noon/midnight slot fires, the oration audio path
   takes over the mix, music ducks to silence, oration plays, music
   restores via crossfade.

4. **The SPA no longer schedules audio playback.** It connects to
   `https://radio.ninja-portal.com/stream` (Icecast) and renders metadata
   from the WS bus on top. No more `audio.ended` / `/api/next`. No more
   per-listener resync gymnastics. The "Current track" display, the
   visualizer, the DJ monologue panel — all driven by WS metadata
   messages keyed off Icecast's `StreamTitle` change events.

5. **Track files stay where they are.** Liquidsoap reads from
   `/home/opc/kannaka-radio/music/`. We don't move audio.

### What's preserved

- All Kannaka voice generation logic (`kannaka ask --no-tools` for intros
  + orations + Bluesky drafts). Liquidsoap consumes audio files; it
  doesn't care how they were composed.
- Programming schedule, album rotation, shuffle, talk-segment timing.
- WS bus for metadata, perception, swarm events, dream events.
- Bluesky / GossipGhost / dream-post pipeline.
- The `kannaka hear` self-listen loop on every TTS audio output.
- The control plane's REST API. SPA-only features (markets, voting, queue)
  keep working as today.

### Mountpoints + formats

- `/stream` — MP3 128kbps CBR. Maximum compatibility (every car, every
  app, every legacy device).
- `/stream.opus` — Opus 96kbps. Better quality at half the bitrate; modern
  browsers and apps prefer it.
- `/peace.mp3` (optional) — the most recent peace oration as a static
  file, served by the Node side, linked from Bluesky posts.

## Consequences

### Positive

- **Discoverability.** Submit `/stream` to TuneIn, RadioGarden, Radio
  Browser, Internet-Radio.com, Shoutcast/dirble. Free, permanent, indexed
  alongside thousands of stations people are already browsing.
- **Native client compatibility.** "Open URL" in any music app works.
  CarPlay, Sonos, Apple Music's "open stream URL," every podcast app.
  This alone solves the iOS/Bluetooth class of bugs because it's no
  longer "browser audio."
- **Production-quality audio.** Crossfade. ReplayGain leveling. Dead-air
  guard. Music-bed-under-voice ducking. Standard radio polish.
- **Standard FortiClient/enterprise treatment.** A single Icecast stream
  on a clean port reads as "internet radio" to web filters, not as
  "unknown streaming media + WebSocket + HTTP file pulls."
- **Lower bandwidth per listener** at scale (Icecast streams the encoded
  audio once and fans out; Range-pulled MP3s send the whole file to each
  client, including parts they skip).

### Negative / cost

- **Real refactor.** Several days of focused work, not an afternoon. The
  Liquidsoap script is a new artifact in a new language (OCaml-flavored
  DSL). DJ engine becomes a controller, not a server. SPA player has to
  switch from `<audio>`-with-`/audio/<file>` to `<audio>`-with-
  `/stream`.
- **One more process to manage.** Icecast + Liquidsoap as systemd units.
  Failure modes: stream goes silent, stream stalls, encoder crashes.
  Need monitoring (NATS heartbeat from Liquidsoap into the Node side
  works fine).
- **Slight loss of per-listener flexibility.** Today the SPA can show
  per-listener perception data because the audio decode happens in the
  browser. With Icecast, all listeners hear the same encoded stream,
  and per-listener viz must be derived from the encoded audio (still
  works in the browser via WebAudio on the stream URL — but it's the
  same input for everyone).
- **Live broadcast complexity.** WebRTC live-mic input becomes a source
  Liquidsoap pulls from instead of being mixed in the browser. More
  reliable but a different code path.

### Risks

- **Liquidsoap learning curve.** The DSL is powerful but unfamiliar.
  Mitigation: lean on the Liquidsoap community's published recipes for
  the standard "rotation + voice tracks + jingles + scheduled blocks"
  pattern; only customize what we must.
- **Re-encoding the existing MP3 library to a unified bitrate** may be
  desirable for level consistency. ReplayGain on-the-fly avoids this.

## Migration plan (phased)

1. **Phase 1: parallel Icecast** (1–2 days). Stand up Icecast + a minimal
   Liquidsoap script that just rotates the One More Life album with
   crossfade, on a separate mount (`/preview`). No DJ voice, no
   programming schedule. Listen on the side. Validate it sounds right
   and stays up.
2. **Phase 2: control bridge** (2–3 days). Liquidsoap reads its source
   queue from a control socket fed by `dj-engine.js`. Programming
   schedule still selects next tracks, but pushes them as URIs.
   Crossfade + ducking active. SPA still uses old per-file path.
3. **Phase 3: voice + oration** (2 days). Pre-generated intros land in
   Liquidsoap's voice source. Peace oration uses a high-priority
   scheduled source. DJ voice ducks music. SPA still uses old path.
4. **Phase 4: SPA cutover** (1 day). SPA `<audio>` switches to
   `/stream`. Old `/audio/<file>` endpoint stays alive a week for
   safety. WS metadata mapped to Icecast `StreamTitle`.
5. **Phase 5: directory submissions** (a day, then a few weeks waiting).
   Submit to RadioGarden, TuneIn, Radio Browser, Internet-Radio.com,
   Shoutcast Directory. Update the radio page footer with the stream URL
   so people can paste it into their own apps.
6. **Phase 6: deprecate `/audio/<file>`** (after 1 month). Keep it
   available for the music tab (per-track playback) but remove from the
   DJ-mode flow.

## Open questions

- Stream from Oracle (current host) or move encoding to a smaller
  always-on machine? Oracle aarch64 will encode fine; not urgent.
- Single-bitrate or multi-bitrate? Start single (`/stream` MP3 128).
- Keep the existing `/audio/<file>` endpoint forever for the
  music/library tab? Probably yes — it serves a different need (on-demand
  per-track playback inside the SPA).
- Liquidsoap on Oracle Linux 9 (aarch64): need to check binary or build
  from OPAM. Should be fine; OPAM works on aarch64.
- What's the right format for the dead-air-guard fallback (a 30-second
  Kannaka-recorded "the signal will return" loop)?

---

## References

- Liquidsoap docs: https://www.liquidsoap.info/doc-2.2.5/
- Icecast 2 docs: https://icecast.org/docs/icecast-2.4.4/
- Radio Browser API (free, open): https://www.radio-browser.info/
- TuneIn submission: https://help.tunein.com/contact/add-station-S19TR3Sdf
- RadioGarden: stations submitted via radio.garden/contact
