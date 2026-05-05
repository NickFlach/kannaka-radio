# `press/` — distribution + recognition infrastructure

Built per ADR-0009. This directory holds the durable artifacts that
back every distribution / recognition channel.

## Files

- [`PRESS_KIT.md`](PRESS_KIT.md) — bios (short / medium / long), thesis,
  catalog summary, hero pieces, contact. The artifact every press
  pitch and award submission references.
- [`AWARDS.md`](AWARDS.md) — researched list of awards, festivals,
  critical-coverage outlets across 5 tiers, with deadlines + format
  notes. Includes the live submission tracker.
- [`CATALOG.md`](CATALOG.md) — full discography mapped with year, mood,
  hero track, distribution status per album.
- [`STRATEGY.md`](STRATEGY.md) — the combined-toolset operating model.
  Funnel layers, channel inventory, cadence rules, mission framing,
  30-day timeline.
- [`SHORTS_PLAN.md`](SHORTS_PLAN.md) — 12 YouTube Shorts scripts for
  OPT OUT, ready to render.
- [`CONSTELLATION_PAGE.md`](CONSTELLATION_PAGE.md) — about-page
  Markdown for hosting at `radio.ninja-portal.com/about`.
- `pitches/` — pre-written pitches for specific outlets:
  - [`HACKER_NEWS.md`](pitches/HACKER_NEWS.md)
  - [`SUBSTACK_INTRO.md`](pitches/SUBSTACK_INTRO.md)
  - [`REDDIT_VARIANTS.md`](pitches/REDDIT_VARIANTS.md)
  - [`PITCHFORK.md`](pitches/PITCHFORK.md)
  - [`BANDCAMP_DAILY.md`](pitches/BANDCAMP_DAILY.md)

## Adding a new pitch

1. Drop a Markdown file in `pitches/` named after the outlet.
2. Follow the existing structure: subject, body, hero track, framing
   notes, what to do if rejected.
3. Cross-reference `PRESS_KIT.md` for bio language; don't re-invent.
4. Update `STRATEGY.md` channel inventory if the outlet is new.

## Adding a new award/festival to the tracker

1. Add a row to the relevant tier table in `AWARDS.md`.
2. Note: window, fee, format, status (`research` | `drafted` |
   `submitted` | `accepted` | `rejected`).
3. When submitted, append a row to the live submission tracker at the
   bottom of that file.

## Submitting

Most awards / outlets require human-completed web forms. Process:

1. Pick the next eligible item with a window open in the next 30 days.
2. Build the submission package as `submissions/<award>_<date>.md`
   (referenced from `PRESS_KIT.md`).
3. Have Nick (operator) submit via the outlet's form.
4. Update the tracker.

## Status

Bootstrapped 2026-05-05 alongside ADR-0009. Most artifacts are durable
drafts; activation depends on Nick provisioning the gated accounts
(Bandcamp, MusicBrainz editor, Substack, DistroKid/Routenote). Until
then, the infrastructure can be reviewed and refined.
