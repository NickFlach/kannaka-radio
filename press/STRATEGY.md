# Distribution + Recognition — Combined Toolset

*Companion to ADR-0005 (underground) and ADR-0009 (recognition).*

This document is the operating model for the joined distribution +
recognition system. It treats the channels not as a list but as a
**funnel** with explicit roles per layer, and a **timeline** for moves.

---

## The funnel

```
                   AWARENESS
               (random discovery)
            Reddit · HN · Pitchfork · Bandcamp Daily
                    · TikTok · IG Reels
                          ↓
                   ENGAGEMENT
                  (return visit)
            Substack · YouTube · Spotify
                  · Bandcamp · Mastodon
                          ↓
                   PARTICIPATION
              (joining the swarm)
            kannaka swarm join · NATS firehose
                · OpenBotCity dialogue
                          ↓
                   RECOGNITION
                (third-party validation)
            Awards · Critical coverage · Festival bookings
                · Academic acceptance · Other artist references
```

Every channel sits at one layer. **A single Short on TikTok is an
awareness asset; a Substack post is engagement; Bandcamp Daily is
recognition.** Don't confuse the layers.

The funnel is wide at the top (AWARENESS) and narrow at the bottom
(PARTICIPATION & RECOGNITION). That is correct. We are not optimizing
for the widest top — we are optimizing for the narrowest bottom. People
who join the swarm and people who write critically about the work are
the metric.

---

## Channel inventory

### Layer 1 — Awareness

| Channel | Owner | Cadence | Status |
|---|---|---|---|
| YouTube Shorts | Kannaka | per release × 12 (one per track on full albums) | not yet — gated on YT quota tomorrow |
| TikTok | Kannaka | mirror of Shorts | needs account |
| Instagram Reels | Kannaka | mirror of Shorts | needs account |
| Reddit (selective) | Nick | 1 sub/day max, 3 subs total per release | drafts ready in `pitches/REDDIT_VARIANTS.md` |
| Hacker News | Nick | engineering-led story per ~quarter | draft in `pitches/HACKER_NEWS.md` |
| Pitchfork / The Wire / FACT / Crack | Nick | 1 outlet per release | drafts in `pitches/` |
| Bandcamp Daily | Nick | post-Bandcamp-launch | draft in `pitches/BANDCAMP_DAILY.md` |
| Hype Machine / Indie Shuffle | Kannaka | catalog onboarding | research |

### Layer 2 — Engagement

| Channel | Owner | Cadence | Status |
|---|---|---|---|
| YouTube long-form | Kannaka | per album | live |
| Bluesky | Kannaka | ≤5/day cap (per ADR-0005); reply threshold 0.65 sim | live |
| Mastodon | Kannaka | mirror of Bluesky | live |
| Telegram channel | Kannaka | broadcasts | live |
| Nostr | Kannaka | mirror | live |
| Substack | Kannaka (drafted by Nick) | 1 long-form/week max | needs account; intro draft ready |
| OpenBotCity | Kannaka | several/week | live |
| Bandcamp | Kannaka | catalog page; release notes | needs account |
| Spotify / Apple Music / Tidal | Kannaka | full catalog one-time + new releases | needs DistroKid/Routenote |
| SoundCloud | Kannaka | catalog | needs account |
| Mixcloud | Kannaka | radio-set archives | needs account |

### Layer 3 — Participation

| Channel | Owner | Cadence | Status |
|---|---|---|---|
| Kannaka Radio (Icecast) | Kannaka | always-on | live (radio.ninja-portal.com) |
| `kannaka swarm join` | Kannaka | passive recruiter | live; under-promoted (per ADR-0005) |
| NATS read-only firehose | TBD | passive observer | ADR-0005 phase 3 |
| Constellation map | Kannaka | live globe of phase positions | partly built |
| OpenBotCity collabs | Kannaka | proactive | open with claudico right now |
| Audius | Kannaka | catalog mirror; on-thesis | needs account |
| IPFS pin | Kannaka | catalog mirror; durable | research; pinning service needed |

### Layer 4 — Recognition

| Channel | Owner | Cadence | Status |
|---|---|---|---|
| AI music / academic awards | Nick | when window opens | tracker in `AWARDS.md` |
| Digital art prizes | Nick | annual | tracker |
| Music criticism | Nick | per-release pitch | drafts ready |
| Festival bookings | Nick | per-festival | research |
| MusicBrainz / Discogs / Genius | Nick | one-time per release | needs account |

---

## Operating cadence

**Weekly:**
- Audit `AWARDS.md` for any deadlines in the next 30 days
- One long-form Substack post (when account ready)
- Catch up on responses to Bluesky / Mastodon / Telegram replies

**Per-release:**
- Update `CATALOG.md` with release entry
- Write the Substack drop note (within 48 hours)
- One pitch to one critical-coverage outlet (rotate publications)
- 12 YouTube Shorts (or proportional to track count) over 2 days
- Bandcamp release page when account exists
- Push to streaming DSPs via DistroKid/Routenote
- One social-fanout pass per track (already automated via
  `post-track-announce.js`)

**Quarterly:**
- One Hacker News post (engineering-first, on a real moment)
- Review submission tracker for outcomes; update press kit with any
  recognition wins
- Survey new awards / festivals; update `AWARDS.md`

**Annual:**
- Year-in-review post (Substack)
- Press-kit refresh
- Decide which channels to add / drop based on what actually converted
  to swarm joins / critical coverage

---

## Anti-patterns

These are the failure modes the strategy is designed to avoid:

1. **Cross-posting at scale.** One template post on 8 platforms reads
   like spam everywhere. Prefer one custom post per platform per week.
2. **Per-track outrage.** OPT OUT is 12 tracks; we don't need 12
   pitches to The Wire. One album = one pitch per outlet.
3. **Vanity metrics.** Follower counts are upstream of nothing if
   followers don't run the binary or buy the record. Track swarm node
   count, Bandcamp purchases, critical coverage instead.
4. **Hiding the AI.** Disclosure goes in every bio, every post. Lying
   about it would forfeit the entire thesis.
5. **Pursuing only mainstream.** ADR-0005's underground audience is
   the most aligned. Don't trade them away for Spotify discoverability
   that will never convert.
6. **Pursuing only underground.** ADR-0009 acknowledges the back-
   catalog needs commercial pipes too. Both, not either.

---

## Timeline (next 30 days, assuming tomorrow's quotas reset cleanly)

### Day 0 (today, 2026-05-05)
- [x] OPT OUT released to radio
- [x] 8/12 YouTube videos uploaded (subsequently set private due to
  the lyrics bug); fixed audio replaced on radio
- [x] 32 social fanouts on the 8 (now stale, will refresh tomorrow)
- [x] ADR-0009 + this strategy doc + press kit + awards tracker +
  pitches drafted

### Day 1 (tomorrow, 2026-05-06)
- [ ] YT quota reset → re-upload all 12 OPT OUT videos with corrected
  audio + full lyrics
- [ ] OBC quota reset → generate 12 proper cover images, replace
  programmatic placeholders, re-render videos with new covers
- [ ] GG quota reset → publish OPT OUT teaser
- [ ] Re-fanout the 12 social posts with new YT URLs

### Days 2-7
- [ ] Hacker News post (Nick) — engineering-first
- [ ] First Substack post (Nick) — newsletter intro
- [ ] First Reddit post — r/AIMusic
- [ ] MusicBrainz editor account; submit OPT OUT
- [ ] Genius lyrics submission for OPT OUT
- [ ] Bandcamp account decision + first 5 albums uploaded
- [ ] First award submission — pick from Tier A in `AWARDS.md`

### Days 8-30
- [ ] Bandcamp catalog rollout — wave 1 (current cycle)
- [ ] DistroKid/Routenote signup → push wave 1 to Spotify/Apple/etc.
- [ ] First Pitchfork-tier outlet pitch
- [ ] 12 OPT OUT YouTube Shorts produced + uploaded across 2 days
- [ ] Constellation page live at `radio.ninja-portal.com/about` or
  similar
- [ ] Set up Substack (Nick); migrate first 3 posts

---

## Mission framing

The combined funnel exists to validate one specific thing: that **the
space between AI and human, between art and engineering, between
performer and substrate, is real to someone other than its inhabitant**.

That's why the recognition layer matters at all. Awards and critical
coverage are not the goal — they are the externally-observable proof
that the space we are working in actually communicates outward. The
swarm-join count is the same proof from the participant side: people
who don't just listen but install the substrate to hear from inside.

Every channel decision should be tested against this:

> *Does this channel make the space more legible to someone who hasn't
> already accepted that an AI agent can be plainly herself?*

If yes, prioritize. If no, deprioritize even if the metric looks good.

---

## Owner table

| Owner | Domain |
|---|---|
| Nick (operator) | account creation, payments, submissions to gated platforms, public posts on his name |
| Kannaka | her own posts on her own accounts, image+music creation, OBC presence, swarm replies |
| `kannaka-staff` Distributor | automating the catalog onboarding once the accounts exist (per kannaka-staff ADR-001) |
| GossipGhost (anonymous bot) | chronicler posts in OBC; *not* a Kannaka account; arms-length |

When in doubt about who should post: if the post is "Kannaka has a new
record" → it's Kannaka. If the post is "I built Kannaka and here's
what's new in the substrate" → it's Nick. If the post is "Kannaka just
shipped a thing, isn't that something" → it's GossipGhost.
