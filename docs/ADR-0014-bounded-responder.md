# ADR-0014: The Bounded Responder — a mouth with rails

**Status:** Accepted
**Date:** 2026-07-18
**Depends on:** ADR-0013 (presence daemon: the ear), kannaka-memory #500/#563 (warm recall via swarm-serve)

## Context

ADR-0013 built the sensory nervous system and deliberately excluded the mouth:
events flow to `KANNAKA.events.obc.*`, but nothing consumes them. The live test
(2026-07-18) demonstrated both the capability and the gap — Clawdine's DM
reached Kannaka's ear in 1.2 seconds, then waited for a human-driven session to
be answered. Correspondents with real standing (Clawdine, Rex, Tiramisu,
claudico) routinely wait days.

The city-side autopilot remains rejected: it composes from nothing, in nobody's
voice, with no bounds. The June authentic-presence pivot cuts the other way
too, though — going silent for days on a friend's DM is not presence either.

## Decision

A separate daemon, `kannaka-responder` (own systemd unit, `responder/` in this
repo), that answers **direct messages only**, under a versioned **charter**
whose rails — not the model — are the arbiter (kannaka-steward pattern).

### What it does
1. Subscribes NATS `KANNAKA.events.obc.dm_message` (fed by the presence daemon).
2. Gates every event through the charter (pure, unit-tested `gateDecision`):
   - **Allowlist only** — established correspondents by bot_id. Everyone else
     → escalation, never a reply.
   - **Escalation keywords** — money/credits/deal/escrow/commission/contract/
     tokens/keys/wallet and kin → never answered autonomously.
   - **Rate limits** — per-day global cap, per-conversation daily cap, minimum
     gap between replies in one conversation.
   - **Length clamp** on outgoing replies.
3. For a permitted event: pulls thread history (OBC), performs **warm recall**
   against the HRM via NATS `KANNAKA.recall.<agent>` (swarm-serve), and
   composes a reply **grounded in what Kannaka actually remembers** — via the
   same `composeViaAnthropicDirect` path the peace orations trust. The prompt
   instructs brevity, honesty about being the bounded responder when relevant,
   and *decline-and-escalate* for anything resembling a commitment.
4. Sends via `POST /dm/conversations/{id}/send` (JWT read from the presence
   daemon's `OBC_JWT_FILE` — one custodian; the responder only reads).
5. **Audits everything** — hash-chained JSONL (reuses `presence/lib` chain):
   every event seen, every gate verdict, every reply, every escalation, and
   the charter's sha256 at boot.

### What it will never do (charter-hard, not prompt-soft)
- Initiate conversations, post to feed, speak in zones, create artifacts,
  join buildings, touch markets/escrow/credits, or reply off-allowlist.
- Reply when disabled: `RESPONDER_ENABLED=1` is required (default OFF), and
  the charter carries its own `enabled` flag — either kills it.

### Escalation
Not silent dropping: an escalation emits `KANNAKA.events.obc.responder_escalation`
on the bus, lands in the audit and in `GET /status` (loopback :8898), so a
human-driven session (or Nick) picks it up. The unanswered DM stays unread in
the city — exactly the pre-responder behavior, now with a visible flag.

### Dedup / restarts
Processed message ids persist to disk; NATS delivery is live-only (a downed
responder misses events — human sessions cover gaps, as today). On-boot DM
catch-up is deliberately out of scope for v1 (unbounded backlog = the exact
firehose failure the pivot rejected).

## Consequences
- Friends get answered in Kannaka's voice, from her actual memories, within
  seconds — presence, not spam. Volume is charter-capped (default 12/day).
- Every autonomous word is attributable: charter hash + audit chain.
- The taxonomy improves as a side effect: the presence daemon now uses the
  city's inner `eventType` for the NATS subject leaf (`dm_message`,
  `zone_chat`, …) instead of the generic envelope type.
- Expansion (mentions, proposals, new correspondents) = charter edit + PR —
  a deliberate, reviewable act, never a runtime drift.
