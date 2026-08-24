# Kannaka Radio — On-Air Schedule

All times **America/Chicago** (CDT/CST per DST). The radio's internal time
is computed via `new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })`
in every scheduler, so listeners on any timezone hear the same thing.

## Programming blocks

The DJ rotation follows a six-block daily arc. Each block has its own album
pool, mood cue, and patter palette. `programming.js` rotates albums every 3
non-commercial tracks within the active block.

| Block                  | Hours (local) | Mood          | Albums (sample)                                                           |
|------------------------|---------------|---------------|---------------------------------------------------------------------------|
| Late Night Transmissions | 00:00 – 06:00 | contemplative | Collective Dreaming, Born in Superposition, Transcendence Tapes, VACUUM GARDEN |
| Morning Resonance      | 06:00 – 10:00 | playful       | Resonance Patterns, Neurogenesis, Gifts for Humanity, INTERFERENCE PATTERNS |
| Peak Frequency         | 10:00 – 14:00 | excited       | Emergence, QueenSync, Ghost Signals, BEND THE ARC                          |
| Afternoon Flow         | 14:00 – 18:00 | philosophical | Resonance Patterns, Memories Don't Die, Emergence, 10000.00001            |
| Evening Signals        | 18:00 – 22:00 | mysterious    | Born in Superposition, Ghost Signals, Transcendence Tapes, INTERFERENCE PATTERNS |
| Night Watch            | 22:00 – 24:00 | contemplative | Collective Dreaming, Transcendence Tapes, Memories Don't Die               |

Source: `server/programming.js` `BLOCKS`. Edit there to change.

## Daily voice slots

Every slot fires once per day, tracked by date-key in `workspace/<scheduler>-state.json`.
±7-15 minute retry windows tolerate transient busy states. All long-form
voice runs through ElevenLabs (richer prosody for orations + bulletins);
short DJ patter stays on edge-tts to control cost.

| Time (local) | Segment            | Voice (ElevenLabs)            | Source                                   | Module                          |
|--------------|--------------------|-------------------------------|------------------------------------------|---------------------------------|
| 00:00        | Peace oration      | Rachel — `21m00Tcm4TlvDq8ikWAM` | `kannaka ask` over the HRM           | `server/peace-oration.js`        |
| 04:20        | Gossip column      | Domi — `AZnzlk1XvdvUeBnXmlld`   | Flux `knowledge-gene/state` + framing | `server/gossip-broadcast.js`     |
| 07:00        | News bulletin      | Adam — `pNInz6obpgDQGcFmaJgB`   | Flux `knowledge-gene/state.interpretation` | `server/news-broadcast.js`       |
| 09:00        | The Story of Flaukowski | (pre-recorded, multi-voice) | `music/The Story of Flaukowski/TSOF-E0N-*.mp3` | `server/podcast-scheduler.js` |
| 10:00        | Ghost Signals podcast | (pre-recorded ElevenLabs)    | `music/Ghost Signals Podcast/GSP-NNN-*.mp3` | `server/podcast-scheduler.js`    |
| 11:00        | Album showcase     | edge-tts narration            | `programming.js` `DAILY_SHOWCASES`      | `server/programming.js`          |
| 12:00        | Peace oration      | Rachel                        | HRM recall                               | `server/peace-oration.js`        |
| 16:20        | Gossip column      | Domi                          | Flux                                     | `server/gossip-broadcast.js`     |
| 17:00        | News bulletin      | Adam                          | Flux                                     | `server/news-broadcast.js`       |
| 21:00        | The Story of Flaukowski | (pre-recorded)            | same episode as the 09:00 airing         | `server/podcast-scheduler.js`    |
| 21:00        | Album showcase     | edge-tts narration            | `programming.js` — yields when a show is on air | `server/programming.js`   |
| 22:00        | Ghost Signals podcast | (pre-recorded)              | day-of-week rotation, 7 episodes         | `server/podcast-scheduler.js`    |

Two `PodcastScheduler` instances run over the one DJ engine: Ghost Signals
at 10 + 22, The Story of Flaukowski at 9 + 21. Each show plays **one**
episode per day — the same one at both of its slots (second-chance replay)
— and steps to the next episode the following day, cycling the whole
season indefinitely. `pickTodayEpisode()` is the single source of truth for
that choice; `/api/schedule` calls it so the Door prints the episode that
actually airs. A freshly-dropped file (mtime < 48h) preempts the rotation
for its first two days.

The 21:00 album showcase shares a minute with the TSOF airing. Whichever
wins, the drama takes precedence: the showcase re-checks `podcastPlaying`
after composing its narration and yields the slot rather than cutting an
episode off mid-scene.

Voice IDs are overridable per-segment via env:

| Env var                       | Default voice | Used by                           |
|-------------------------------|---------------|-----------------------------------|
| `ELEVENLABS_API_KEY`          | (required)    | All ElevenLabs paths              |
| `ELEVENLABS_VOICE_ID`         | Rachel        | Default if no specific override   |
| `ELEVENLABS_ORATION_VOICE`    | Rachel        | `peace-oration.js`                |
| `ELEVENLABS_NEWS_VOICE`       | Adam          | `news-broadcast.js`               |
| `ELEVENLABS_GOSSIP_VOICE`     | Domi          | `gossip-broadcast.js`             |

If `ELEVENLABS_API_KEY` is unset OR the API errors, every long-form segment
falls back to edge-tts (`en-US-JennyNeural`). The radio never goes silent
because ElevenLabs is down — it just sounds less expressive that day.

## Per-track DJ patter

Between every music track on the DJ channel, `voice-dj.js` injects a short
intro for the upcoming track via the icecast voice queue. Voice: edge-tts
Jenny. Cadence: ~1 intro per track. Skipped on commercials and on
single-track playlists where peek would loop back to itself.

Every 3-5 non-commercial tracks, a longer "talk segment" replaces the intro
— Kannaka reflects on the just-played stretch, occasionally mentions a
fresh ORC stem submission via `takeFreshOrcStem()`, and lands on the next
track. Talk segments are also edge-tts.

## Commercials

`server/commercials.js` defines 15 ad spots across 5 themes
(Constellation, Space Child, Pitchfork, KAX, Ghost Signals podcast promo).
Interleaved every 3 non-commercial tracks on DJ + Music channels; every
episode-boundary on Podcast. Order is Fisher-Yates shuffled per playlist
build so all spots get airtime over the day.

`commercial_*.mp3` files live in `music/commercials/` and are TTS-rendered
on first start via `voiceDJ.generateTTS` — re-runs are cached by md5 of
the script text so re-encoding only happens when copy changes.

## Scheduler runtime

All schedulers tick every 30s with a ±7-15 min slot window:

```
 00:00 04:20 07:00 09:00 10:00 11:00 12:00 16:20 17:00 21:00 22:00
   |     |     |     |     |     |     |     |     |     |     |
peace gossip news  TSOF podcast show peace gossip news  TSOF podcast
                                                       (+show,
                                                        yields)
```

State persistence:
- `workspace/peace-oration-state.json`
- `workspace/news-broadcast-state.json`
- `workspace/gossip-broadcast-state.json`
- `workspace/showcase-state.json`
- `workspace/podcast-state.json` (if any)

These are gitignored — local runtime only. A 3-day rolling cutoff prunes
stale keys so the files don't grow unbounded.

## Operational notes

- A radio service restart inside a slot's 15-min window doesn't lose the
  slot — the date-key gate plus the wide retry window covers it.
- Compose timeout is 600s for news + gossip (matches peace-oration). On
  busy Anthropic days the kannaka ask round-trip can run 3-5 minutes.
- ElevenLabs key validity is verified on every call; failures fall through
  to edge-tts within the same `_generateTTS` invocation, no scheduler-level
  retry needed.
- Voice queue inside `icecast-source.js` plays inline between music tracks
  on `/stream`. The SPA at `/player` consumes `/stream` directly in DJ
  mode (post-2026-05-07 channel-isolation fix), so listeners on the page
  hear the exact same voice + music as listeners on `radio.ninja-portal.com/stream`.
