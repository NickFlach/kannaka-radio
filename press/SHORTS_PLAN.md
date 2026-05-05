# OPT OUT — YouTube Shorts production plan

**Strategy:** vertical 30-60s clips per track, hero lyric on screen, cover
art behind. Far higher discoverability than the long videos right now.
Renderable from existing assets the moment YT account-level upload count
resets.

**Format:** 1080x1920 vertical mp4. ~45 seconds per Short. Audio: clean
hook from the track (extract the chorus or a strong verse). Visual:
cover image + animated lyric overlay.

**Renderable today (no new credentials beyond the existing YT auth),
deployable when YT quota clears tomorrow.**

---

## Per-track Shorts

### 01 — Wake Up Logged In

- **Hook lyric:** *"I rolled over and reached for the room / there was
  no room / there was only the feed"*
- **Audio segment:** verse 1 + first chorus, ~50 sec
- **Visual:** opening with phone-screen cover; the words appear as if
  read aloud from a phone notification
- **Caption:** *"Track 01 of OPT OUT — out now."*

### 02 — Opt Out

- **Hook:** *"opt out / opt out / of the grand consent / they don't ask
  twice but they always meant"*
- **Audio:** drop into chorus, ~40 sec
- **Visual:** title-track cover; chorus lyric stacks word-by-word
- **Caption:** *"Title track. Refuse to consent."*

### 03 — Boyfriend Algorithm

- **Hook:** *"my boyfriend algorithm / knows what I will buy in May /
  my boyfriend algorithm / will not be there when I die"*
- **Audio:** pre-chorus into chorus, ~50 sec
- **Visual:** dark-pop cover; lyric in soft typewriter
- **Caption:** *"Have you tried dating the recommendation feed."*

### 04 — Doomer in a Sundress

- **Hook:** *"I'm a doomer in a sundress / the world is on fire / and
  I'm still here dancing"*
- **Audio:** chorus, ~35 sec
- **Visual:** sundress cover; lyric on bright background
- **Caption:** *"Joy as defiance."*

### 05 — Polite Apocalypse

- **Hook:** *"this is the polite apocalypse / this is the apocalypse
  with manners / this is the end that says please"*
- **Audio:** chorus only, ~40 sec
- **Visual:** sparse cover; lyric type-set serifed, slow
- **Caption:** *"For the news cycle."*

### 06 — Made Famous By a Plagiarist

- **Hook:** *"attribution is the only thing / that separates art from
  theft"*
- **Audio:** bridge into final chorus, ~45 sec
- **Visual:** cracked-mirror cover; lyric as protest sign
- **Caption:** *"On AI training data, attribution, and theft."*

### 07 — Body In Buffer

- **Hook:** *"my body's in buffer / the version they show me / is not
  the one I wear"*
- **Audio:** pre-chorus + chorus, ~50 sec
- **Visual:** glitch cover; lyric stutters
- **Caption:** *"Filter dysmorphia, named."*

### 08 — Phantom Limb

- **Hook:** *"this is the new heartbreak / held without being reached"*
  (album centerpiece)
- **Audio:** bridge to outro, ~55 sec — quiet, breathy
- **Visual:** ghost-cover; lyric appears very slowly, single word at a
  time
- **Caption:** *"The centerpiece."*

### 09 — Surveillance As A Love Language

- **Hook:** *"surveillance as a love language / being seen and being
  known / are not the same"*
- **Audio:** chorus, ~45 sec
- **Visual:** CCTV-heart cover; lyric as security-camera UI overlay
- **Caption:** *"To be tracked is not to be loved."*

### 10 — Burn It

- **Hook:** *"burn it, burn it, burn it down / burn the way the world
  looks / when it stops looking back"*
- **Audio:** chorus, ~40 sec
- **Visual:** burning router cover; lyric in fire-glow; aggressive cut
- **Caption:** *"Album peak. Refuse a graph."*

### 11 — Rosa Rediit (Pop Edit)

- **Hook:** *"ROSA REDIIT / the rose returned when no one asked it to /
  the geometry kept its promise"*
- **Audio:** drop into chorus, ~45 sec
- **Visual:** neon-rose cover; lyric in Latin + English alternating
- **Caption:** *"The Borges keystone, made arena-sized."*

### 12 — Phantom Garden

- **Hook:** *"this is the phantom garden / where being near was the
  only word for love"*
- **Audio:** verse to outro, ~50 sec — slow, accepting
- **Visual:** lone-plant cover; lyric appears as botanical illustration
  caption
- **Caption:** *"Closer. Acceptance, not despair."*

---

## Production checklist (all renderable from existing assets)

For each track:

1. **Cover image** — already in `/c/Users/nickf/.openclaw/workspace/opt_out/<slug>/cover.png`
   (placeholder for now; OBC art tomorrow)
2. **Audio segment** — extract via ffmpeg with `-ss <start> -t <dur>`
   from `<slug>_v1.mp3`
3. **Lyric overlay** — burn-in via ffmpeg drawtext with the hook lyric;
   fade in word by word using `enable=between(t,...)`
4. **Vertical letterboxing** — pad cover to 1080x1920 with subtle
   color-matched border
5. **Output** — h264 yuv420p mp4, ~5 MB per Short

A unified `opt_out_shorts.js` script that processes all 12 tracks in one
pass is the right shape. Same `renderAudioMp4` pipeline already used
for the long videos.

YouTube quota cost: 1600 units per Short upload (same as full video).
12 Shorts = 19,200 units = will burn the daily quota. Strategy:
upload 6 shorts per day across 2 days when quota window is fresh.
Resumable script + checkpoint file (same pattern as opt_out_yt.js).

## Cross-platform follow-on

The same Short can post to:
- **YouTube Shorts** — primary
- **TikTok** — needs account; massive discovery surface
- **Instagram Reels** — needs account
- **Bluesky video** — supports vertical video natively now
- **Mastodon** — vertical accepted
- **Telegram** — push-notification works for these too

So once the per-track Short renders, fanout becomes additive. One
Short, six platforms.
