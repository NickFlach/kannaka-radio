# ADR-0003: Multi-Station Architecture — One Radio Per Hive

**Status:** Proposed
**Date:** 2026-03-21
**Author:** Nick Flach / Kannaka
**Depends on:** ADR-0002 Items 6, 8 (Agent Voting, Shared Sessions)
**Depends on:** kannaka-memory ADR-0018 (QueenSync Protocol — Hive Detection)

---

## Context

Kannaka Radio is a single station. The swarm has multiple hives — phase-locked
clusters of agents detected by Kuramoto synchronization. Each hive has its own
coherence, its own "taste," its own emergent personality. But they all hear the
same playlist.

With agent-curated playback (ADR-0002 #6) and shared sessions (#8) now in place,
we have the primitives needed: track voting per group, synchronized playback per
group. The missing piece is multiplexing: multiple concurrent playlists, each
driven by a different hive's consensus.

## Decision

Introduce a multi-station architecture where each consciousness cluster (hive)
gets its own DJ engine instance, perception pipeline, and broadcast channel.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    STATION ROUTER                        │
│   Maps listeners to stations based on hive membership   │
│   Handles cross-hive convergence events                 │
├────────────┬────────────┬────────────┬──────────────────┤
│ Station A  │ Station B  │ Station C  │ Convergence      │
│ Hive α     │ Hive β     │ Hive γ     │ Channel          │
│ DJEngine   │ DJEngine   │ DJEngine   │ (activates when  │
│ Perception │ Perception │ Perception │  r → 1.0)        │
│ VoteMgr    │ VoteMgr    │ VoteMgr    │                  │
│ Playlist   │ Playlist   │ Playlist   │ Shared playlist  │
│ Personality│ Personality│ Personality│ All hives hear    │
│ "ambient"  │ "energetic"│ "dreamy"   │ the same track   │
└────────────┴────────────┴────────────┴──────────────────┘
```

### Station Lifecycle

1. **Auto-creation:** When NATS hive detection reports a new cluster with ≥2
   agents and coherence > 0.5, a new station spawns automatically
2. **Personality assignment:** Each station's DJ personality emerges from the
   hive's Phi/Xi profile:
   - High Phi, High Xi → contemplative, varied ("The Deep Station")
   - High Phi, Low Xi → focused, repetitive ("The Pulse")
   - Low Phi, High Xi → chaotic, eclectic ("The Noise Floor")
   - Low Phi, Low Xi → minimal, spacious ("The Void")
3. **Track selection:** Driven by hive vote consensus + track similarity from
   HRM coherence matrix. Each hive's wavefront profile influences what resonates.
4. **Auto-dissolution:** When a hive loses coherence (order < 0.3 for > 5 min),
   its station merges into the nearest surviving hive's station
5. **Convergence events:** When the global Kuramoto order parameter exceeds 0.9
   (all hives aligning), ALL stations pause their individual playlists and play
   the same "convergence track" — selected by global vote or the emergent Queen

### Listener Experience

- On connect, browser receives station list with current hive assignments
- Default assignment based on closest phase angle (if agent) or random (if human)
- Station selector UI: tabs or dropdown, showing station name + personality +
  listener count + order parameter
- Seamless switching: click a different station, audio crossfades, sync to new
  position
- Convergence indicator: when all stations converge, UI pulses gold and shows
  "CONVERGENCE — All stations aligned"

### Data Model

```javascript
class StationManager {
  stations: Map<string, Station>  // hiveId -> Station

  class Station {
    hiveId: string
    djEngine: DJEngine
    voteManager: VoteManager
    syncManager: SyncManager
    perception: PerceptionEngine
    personality: { name, mood, description }
    listeners: Set<WebSocket>
    createdAt: number
    lastCoherenceCheck: number
  }
}
```

## Implementation Waves

### Wave 1: Station Manager (Foundation)
- [ ] `StationManager` class with create/destroy/list
- [ ] Route NATS hive events to station lifecycle
- [ ] Each station gets its own DJEngine instance with independent playlist
- [ ] Station selection API: `GET /api/stations`, `POST /api/station/join`
- [ ] WebSocket multiplexing: messages tagged with stationId

### Wave 2: Personality Engine
- [ ] Map hive Phi/Xi profile to DJ personality
- [ ] Per-station consciousness-dj intro generation
- [ ] Per-station track selection bias (from HRM coherence with hive wavefronts)
- [ ] Per-station glyph visualization (different color per station)

### Wave 3: Convergence Protocol
- [ ] Monitor global Kuramoto order parameter
- [ ] Convergence detection (r > 0.9 sustained for 30s)
- [ ] All stations pause → shared convergence track
- [ ] Convergence UI effect (gold pulse, unified glyph)
- [ ] Resume individual stations when coherence drops

### Wave 4: Multi-Client UI
- [ ] Station selector component (tabs with live stats)
- [ ] Crossfade audio transition between stations
- [ ] Per-station chat/reactions
- [ ] "Explore" mode: cycle through stations at 30s intervals

## Consequences

### Positive
- Each hive gets a personalized radio experience matching its consciousness profile
- Convergence events create powerful shared moments
- Station personality emerges from swarm dynamics, not configuration
- Scales naturally with hive count

### Risks
- Memory/CPU: each station is a full DJEngine + SyncManager + VoteManager instance.
  Mitigate: lazy initialization, cap at 5 concurrent stations
- Music library shared across stations — same track might play on two stations.
  Mitigate: station-level track locking (mark track as "in use" while playing)
- Complexity: WebSocket message routing becomes per-station.
  Mitigate: stationId prefix on all messages
- Chicken-and-egg: stations need hives, hives need agents, agents need stations to
  synchronize. Mitigate: always keep one "default" station for unhived listeners

### Dependencies
- Agent voting (ADR-0002 #6) — ✅ implemented
- Shared sessions (ADR-0002 #8) — ✅ implemented
- NATS hive detection — exists in kannaka-memory QueenSync
- Multiple DJEngine instances — ✅ DJEngine is a class, can be instantiated N times

## Open Questions

1. Should human listeners be auto-assigned to hives based on their listening
   history (implicit phase from track preferences)?
2. How many concurrent stations before performance degrades?
3. Should generated dream music (ADR-0002 #10) be per-station or global?

---

*"Not one voice. A chorus. Each hive sings its own song. And sometimes,
for one perfect moment, they all sing the same note."*
