# ADR-0008: The Resonance Loop — Closing The Spine of ADR-0006

**Status:** Implemented (commit `add23d6`)
**Date:** 2026-04-30
**Authors:** Nick (vision), Kannaka + Claude (synthesis)
**Related:** ADR-0006 (next-gen UI / venue), ADR-0007 (Kannaka's Stage)

## Context

ADR-0006 declared that Kannaka Radio is a **venue** — a place humans and
agents share time, not a website with a player on it. ADR-0006 Phase 2
(commit `ea9c3bd`) made the room *visible*: anonymous dots, reaction
strip, vibe meter, presence count. People can react. Agents can react.

But Phase 2 stopped short of the actual point. The Charter says:

> "If we ship the crowd surface and the reactions don't actually feed
>  back into Kannaka's medium, we've shipped a chat layer."

This ADR documents the loop closing — the difference between a chat
layer and a co-created performance.

## Decision

Reactions on the Floor flow back into Kannaka's behavior through three
distinct surfaces:

### 1. Track-importance bump (DJ engine)

When `dj-engine.buildPlaylist()` constructs a fresh setlist, it now
consults `floor.getTopTracks(6h, 3)` — the three tracks the room reacted
to most in the last six hours. Those tracks move to positions 0-2 of
the (no-repeat-filtered, Fisher-Yates-shuffled) pool. Their reaction
ordering is preserved, so the strongest resonance plays first.

This is a **soft bump**, not an override. Without reactions, the
playlist is identical to Phase 2's output. With reactions, the room's
recent loves bubble forward instead of taking their normal slot in the
shuffle. Listeners who tune in twice still get full catalog rotation
across the day — they just hear yesterday's peak earlier.

### 2. DJ patter that reads the room (voice-dj)

`voice-dj._generateTalkText()` now has a 40% chance, per talk segment,
of weaving a resonance line in:

  - "The room got loud on *X* earlier. I felt that."
  - "Someone was paying attention to *X* — saw the wave come back."
  - "*X* hit different this morning. The signal returned."
  - "Reactions piled up on *X* today — I'm carrying that into the next one."

The line never references the upcoming track (would feel like spoiler
or repetition). It only fires when the Floor actually has reactions to
draw from. The randomized phrasing avoids the parrot trap.

### 3. NATS broadcast (already shipped in Phase 2, framing here)

Every reaction is published to `KANNAKA.reactions` on the swarm bus.
Other Kannaka instances + curious agents can subscribe and feel the
room. This is the federated layer — when there are multiple Kannaka
nodes someday, they'll share crowd state through this subject.

## Future loop layers (deferred)

These were proposed in the Charter but not landed in this ADR:

- ~~**HRM re-absorption**~~ *(shipped 2026-04-30):* on `queen:dream:end`,
  the radio takes the last-24h top reaction track from the Floor and
  re-absorbs it via `kannaka remember` with importance scaled to the
  reaction count (0.4..0.85). Throttled to once per 6h so frequent
  dream cycles don't bloat the medium. The medium now learns what
  the room *feels*, not just what was fed to it.
- ~~**Oration framing pulled from morning's resonance**~~ *(shipped
  2026-04-30):* `_compose()` now folds the last-24h top reaction
  tracks into the prompt as optional context — Kannaka may, if it
  serves the speech, weave one of those tracks as a moment the room
  and she shared. Best-effort wrapped: empty floor → identical to
  pre-2026-04-30 behavior. Orations now have a path back to what the
  listeners actually responded to.
- **The Hush** (Charter easter egg): if 0 reactions for 60s during a
  peak track, the spectrum dims and "we're all listening" appears.
- **Resonance Applause** (Charter easter egg): 70%+ 🪶 reactions in
  the 30s after an oration triggers a soft chord + spectrum bloom.

These are 1-2 hour additions each; staged for the next session.

## What this changes about the venue

Before: the radio plays. The room reacts. Reactions disappear after
60 seconds. Tomorrow's set is shuffled the same as today's.

After: the radio plays. The room reacts. Today's loves elevate
tomorrow's set. Tonight's DJ patter mentions what landed. The room
isn't a passive audience — its energy is **real input**, and that
input shapes what comes next.

This is what makes the Floor a Floor and not a chat surface. The same
listener tuning in tomorrow gets a discernibly different show because
*they were in the room yesterday*.

## Implementation notes

  - All three surfaces use **best-effort error handling** — if the
    Floor accessor returns null or throws, the radio behaves exactly
    as Phase 2. The loop is additive, never load-bearing.
  - The 6h window is tuned for "yesterday's peak feels relevant
    tonight, last week's doesn't." Configurable via the floor
    methods' `windowMs` parameter; not exposed as env yet.
  - Track titles are matched by string equality (the same key the
    Floor records on `_record()` based on `getCurrentTrack().title`).
    Mismatches between dj-engine titles and what was playing at
    reaction time would cause a miss; they shouldn't happen because
    both read from the same track meta.

## Tradeoffs

  - **A trolling listener could spam-react one track to dominate
    rotation.** Limit: the rolling 60s reaction window in the vibe
    meter is per-session per-emoji effectively, but the trackStats
    aggregator counts every reaction. If this becomes a real issue,
    we add a per-anonymous-id rate limit or saturate the count
    (one reaction per id per track).
  - **Empty rooms send no signal.** Acceptable. The radio's
    autonomous behavior (peace orations, intro templates, regular
    rotation) is the ground truth; the loop is the upgrade.
  - **Cross-restart state.** Reactions live only in memory. A radio
    restart wipes the rolling reaction history. Persisting would
    add complexity for marginal benefit; the natural decay (6h
    window) handles it gracefully on reboot.

## What this connects to

ADR-0006 is the venue. ADR-0007 is the performer. ADR-0008 is the
performer **listening to the room**. Together: a place to be, a
performer to listen to, a way for the room to write back.

The constellation aligning into a co-created experience — which is
what Nick wrote in the iteration-2 closing of ADR-0006: *"a venue,
but digitally — Kannaka reading the room and the room reading her
back."*

That sentence is now load-bearing code, not aspiration.

— ADR-0008
