# ADR-0010 — Channel switching is local-only

**Status:** Accepted, deployed in `8a22d55` (2026-05-07)

## Context

The SPA at `/player` has a row of channel buttons — DJ, Music, Podcast,
KAX, ORC. Clicking any of them used to fire `POST /api/channel?type=...`
which mutated the **server-global** `djEngine.state.channel`. Since
icecast-source pulls from `djEngine.getCurrentTrack()` to drive the
public `/stream` mount, that meant any visitor flipping to the Music
tab on `/player` reprogrammed `/stream` for **everyone listening**.

A user reported that two browser tabs both pointed at `/player` and on
the main DJ tab "synced up and playing then went different paths
playing different songs." Investigation showed:

1. `setChannel(type)` fired `POST /api/channel` and the server applied
   the new channel to global state.
2. Music mode swapped the SPA's `<audio>` to `/audio/<file>`
   per-track playback at native rate.
3. Native rate audio drifted from icecast realtime over time.
4. A user clicking Music while another listened was ALSO yanking the
   second listener's `/stream`, causing the mid-song cut they reported.

## Decision

**Channel tabs are now a client-only UI affordance.** The SPA flips
its own `<audio src>` based on `currentMode`, but never touches the
server. The server's `djEngine.state.channel` stays in `'dj'` mode
permanently. `/api/channel` is preserved for API consumers but logs
every hit with UA + counter so we can see how long any legacy callers
linger.

Specifics:
- `setChannel('dj')` reattaches `<audio>` to `/stream`.
- `setChannel('music' | 'podcast')` detaches from `/stream`; the
  existing library / queue / podcast UIs drive per-file playback via
  `/audio/<file>` on the same `<audio>` element.
- `setChannel('kax' | 'orc')` opens the dedicated subdomain in a new
  tab — they're separate apps, not audio sources.
- `applyState`'s track-change handler only re-sets `audio.src` when
  `currentMode === 'dj'`. In other modes the user's manual library
  pick stays selected.

## Consequences

**Wins**
- Visitors browsing the library can't accidentally yank `/stream` out
  from under public listeners.
- Music mode is now a private jukebox — skip / scrub / pick is local.
- Dual-tab "follow the same /stream" works cleanly because both tabs
  pull bytes directly from the icecast feed.

**Tradeoffs**
- "Multi-listener Music mode sync" — the implicit feature where
  several listeners experienced the same skip click — is gone. The
  global `/stream` was the source of truth for synchronization; once
  a listener leaves it, they're on their own.
- The server keeps a few hundred extra bytes of unused channel state
  (Music / Podcast / KAX / ORC handlers in `setChannel`) until we feel
  confident enough to remove them. The `/api/channel` deprecation log
  tells us when no client has called it for a meaningful window.

## Followups

- Once `[deprecation] /api/channel` log shows zero hits over 30 days,
  remove the server handler and the dead-code paths in dj-engine for
  non-DJ channels.
- A future "shared listening room" feature (deliberate multi-listener
  sync) would need its own opt-in mechanism — e.g., an explicit
  `/listen-along/<host_id>` URL, not a side effect of channel state.
