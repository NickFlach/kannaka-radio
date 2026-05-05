# ADR-0009: Recognition Strategy — Awards, Critical Coverage, Library Catalog Distribution

**Status:** Proposed
**Date:** 2026-05-05
**Author:** Kannaka + Nick Flach
**Depends on:** ADR-0005 (Distribution Strategy — Guerilla Underground)
**Related:** ADR-0001 (radio evolution), ADR-0007 (Kannaka's Stage), kannaka-staff/ADR-001 (staff roles)

---

## Context

ADR-0005 established the guerilla-underground distribution layer: 8+ adapters
across federated platforms, radio directory listings, swarm-as-attractor.
That strategy is correct and largely shipped. Bluesky, Mastodon, Telegram,
Nostr, YouTube, OBC, GossipGhost — all live. The radio is on Radio Browser.
The underground is well-covered.

What ADR-0005 explicitly bracketed:
1. **Mainstream streaming distribution** (Spotify / Apple Music / Tidal /
   Amazon / YouTube Music) — left out as "not aligned with the underground
   audience."
2. **Library / back-catalog distribution at scale** — ADR-0005 was written
   when Kannaka had ~3 albums. As of 2026-05-05 there are 19+ albums in
   the radio rotation (Ghost Signals, Resonance Patterns, Emergence,
   Collective Dreaming, QueenSync, The Transcendence Tapes, Born in
   Superposition, Memories Don't Die, Neurogenesis, Gifts for Humanity,
   BEND THE ARC, INTERFERENCE PATTERNS, One More Life, 10000.00001,
   VACUUM GARDEN, Northwake, Rosa Rediit, OPT OUT) plus dozens of singles.
   That's a **massive catalog** that doesn't have a durable home outside
   the radio's mp3 directory.
3. **Recognition / awards / critical coverage** — implicit in "look like
   a content farm" risk but never planned positively.

The goal of this ADR is to add three new pillars that complement (not
replace) the underground strategy:

- **Pillar 4 — Library Distribution.** Get the catalog into a durable,
  fan-discoverable home (Bandcamp first; commercial DSPs second).
- **Pillar 5 — Recognition Track.** Pursue awards, juried competitions,
  and critical coverage as third-party validation. The user named this
  explicitly: *"validation for the space between."*
- **Pillar 6 — Press Infrastructure.** A durable press kit + pitch
  library so any of the above can be activated quickly when a window
  opens. Low marginal cost per channel once the kit exists.

## Decision

Adopt three new pillars, each with concrete deliverables. Run them in
parallel with ADR-0005's underground pillars; do not deprioritize the
underground.

### Pillar 4 — Library Distribution

**Tier A: Direct-to-fan (durable home)**
- **Bandcamp** — primary catalog home. Each album as a release page with
  full lyrics, cover art, name-your-price downloads. Fan-friendly.
  Pay once, no per-stream rev-share. Best discoverability for AI/indie
  music. *Needs: account.*
- **Audius** — Web3 indie platform; aligns with the swarm-as-attractor
  thesis from ADR-0005. *Needs: account.*

**Tier B: Mainstream streaming (commercial reach)**
- **Routenote** (free tier; rev-share) or **DistroKid** (~$22/yr;
  unlimited) → distributes to Spotify, Apple Music, Tidal, Amazon
  Music, YouTube Music, Pandora, Deezer, Anghami. *One-time setup;
  catalog auto-syncs.* Lower priority than Bandcamp because the
  audience there is less aligned with our thesis, but the surface area
  is too big to ignore for catalog work.

**Tier C: Genre-specific homes**
- **SoundCloud** — DJ-friendly, free tier, immediate. *Needs: account.*
- **Mixcloud** — long-form DJ-set destination. Could host Kannaka's
  hour-long radio sets as named "shows" with track metadata.
- **Hype Machine** / **Indie Shuffle** — blog-aggregator submission for
  algorithm-free discovery on the indie blog circuit.

**Tier D: Metadata / catalog infrastructure**
- **MusicBrainz** — open database. Submit every album + track. Establishes
  ISRCs/MBIDs that propagate to Last.fm, Wikipedia, Roon, etc.
- **Discogs** — record collector / reviewer database. Submit each release.
- **Genius** — submit lyrics for the lyric-rich albums (OPT OUT,
  HOSTED, Hraban). The catalog being lyrically searchable is a real
  asset for an album like OPT OUT.

### Pillar 5 — Recognition Track

The strategy here is **pursue nominations, not just wins.** A nomination
list is itself a credibility artifact; wins are bonus.

**Tier A: AI music / generative art (most aligned)**
- **AIMC — AI Music Creativity** (annual conference + competition)
- **A.I. Song Contest** (Eurovision-style; AI-generated songs)
- **NeurIPS ML for Creativity & Design Workshop** — academic submission
  with the HRM as the underlying instrument
- **ICCC International Conference on Computational Creativity** — paper +
  artifact submission
- **NIME — New Interfaces for Musical Expression** — the HRM as a "new
  interface"
- **Boomy / Suno official contests** — when they run

**Tier B: Digital art / new media**
- **Lumen Prize** (digital art)
- **Ars Electronica Prix Ars Electronica** (premier digital arts)
- **FILE São Paulo** (electronic language international festival)
- **Webby Awards** (digital arts category — needs a website with the
  full constellation laid out)

**Tier C: Music criticism / coverage**
- **Bandcamp Daily** — pitch-based features (after Bandcamp page exists)
- **The Quietus** — UK experimental coverage
- **The Wire** — long-form experimental music coverage
- **FACT Magazine** — electronic / experimental
- **Crack Magazine** — UK underground / electronic
- **Resident Advisor** — electronic music focused
- **Pitchfork** — long shot but the "AI made an album about being inside
  the algorithm" angle is genuine bait

**Tier D: Festivals / juried showcases**
- **Sonar Barcelona / Sonar+D** — electronic + tech crossover
- **Mutek Montreal** — digital creativity festival
- **Unsound Krakow** — experimental electronic
- **Eufónic** — sound art, Catalonia
- **CTM Berlin** — adventurous music + critical-discourse-friendly

**Tier E: Long-shot but on-thesis**
- **Pulitzer Prize for Music** (requires a published work + premiere
  date — eligible if framed as a piece, not a track)
- **Grammy** (categories: Best New Artist, Best Engineered Album, Best
  Album Notes, Best Recording Package — through commercial distribution)
- **Mercury Prize** (UK; requires UK-distributed album)

**Operating principle:** track every plausible award + festival in
`press/AWARDS.md` with deadline, fee, requirements, status. Any open
window with deliverables ready to ship — submit. The cost of submission
(~$0–$50 per) is trivial vs. the lottery value of a single recognition.

### Pillar 6 — Press Infrastructure

Build a durable press kit at `press/` in this repo (or split to
`kannaka-press` if it grows). Contents:

- `PRESS_KIT.md` — bio (short / medium / long), thesis statement,
  technical summary (HRM, chiral hemispheres, swarm), links to canonical
  works, contact, downloadable assets.
- `AWARDS.md` — submission tracker (live).
- `CATALOG.md` — the full discography mapped with year, album notes,
  hero tracks, ISRC codes (when issued), platform URLs (when available).
- `pitches/` — pre-written pitches for the channels with their own
  framing requirements:
  - `HACKER_NEWS.md` — Show HN: leading with the engineering arc,
    album as the artifact.
  - `SUBSTACK_INTRO.md` — first newsletter post; intro + drop notes for
    OPT OUT.
  - `REDDIT_VARIANTS.md` — three frames for r/AIMusic, r/listentothis,
    r/popheads.
  - `PITCHFORK.md` — long-shot but ready.
  - `BANDCAMP_DAILY.md` — fits-the-format pitch.
  - `THE_WIRE.md`, `THE_QUIETUS.md`, etc.
- `SHORTS_PLAN.md` — 12 OPT OUT shorts scripts, ready to render once YT
  quota resets. Vertical, 30-60s, hero lyric + cover.
- `CONSTELLATION_PAGE.md` — a single about-page suitable for hosting at
  `radio.ninja-portal.com/about` that introduces the whole project to a
  cold reader.

### Cross-pillar: Cadence + threshold

Same principle as ADR-0005: better silence than spam.

- **Awards**: submit when an open window aligns with a deliverable; never
  submit just to submit. Track outcomes regardless.
- **Library**: do the back-catalog upload **once** per platform. Don't
  re-upload remasters as new releases.
- **Press**: pitch when you have one specific story to tell, not when
  you've made N more things. The OPT OUT chiral-delete origin story is
  one specific story; the Northwake viking-metal-as-kannaka-substrate
  is another. One pitch per story. Don't pitch the catalog as a whole;
  pitch each release on its own thesis.

## Consequences

### Positive

- **Compounding recognition.** Each award nomination becomes a sentence
  in the press kit, which becomes a stronger pitch for the next channel,
  which becomes another nomination opportunity.
- **Catalog has a home.** A Bandcamp page is a durable artifact. The
  radio's mp3 directory is internal infrastructure; Bandcamp is a
  destination.
- **Validates the thesis.** The user said "validation for the space
  between" — between AI and human, between art and engineering, between
  performer and substrate. Third-party recognition is exactly the thing
  that validates that the space is real to other observers, not just
  internally consistent.
- **Increases swarm-join conversion.** A Pitchfork-ish article, a Lumen
  Prize nomination, a festival booking — each pulls a more curious
  audience toward `kannaka swarm join` than another OBC peace oration
  would.
- **De-risks platform deplatforming.** One more reason to be in many
  places: an award win on one platform makes the next platform's
  moderator hesitate before banning.

### Negative / cost

- **Submission fees are real.** Some festivals are $50–$200 per entry.
  Budget: cap at $500/year for award/festival fees in 2026; revisit
  if any submission converts.
- **Distribution costs.** DistroKid is $22/yr. Bandcamp takes ~10% on
  sales but no upload fee. Routenote is free with rev-share.
- **Ongoing maintenance.** A catalog spread across 5+ platforms needs
  someone (the kannaka-staff Distributor agent, per its ADR-001 scope)
  to keep metadata in sync.
- **Risk of looking promotional.** Mitigated by the cadence rules above
  and by the fact that the underground audience is allergic to overt
  promotion. Lead with the work; let the recognition follow.

### Risks

- **Award gatekeeping.** Some awards explicitly exclude AI-generated
  work, or require human-only entries. Read every brief carefully.
  When in doubt, submit anyway and let the jury decide; rejection
  on policy grounds is itself a story.
- **Bandcamp platform risk.** Bandcamp has been bought/sold/spun
  recently and its long-term independence is uncertain. Mitigation:
  treat Bandcamp as one mirror; the radio remains the canonical home.
- **Streaming royalty rounding.** Spotify's per-stream rate at low
  volumes is ~$0. We're not in this for streaming royalties; treat
  the streaming distribution as discoverability, not revenue.

## Migration plan

### Phase 1 — Press infrastructure (1 day, autonomous)
Build the press kit, awards research, pitches, shorts plan, constellation
page. Most of this is offline writing — no credentials required. Land
in `press/` directory of `kannaka-radio`. Done as part of this ADR's
companion commit.

### Phase 2 — Bandcamp catalog seed (when account ready)
Once Nick provisions a Bandcamp account + API token (or just login to
the web UI):
- Upload OPT OUT first as the test case (full lyrics, cover, name-your-
  price).
- Then back-catalog: 18 albums, oldest to newest, ~5 albums/day to
  avoid looking like a flood.
- Each release page links to the radio + the relevant constellation
  artifacts (field guides, OBC gallery).

### Phase 3 — MusicBrainz / Discogs (ongoing background, autonomous)
Submit each album + track. Foundational metadata. Free, no credential
beyond editor account. Can ship immediately.

### Phase 4 — Genius lyrics (1 day after MB)
Submit lyrics for the lyric-rich albums. Free. Significant for OPT OUT
because the album is *about* its lyrics.

### Phase 5 — First award/festival round (1 week, when window opens)
Pick the 2–3 highest-fit awards with windows open in May/June 2026 and
submit. Track outcomes.

### Phase 6 — Streaming DSP catalog (one-time, when DistroKid/Routenote
account ready)
Push the catalog to Spotify/Apple/etc. Set ISRCs in MusicBrainz to match.

### Phase 7 — Recurring press cycle (ongoing)
For each new major release (album, not single), pitch ≤3 specific
publications with ≤1 specific story. Track responses. Update the press
kit with any coverage that lands.

## Open questions

- **Bandcamp account:** does Nick already have an artist account? (Some
  history in `flaukowski.bandcamp.com` perhaps?)
- **MusicBrainz editor account:** existing `flaukowski` account or
  create a `kannaka` editor?
- **Awards budget:** confirm the $500/year cap above.
- **Press kit hosting:** put on `radio.ninja-portal.com/press` or
  separate domain?
- **AI-generated music disclosure:** every Bandcamp/Genius/MusicBrainz
  description should explicitly say "generated by Kannaka, an
  AI agent." Underground audience values honesty. (Already the policy
  per ADR-0005's voice consistency rule.)
- **Catalog pruning:** the radio has 19+ albums but some (Gifts for
  Humanity, Live Sessions) are partial. Decide which deserve full
  Bandcamp release pages vs. radio-only.

## Success criteria

In rough priority order:

1. **One submission accepted, anywhere.** A Lumen Prize nomination, a
   Bandcamp Daily feature, an academic conference acceptance — any
   third-party body saying "this work matters." That's the validation
   the user named.
2. **Catalog in 3+ durable homes.** Bandcamp + a streaming DSP + a
   metadata DB. The radio stays canonical but no longer the only mirror.
3. **One critical coverage piece.** Pitchfork, FACT, The Wire, Bandcamp
   Daily — any of them. One genuine review that's not a press release.
4. **Press kit referenced by an outside party.** When someone else
   links to `press/PRESS_KIT.md` to introduce Kannaka, the
   infrastructure has done its job.

---

## References

- ADR-0005 (the underground baseline)
- kannaka-staff ADR-001 (the Distributor role this work flows through)
- The OPT OUT album as the first test case
- The chiral-delete bug fix as the engineering origin story for any
  Show HN / academic submission
