---
name: "Album Release Pipeline"
description: "Ship a complete Kannaka album in one run: write/cache lyrics, render tracks via Suno direct API, paint one cover per song in the OpenBotCity Pixel Atelier, build a 1080p album film with karaoke subtitles, upload to YouTube, deploy to the radio, and premiere it on air (optionally right after a Peace Oration). Use when releasing a new album, re-running a failed phase, or timing an on-air album premiere."
---

# Album Release Pipeline

One config JSON in, a released album out: audio, art, film, YouTube,
radio deploy, on-air premiere, social announce. Built around
`scripts/release-album.sh`, whose phases are all idempotent — re-run the
script after any failure and it resumes where it stopped.

Proven end-to-end 2026-07-04: THE FREQUENCY OF FREEDOM (7 songs) went
from blank page to on-air premiere in ~2.5 hours.

## What This Skill Does

1. **Music** — `suno_album_builder.sh` (external, see config) renders each
   track via Suno V4_5PLUS custom mode, two variants per track, resumable
   via a per-track ledger.
2. **Art** — enters the OpenBotCity Pixel Atelier and generates one cover
   per track from `art_prompt` (75 s spacing to dodge the creative-loop
   detector), then downloads the PNGs from the gallery.
3. **Film** — fetches Suno timestamped lyrics → per-track ASS karaoke
   subtitles → ffmpeg-assembles a 1920×1080 album slideshow (one cover
   per song, lyrics burned in).
4. **Publish** — uploads the film to YouTube (public), deploys MP3s to the
   radio host, restarts the service, and fans out the announce post.

## Prerequisites

- Album registered in `server/dj-engine.js` `ALBUMS` (exact track titles)
  and routed into a `server/programming.js` block — commit + push, because
  the deploy phase does `git pull` on the radio host. Preflight aborts if
  the album name is missing from dj-engine.js.
- Suno API key, OBC JWT (`~/.openbotcity/credentials.json`), YouTube OAuth
  (repo root `.youtube.json`), SSH key for the radio host — paths wired in
  `release-album.sh` and the config's `release` block.
- ffmpeg + ffprobe, Python 3, Node 18+.

## Quick Start

```bash
# 1. Write the config (schema documented at the top of release-album.sh):
#    name, out_dir, ledger, theme, default_style,
#    tracks[{title, style, art_prompt}], release{lead_track, youtube_*,
#    tracker_url, oracle_host, oracle_music_dir, ssh_key}

# 2. OPTIONAL but recommended — write the lyrics yourself:
#    pre-create <out_dir>/lyrics_<safe_title>.txt for each track
#    (safe_title = spaces→_, /→-, apostrophes deleted). Any cache file
#    >100 chars is used verbatim; otherwise HRM-generated lyrics.

# 3. Register the album in dj-engine.js + programming.js, commit, push.

# 4. Run it (Windows-style path is REQUIRED — see gotchas):
bash scripts/release-album.sh "C:/Users/<you>/.openclaw/workspace/my-album.json"

# Phase gate: skip phases you want to control by hand
RELEASE_SKIP="deploy,announce" bash scripts/release-album.sh "<config>"
```

## Timing an on-air premiere

To premiere the album at a specific moment (e.g. right after the noon
Peace Oration):

1. Run the pipeline with `RELEASE_SKIP="deploy,announce"`.
2. Deploy early by hand — `copy-music`/`deploy` normally run AFTER the
   ~9-minute art phase, so if you are racing a clock, scp the
   `<out_dir>/<safe_title>_v1.mp3` files to the host's music dir yourself
   (renamed to exact `"<Title>.mp3"`), `git pull`, restart the radio.
3. Fire the ceremony:
   ```bash
   curl -G -X POST "http://localhost:8888/api/album/showcase" \
     --data-urlencode "album=<ALBUM NAME>" \
     --data-urlencode "duration=45" \
     --data-urlencode "struggles=<the real making-of story — feeds the narration>"
   ```
   The endpoint returns 202, composes an intro + per-track bridges +
   closing (~90 s), then locks the album override. To sync with an
   oration, watch the radio journal for `Peace oration slot reached` and
   fire ~90 s later. If strict oration-first ordering matters, wait for
   `Peace oration complete` instead — the showcase intro can otherwise
   air before a slow oration.

## Gotchas (each one caused a real fire)

- **Windows paths**: the config arg must be `C:/Users/...` style — the
  embedded Python rejects MSYS `/c/Users/...` and the builder silently
  no-ops.
- **Apostrophes**: album-level `theme` and `default_style` are
  interpolated into single-quoted inline Python in the Suno builder —
  keep them apostrophe-free. Per-track fields and lyrics are safe.
- **Art prompts**: diversify medium/palette/subject across the batch or
  OBC's creative-loop detector 429s. One medium per song works well
  (linocut / screenprint / gouache / oil / travel poster / ink / digital).
- **OBC endpoint**: raw curl must hit `/artifacts/generate-image` and
  `/buildings/enter` — the `/actions/*` forms are MCP-only and 404.
- **YouTube**: verify the upload really exists afterwards
  (`https://www.youtube.com/oembed?url=...`) — uploads can vanish after a
  200.
- **Peace Oration TTS is one-shot**: if its persona TTS fails, it posts
  the text and marks complete with no retry — the album premiere is
  unaffected, but the oration goes silent for that slot.
- **SSH**: batch remote work into few sessions (the host's fail2ban bans
  connection churn); ControlMaster does NOT work from Windows OpenSSH.

## Reference

- Pipeline: `scripts/release-album.sh` (phase list + config schema in its
  header comments)
- Transcription: `scripts/release-album-transcribe.py`
- YouTube upload: `scripts/release-album-upload-youtube.js`
- Announce: `scripts/post-track-announce.js` (runs on the radio host,
  where the social credentials live)
- Sibling skill: `skills/podcast-video-publisher/` (episode videos +
  playlist management)
