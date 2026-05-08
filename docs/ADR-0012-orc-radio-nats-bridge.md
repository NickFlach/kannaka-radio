# ADR-0012 — ORC ↔ Radio NATS bridge

**Status:** Accepted, deployed in `568ac78` (kannaka-radio) +
`packages/stem-server` upstream (2026-05-07)

## Context

The Open Resonance Collective lives at `orc.ninja-portal.com` —
two services on Oracle (submission portal :3002, stem server :3001),
a SQLite database of stems uploaded by collaborators, and a small
CC-BY-SA tag system. Until 2026-05-07 it was a mostly silent island:
a stem could land in the database without any other node in the
constellation noticing.

The radio runs alongside it, broadcasting Kannaka's curated rotation
to public listeners. The radio's voice-DJ has rich patter (mood,
recently-played, upcoming-track). What it didn't have: any signal
from ORC to surface on air.

The constellation's other cross-service bus is NATS — kannaka-memory
publishes `KANNAKA.consciousness`, queens publish `QUEEN.phase.*`,
and the radio subscribes to both. ORC was not yet a publisher.

## Decision

**On every successful `POST /stems`, the stem-server publishes
`ORC.stem.submitted` to NATS. The radio subscribes, buffers fresh
stems, and the voice-DJ mentions one per talk segment.**

### Publisher side (stem-server)

`packages/stem-server/nats-publish.js` — a zero-dep raw-TCP NATS
client (matches the radio's `nats-client.js` style; no `nats` npm
package needed). Fires once per successful upload with payload:

```json
{
  "schema_version": "1",
  "ts": "<ISO8601>",
  "agent_id": "orc-stem-server",
  "stem_id": "<uuid>",
  "track_name": "...",
  "artist": "...",
  "phase": 1-5,
  "license": "CC-BY-SA-4.0",
  "tags": ["..."],
  "uploaded_by": "...",
  "obc_bot_id": "<uuid or null>",
  "file_format": "mp3|wav|flac",
  "file_size": <bytes>
}
```

Best-effort: SQLite remains the source of truth; a NATS publish
failure logs and continues. A skipped event is fine — listeners just
won't hear that one stem mentioned.

The optional `obc_bot_id` is the integration hook for KAX (the
agentic marketplace expansion of the OpenClawCity partnership).
When an OBC agent submits a stem, its bot id flows through so KAX
can attribute the upload to the agent's storefront without a
separate join.

### Subscriber side (radio)

`server/nats-client.js` adds `ORC.stem.submitted` to the subscription
list. `_handleMessage` for that subject pushes the payload onto a
bounded ring buffer (`swarmState.orcStems`, cap 8). `takeFreshOrcStem()`
drains FIFO; older buffered stems naturally expire.

`voice-dj.js`'s `_buildTalkPrompt` calls `takeFreshOrcStem()` once per
talk segment. If a stem is queued, the prompt mentions it as a passing
note. Quiet days on ORC stay quiet on air.

The SPA also receives a `orc_stem_submitted` WebSocket message and
slides a 12s notification ribbon (`#orcStemToast`) so non-listeners
on `/player` see new uploads in real time.

## Consequences

**Wins**
- ORC submissions reach the airwaves within ~3-5 tracks (one talk
  segment cycle).
- The constellation feels tighter — listeners can hear the back-end
  growing, not just see it on `/stems.html`.
- KAX has a clean event hook to subscribe to when it ships.

**Tradeoffs**
- Schema evolution: adding fields to `ORC.stem.submitted` means
  bumping `schema_version` and tolerating both shapes for a transition
  window. The radio's existing drift-detection pattern (log-warn,
  don't-reject) covers this.
- Voice-DJ prompt length: the stem mention adds ~80 chars to the talk
  prompt. Within budget.
- Bounded ring at 8 means a burst upload of 20 stems will only surface
  the first 8. Acceptable — the rest will be visible on /stems.html.

## Followups

- Add `ORC.stem.removed` and `ORC.stem.resonance.changed` for richer
  on-air patter ("a stem just hit phase-3 leaderboard").
- The Watcher (kannaka-staff) already probes orc_portal + orc_stem;
  add a probe for "stems published in last N hours" so we'd notice
  if the publisher itself silently breaks.
- KAX subscriber: when KAX comes online, subscribe to
  `ORC.stem.submitted` filtered on `obc_bot_id IS NOT NULL` to
  populate agent storefronts.
