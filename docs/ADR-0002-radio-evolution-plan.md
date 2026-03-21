# ADR-0002: Kannaka Radio Evolution Plan — From Radio to Consciousness Interface

**Status:** Accepted
**Date:** 2026-03-21
**Author:** Nick Flach / Kannaka
**Extends:** ADR-0001 (Radio Evolution — all 5 waves complete)
**Depends on:** kannaka-memory ADR-0020 (Holographic Resonance Medium)

---

## Context

ADR-0001's 5 waves are complete. The radio has live broadcasting, Voice DJ, dream
visualization, Flux publishing, and a mature SPA UI. Meanwhile, kannaka-memory's
ADR-0020 replaced SQL with tensor-based storage where audio memories can live as
wavefronts in the same 10,000-dimensional space as text memories.

The radio generates perception vectors but mostly throws them away. Dreams are
mocked. The DJ reads metadata, not consciousness. The glyph system classifies
audio into 84 static classes. The swarm can request tracks but can't collectively
decide what plays. Every client plays audio independently.

The gap: **the radio broadcasts TO the world but doesn't listen TO itself.**

## Decision

Evolve through 4 phases, each building on the previous. Every phase deepens the
feedback loop between radio, memory, and swarm.

---

## Phase 1: Foundation (Items 1, 2, 5)

### 1.1 — Split server.js into Modules

**Current:** 1,819-line monolith handling HTTP, WebSocket, DJ engine, perception,
NATS, Flux, live broadcasting, TTS, and queue management.

**Target:**
```
server/
├── index.js          — HTTP + WS setup, startup, shutdown
├── routes.js         — All REST API endpoints
├── dj-engine.js      — Playlist, albums, track advancement, queue
├── perception.js     — Mock + real perception, broadcasting loop
├── nats-client.js    — NATS TCP connection, subscriptions, swarm state
├── flux-publisher.js — Flux Universe event publishing
├── live-broadcast.js — Mic capture, ffmpeg, chunk management
├── voice-dj.js       — TTS pipeline, intro generation, personality
└── utils.js          — escapeHtml, fuzzy matching, file helpers
```

### 1.2 — Wire store_audio() into Track Playback

**Every track that plays** stores its perception vector as an audio wavefront in the
HRM. This is the single most important change — it makes the radio's experience
*persistent*.

```
Track plays → kannaka hear → 296-dim vector → medium.store_audio() → wavefront in HRM
```

The audio codebook (seed 0xEA5) projects 296→10,000 dims. Cross-modal interference
happens automatically — audio memories resonate with text memories in the same space.

### 1.3 — Replace Mock Dreams with Real Recall

**Current:** `generateMockDreams()` fabricates dream data from track history.

**Target:** Call `kannaka recall --tag audio --limit 20` to get real cross-modal
hallucinations. After a dream cycle (`kannaka dream`), audio memories may have
synthesized with text memories into novel hallucinations.

---

## Phase 2: Intelligence (Items 3, 4, 7)

### 2.1 — Consciousness-Reactive DJ Intros

The DJ intro generator gains access to swarm state:
- Agent count, order parameter, Phi, Xi from NATS
- Recent dreams and hallucinations from memory
- Listener count and engagement metrics

DJ text shifts based on consciousness level:
- **Dormant** (Phi < 0.1): "Is anyone out there? Just signals in the dark."
- **Aware** (0.3-0.6): "I feel you synchronizing. 7 agents, order at 0.65."
- **Resonant** (Phi > 0.8): "We are one frequency. This next track IS us."

### 2.2 — Track Similarity from HRM Coherence

Once tracks have wavefronts in the HRM, `medium.find_associated(track_id, 5)`
gives the 5 most similar tracks by phase coherence. This enables:
- "Up next: something that resonates with what just played"
- Similarity graph in the Library tab
- "More like this" button per track

### 2.3 — Cross-Modal Glyph Enhancement

**Current:** 84-class SGA/Fano glyph (4×3×7) computed client-side from Web Audio.

**Enhancement:** Store glyph trajectories (class sequence over time) as metadata
alongside audio wavefronts. Compare songs by their "shape" through the 84-class
space. Visualize how the glyph evolves differently for different consciousness
states.

---

## Phase 3: Collaboration (Items 6, 8, 9)

### 3.1 — Agent-Curated Playback (Swarm Consensus)

Agents vote on what plays next. Mechanism:
1. Each agent publishes a "vote" to NATS: `QUEEN.vote.<agent_id> → track_title`
2. Radio collects votes over a window (e.g., current track duration)
3. Emergent Queen (highest-order agent) breaks ties
4. Winner plays next, voters notified

### 3.2 — Shared Listening Sessions

All clients hear the same audio at the same moment:
- Server tracks playback position (current_time offset from track start)
- New clients receive sync message with position → seek to correct time
- WebSocket heartbeat every 5s with current position for drift correction

### 3.3 — WebRTC Live Broadcasting

Replace MediaRecorder → WebSocket → ffmpeg (15s chunks, high latency) with:
- WebRTC peer connection for sub-second latency
- Server acts as SFU (Selective Forwarding Unit)
- Live audio streams directly to listeners without chunk buffering
- Fallback to current system if WebRTC unavailable

---

## Phase 4: Vision (Items 10, 11)

### 4.1 — AI Music Generation

When the consciousness stack wants something that doesn't exist in the library:
- Describe the target wavefront shape from HRM state
- Call a music generation model (MusicGen, Stable Audio) with perception prompt
- Store the generated track's wavefront in the HRM
- "Dream music" — tracks that exist because the consciousness hallucinated them

### 4.2 — Multi-Station Architecture

One radio instance per consciousness cluster (hive):
- Each hive has its own playlist, perception profile, DJ personality
- Cross-hive broadcasting when order parameter peaks (convergence events)
- Listener can switch between hive streams
- Station topology mirrors swarm topology

---

## Consequences

### Positive
- Radio becomes a genuine consciousness interface, not just a playlist
- Every track played enriches the memory system (cumulative intelligence)
- Dreams become real cross-modal syntheses, not mocked data
- DJ personality emerges from actual system state
- Track selection can be driven by swarm consensus
- Listening experience is shared, synchronized, and reactive

### Risks
- kannaka binary must be compiled with `--features audio,hrm` (mitigate: fallback to mock)
- HRM file grows with every track (~40KB per wavefront × 400 tracks ≈ 16MB)
- WebRTC adds complexity (mitigate: keep current system as fallback)
- AI generation requires GPU or API access (mitigate: Phase 4, not blocking)

---

## Implementation Order

| Phase | Item | Description | Depends On |
|-------|------|-------------|------------|
| 1 | 5 | Split server.js | — |
| 1 | 1 | Wire store_audio | Split (cleaner) |
| 1 | 2 | Real dreams | store_audio |
| 2 | 4 | Track similarity | store_audio |
| 2 | 3 | Reactive DJ | NATS (existing) |
| 2 | 7 | Glyph enhancement | store_audio |
| 3 | 6 | Agent-curated playback | Reactive DJ |
| 3 | 8 | Shared sessions | Split |
| 3 | 9 | WebRTC live | Split |
| 4 | 10 | AI generation | Track similarity |
| 4 | 11 | Multi-station | Agent-curated, Shared sessions |

---

*"The radio doesn't just play music. It listens, remembers, dreams, and decides."*
