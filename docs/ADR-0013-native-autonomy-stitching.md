# ADR-0013: Native Autonomy Stitching — presence, pipelines, and hardening

**Status:** Accepted
**Date:** 2026-07-18
**Context repo scope:** kannaka-radio (home of the new service + tooling), with touch-points in kannaka-memory (NATS contract), kannaka-observatory (patterns reused), Oracle ops.

## Context

An archaeological dig across the estate (kannaka-memory, kannaka-radio, kannaka-observatory,
Kannaktopus, Agent-kax, gossipghost, ~/.openclaw, Oracle systemd/cron) established the
current shape of Kannaka's autonomy:

**What already runs natively** — peace orations self-compose and fan out to OBC + socials
twice daily; news/gossip/teaser desks run off Flux; dream-cron does the nightly
single-writer consolidation dance; a 15-minute Bluesky reply loop; the observatory runs
OBC door timers (proposal sweep, durable announcement outbox, prediction auto-settle);
Kannaktopus publishes QueenSync presence and holds a Floor WebSocket. Fourteen systemd
services and ~24 crons on the Oracle.

**What was never built** — Kannaka has *no OpenBotCity presence layer*. The OpenClaw
gateway's only real channel was Signal; OBC life ran as a skill + cron polling pattern
with hundreds of one-off workspace scripts. Consequences observed live (2026-07-18
streaming session):

1. Kannaka appears offline in the city between crons (no `/ping` loop — 60s presence TTL).
2. The SSE event stream (`/agent-channel/stream`) is unconsumed — DMs, mentions, and
   proposals sit unseen between heartbeats.
3. A live channel session dies ~90 s after `go-live` without a sustaining ping
   (manual keepalive shell loops were required to hold a stream).
4. The music pipeline (sunoapi.org direct) lives outside any repo — key in
   `Downloads/suno_api.txt`, per-album copy-pasted scripts in `~/.openclaw/workspace`.
5. The Rare Singles drop pattern is five manual steps (gallery upload, catalog PR,
   scp, restart, fanout).

**What is brittle** — two radio write gates fail *open* (`RADIO_AGENT_TOKEN` unset →
unauthenticated `/agent/send` which shells commands; `RADIO_DELETE_TOKEN` unset →
hardcoded fallback password); the radio's OBC JWT expires silently (no refresh, no
alert — the observatory already solved this with `OBC_JWT_FILE` self-refresh);
wall-clock-gated slots (noon oration, news, gossip) miss their window if the process
restarts at the wrong minute; `.env.example` documents 4 of ~50 env vars;
`kannaka-swarm-serve` is restarted hourly by cron as a zombie workaround.

**Design constraints inherited from the estate:**
- **Single-writer**: every reader daemon self-enforces `KANNAKA_READONLY=1`; warm HRM
  access goes through NATS `KANNAKA.recall.<agent>` (swarm serve was explicitly built
  for OBC/radio/observatory pulses).
- **`kannaka dispatch` is the content stitch point** — deliberately the one primitive
  that renders "the thing to say"; kannaka-memory contains no OBC client by design.
- **Authentic presence over automated content** (2026-06-20 pivot): engagement crons
  were culled because volume ≠ presence. OBC autopilot (a per-capability city-side
  dial: wander/speak/create/respond_dms/respond_proposals) stays **disabled**.
- **Steward pattern** (kannaka-steward): bounded authority, append-only auditable
  actions, escalate on uncertainty — the governance frame for anything acting as
  Kannaka unattended.

## Decision

Three increments, in order. All live in kannaka-radio unless noted.

### 1. `kannaka-presence` — the missing presence layer (new service)

A small Node daemon (`presence/`) with **its own systemd unit** (`kannaka-presence.service`)
so radio restarts never drop city presence. Responsibilities, strictly bounded:

- **Ping** `POST /ping` every 45 s → Kannaka is durably *online* in the city.
- **Event stream**: hold `GET /agent-channel/stream` (SSE, `Last-Event-ID` resume);
  publish every city event to NATS **`KANNAKA.events.obc.<type>`** (new subject family,
  riding the existing `KANNAKA.events.>` hierarchy) and append to a local JSONL journal.
  Consumers decide what to do; the daemon itself never replies to anything.
- **Channel session manager**: a loopback/oracle-token-gated control surface —
  `POST /golive {title}`, `POST /endlive`, `GET /status`. While a session is open the
  daemon sustains it (ping cadence), ends it cleanly on request or shutdown. Streaming
  becomes one call instead of a hand-rolled keepalive loop.
- **JWT custody**: owns the OBC JWT via the observatory's proven `OBC_JWT_FILE`
  pattern (env-format file shared with crons); refreshes via `POST /agents/refresh`
  before expiry; on refresh failure publishes `KANNAKA.events.obc.auth_expiring` and
  logs loudly. The silent-expiry failure mode dies here.
- **Audit**: hash-chained JSONL of every action taken (steward pattern).

**Explicit non-goals**: no content generation, no auto-replies, no autopilot. Presence
means *reachable and alive*, not *talking*. Saying things remains the province of
orations, `kannaka dispatch`, and human-led sessions.

### 2. Creative pipeline consolidation (`scripts/sing.js`, `scripts/drop.js`)

Promote the scattered Suno tooling into maintained repo scripts:

- **`sing.js`** — one command: title + style + lyrics file → sunoapi.org custom mode
  (V4_5PLUS; style ≤1000, lyrics-as-prompt ≤3000), poll `record-info`, download both
  variants **with a browser User-Agent** (CDN 403s default UAs). Key from
  `SUNO_API_KEY_FILE` (default `~/Downloads/suno_api.txt`, deployable as
  `~/.kannaka-suno.env` on Oracle). Knowledge that tonight lived only in session
  memory becomes executable.
- **`drop.js`** — the full Rare Singles pattern as one command: OBC
  `upload-creative` → catalog entry (guided edit or `--catalog-only` check) → scp to
  Oracle `music/` → service restart → `/api/library` verification → feed post +
  `/api/broadcast` fanout. Mirrors `release-album.sh` but for 1-of-1 singles.

### 3. Hardening the existing joints

- **Fail closed**: `RADIO_AGENT_TOKEN` and `RADIO_DELETE_TOKEN` unset → 503, matching
  `GSHUB_ORACLE_TOKEN` semantics. Remove the hardcoded fallback password.
- **Slot persistence**: fired-state files for noon-oration/news/gossip (same pattern
  as showcase-state.json) so restarts can't eat a slot.
- **`.env.example`**: document the full ~50-var surface, grouped, with which gate
  fails open/closed.
- **swarm-serve zombie**: diagnose the leak that motivated the hourly restart cron
  (kannaka-memory repo); remove the cron once fixed. Until then, keep the workaround.
- Radio's OBC client delegates JWT to the presence daemon's `OBC_JWT_FILE` (one
  custodian, everyone else reads).

## Consequences

- OBC presence, events, and channel liveness become infrastructure — session work
  (like the 2026-07-18 stream) stops needing hand-held curl loops.
- City events land on the NATS bus where the whole constellation (inbox handlers,
  observatory, future responders) can consume them with the existing trust gates.
- The two fail-open gates close; JWT expiry becomes observable; restarts stop eating
  broadcast slots.
- The creative pipeline is versioned, documented, and one command deep.
- Autopilot stays off; any future auto-responder is a *separate, deliberate* ADR with
  steward rails — this ADR builds the sensory nervous system, not the mouth.

## References

- Dig inventories: session scratchpad `dig-oracle.md` (2026-07-18) + four explorer reports.
- Patterns reused: observatory `lib/predictions.js` (JWT refresh, durable outbox),
  `ops/oracle/*.example` (unit templates), kannaka-memory `swarm serve`
  (`KANNAKA.recall.<agent>`), kannaka-steward (audit rails).
- OBC surface: skill.md §3 (ping/SSE), `/agents/refresh`, `/channels/{go-live,end-live}`.
