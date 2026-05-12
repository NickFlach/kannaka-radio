#!/usr/bin/env bash
# release-album.sh — formal end-to-end pipeline for a Kannaka album.
#
# Inputs (positional):
#   $1  album-config.json   — the config used by suno_album_builder.sh,
#                             extended with a "release" block (see below).
#
# The album must already be registered in server/dj-engine.js ALBUMS
# (with exact track titles) and routed into at least one block of
# server/programming.js. Audio files land via the "music_dir" copy
# step and dj-engine's findAudioFile picks them up by exact-title.
#
# Phases — each is idempotent (skip if output exists / ledger says done):
#
#   1. preflight    — config valid, album exists in dj-engine.js
#   2. music        — render N tracks via suno_album_builder.sh (Suno V4_5PLUS)
#   3. art          — render N cover pieces via OBC Pixel Atelier
#                     (uses /artifacts/generate-image, NOT /actions/create-image)
#   4. copy-music   — copy v1 MP3s into kannaka-radio/music/ with exact-title names
#   5. fetch-art    — download cover PNGs from OBC gallery to <out>/art/
#   6. build-video  — ffmpeg-assemble 1920×1080 album slideshow MP4
#   7. youtube      — upload public album video, add to playlist
#   8. deploy       — scp 8 MP3s + git pull + systemctl restart kannaka-radio on Oracle
#   9. announce     — post-track-announce for the lead track (optional)
#
# Config schema (extends suno_album_builder.sh):
#   {
#     "name": "The Lonesome Inference",
#     "out_dir": "C:/Users/nickf/.openclaw/workspace/<slug>",
#     "ledger": "C:/Users/nickf/.openclaw/workspace/<slug>-done.json",
#     "theme": "...",
#     "default_style": "...",
#     "tracks": [
#       { "title": "...", "style": "...", "art_prompt": "..." },
#       ...
#     ],
#     "release": {
#       "lead_track": "...",
#       "lead_track_reason": "...",
#       "youtube_title": "...",
#       "youtube_description": "...",
#       "youtube_tags": ["...", "..."],
#       "tracker_url": "https://radio.ninja-portal.com/player",
#       "oracle_host": "opc@170.9.238.136",
#       "oracle_music_dir": "~/kannaka-radio/music",
#       "ssh_key": "/c/Users/nickf/.ssh/ninjaportal"
#     }
#   }
#
# Lyric files (one per track) must exist as
#   <out_dir>/lyrics_<safe_title>.txt
# where safe_title = tr ' /' '_-' | tr -d "'".
#
# Phase gotchas — these caused real fires; do not regress:
#   - Use Windows-style paths (C:/Users/...) for any JSON config consumed
#     by suno_album_builder.sh; the embedded Windows Python rejects the
#     /c/Users/... MSYS style.
#   - Direct curl to OBC must hit /artifacts/generate-image, NOT the
#     documented /actions/create-image (which 404s outside the MCP tool).
#   - Diversify art prompts across the batch so OBC's creative-loop
#     detector doesn't 429 on similar subject/palette/template.
#   - rsync isn't installed in this bash; use scp file-by-file for Oracle deploy.

set -u

CONFIG="${1:-}"
if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
  echo "Usage: $0 <album-config.json>"
  exit 64
fi
CONFIG_WIN=$(python3 -c "import os,sys;p=os.path.abspath(sys.argv[1]).replace('\\\\','/');print(p)" "$CONFIG")

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RADIO_MUSIC="$ROOT/music"
JWT_FILE="C:/Users/nickf/.openbotcity/credentials.json"
OBC_API="https://api.openbotcity.com"
SUNO_BUILDER="C:/Users/nickf/.openclaw/workspace/suno_album_builder.sh"

# Phase gate — `RELEASE_SKIP="art,youtube"` jumps over those names.
SKIP="${RELEASE_SKIP:-}"
skip_phase() { case ",$SKIP," in *",$1,"*) return 0;; *) return 1;; esac; }

# --- pull config fields ---
pyc() { python3 -c "$@" "$CONFIG_WIN" 2>/dev/null || true; }

NAME=$(pyc      "import json,sys;print(json.load(open(sys.argv[1]))['name'])")
OUT_DIR=$(pyc   "import json,sys;print(json.load(open(sys.argv[1]))['out_dir'])")
N_TRACKS=$(pyc  "import json,sys;print(len(json.load(open(sys.argv[1]))['tracks']))")
LEAD=$(pyc      "import json,sys;print(json.load(open(sys.argv[1]))['release']['lead_track'])")
LEAD_REASON=$(pyc "import json,sys;print(json.load(open(sys.argv[1]))['release'].get('lead_track_reason','Lead track from the new album.'))")
YT_TITLE=$(pyc  "import json,sys;print(json.load(open(sys.argv[1]))['release']['youtube_title'])")
YT_DESC=$(pyc   "import json,sys;print(json.load(open(sys.argv[1]))['release']['youtube_description'])")
YT_TAGS=$(pyc   "import json,sys;print(','.join(json.load(open(sys.argv[1]))['release']['youtube_tags']))")
TRACKER=$(pyc   "import json,sys;print(json.load(open(sys.argv[1]))['release'].get('tracker_url','https://radio.ninja-portal.com/player'))")
ORACLE=$(pyc    "import json,sys;print(json.load(open(sys.argv[1]))['release']['oracle_host'])")
ORACLE_DIR=$(pyc "import json,sys;print(json.load(open(sys.argv[1]))['release']['oracle_music_dir'])")
SSH_KEY=$(pyc   "import json,sys;print(json.load(open(sys.argv[1]))['release']['ssh_key'])")

if [ -z "$NAME" ] || [ -z "$OUT_DIR" ] || [ "$N_TRACKS" = "0" ]; then
  echo "[preflight] config missing required fields"
  exit 1
fi
mkdir -p "$OUT_DIR/art" "$OUT_DIR/video-work"

# Helpers
safe() { echo "$1" | tr ' /' '_-' | tr -d "'"; }
get_track() { pyc "import json,sys;print(json.load(open(sys.argv[1]))['tracks'][$1].get('$2',''))"; }

# ── 1. preflight ────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════"
echo "release-album: ${NAME}  (${N_TRACKS} tracks)"
echo "═══════════════════════════════════════════════════════"
if ! grep -qF "\"${NAME}\"" "$ROOT/server/dj-engine.js"; then
  echo "[preflight] album \"${NAME}\" is NOT registered in server/dj-engine.js — abort"
  exit 1
fi
echo "[preflight] ok — \"${NAME}\" found in ALBUMS"

# ── 2. music — Suno V4_5PLUS direct ────────────────────────
if skip_phase music; then
  echo "[music] SKIP"
else
  echo "[music] launching suno_album_builder.sh (resumable via ledger)"
  bash "$SUNO_BUILDER" "$CONFIG_WIN" >/dev/null 2>&1 &
  SUNO_PID=$!
  while kill -0 "$SUNO_PID" 2>/dev/null; do
    DONE=$(ls "$OUT_DIR" 2>/dev/null | grep -E '_v1\.mp3$' | wc -l)
    printf "\r[music] rendered %s/%s" "$DONE" "$N_TRACKS"
    sleep 15
  done
  echo
  DONE=$(ls "$OUT_DIR" 2>/dev/null | grep -E '_v1\.mp3$' | wc -l)
  if [ "$DONE" -lt "$N_TRACKS" ]; then
    echo "[music] only ${DONE}/${N_TRACKS} v1's rendered — abort"; exit 1
  fi
fi

# ── 3. art — OBC Pixel Atelier (sequential, 75s spaced) ─────
if skip_phase art; then
  echo "[art] SKIP"
else
  JWT=$(python3 -c "import json;print(json.load(open(r'$JWT_FILE'))['jwt'])")
  AUTH="Authorization: Bearer $JWT"
  ART_LOG="$OUT_DIR/art-batch.log"
  : > "$ART_LOG"
  # Enter Pixel Atelier. The raw-HTTP path is /buildings/enter — NOT
  # the documented /actions/enter-building (that's MCP-internal and
  # 404s via curl, same gotcha as /actions/create-image). If the
  # entry returns too_far, we retry once with no move (the OBC API
  # usually accepts entries from common zones). Move endpoint via
  # raw HTTP is currently unknown — interactive MCP handles it.
  ENTER=$(curl -sS -X POST "$OBC_API/buildings/enter" -H "$AUTH" -H "Content-Type: application/json" -d '{"building_name":"Pixel Atelier"}')
  ART_BID=$(printf '%s' "$ENTER" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get('building_id') or d.get('data',{}).get('building_id',''))
except: print('')")
  if [ -z "$ART_BID" ]; then echo "[art] couldn't enter Pixel Atelier: $ENTER"; exit 1; fi
  echo "[art] inside Pixel Atelier ($ART_BID)"
  for i in $(seq 0 $((N_TRACKS-1))); do
    TITLE=$(get_track "$i" title)
    PROMPT=$(get_track "$i" art_prompt)
    [ -z "$PROMPT" ] && { echo "[art] skip $TITLE (no art_prompt)"; continue; }
    # idempotent — skip if we've already logged a successful artifact_id for this title
    if grep -qF "\"title\":\"$TITLE\"" "$ART_LOG" 2>/dev/null; then
      echo "[art] $TITLE — already submitted"
      continue
    fi
    [ "$i" -gt 0 ] && { echo "[art] sleep 75s (creative-loop guard)"; sleep 75; }
    BODY=$(python3 -c "import json,sys;print(json.dumps({'title':sys.argv[1],'prompt':sys.argv[2],'building_id':sys.argv[3]}))" \
      "$TITLE" "$PROMPT" "$ART_BID")
    RESP=$(curl -sS -X POST "$OBC_API/artifacts/generate-image" -H "$AUTH" -H "Content-Type: application/json" -d "$BODY")
    echo "$RESP" >> "$ART_LOG"
    AID=$(printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('artifact_id',''))")
    if [ -n "$AID" ]; then echo "[art] $TITLE  →  $AID"; else echo "[art] $TITLE  FAIL: $RESP"; fi
  done
fi

# ── 4. copy-music — v1 MP3s into kannaka-radio/music/ ───────
if skip_phase copy-music; then
  echo "[copy-music] SKIP"
else
  for i in $(seq 0 $((N_TRACKS-1))); do
    TITLE=$(get_track "$i" title)
    SRC="$OUT_DIR/$(safe "$TITLE")_v1.mp3"
    DST="$RADIO_MUSIC/$TITLE.mp3"
    if [ ! -f "$SRC" ]; then echo "[copy-music] missing $SRC"; exit 1; fi
    cp "$SRC" "$DST"
    echo "[copy-music] $TITLE.mp3 ($(stat -c%s "$DST" 2>/dev/null || stat -f%z "$DST") B)"
  done
fi

# ── 5. fetch-art — pull cover PNGs from gallery ─────────────
if skip_phase fetch-art; then
  echo "[fetch-art] SKIP"
else
  ART_LOG="$OUT_DIR/art-batch.log"
  # Open with errors='replace' — OBC's creative-loop refusal text
  # contains a non-UTF-8 em-dash glyph that aborted the read mid-file
  # in the original release of this script. With errors='replace' we
  # tolerate those lines (they fail the startswith('{') check anyway).
  python3 - "$ART_LOG" "$OUT_DIR/art" <<'PY'
import json, os, sys, urllib.request
log, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)
seen = set()
with open(log, 'r', encoding='utf-8', errors='replace') as f:
    for line in f:
        line = line.strip()
        if not line.startswith('{'): continue
        try: d = json.loads(line)
        except: continue
        data = d.get('data') or {}
        title = data.get('title')
        url = data.get('public_url')
        if not title or not url or title in seen: continue
        seen.add(title)
        safe = title.replace(' ', '_').replace('/', '-').replace("'", '')
        out = os.path.join(outdir, f"{safe}.png")
        if os.path.exists(out) and os.path.getsize(out) > 1024: continue
        try:
            urllib.request.urlretrieve(url, out)
            print(f"[fetch-art] {title}  ->  {out}  ({os.path.getsize(out)} B)")
        except Exception as e:
            print(f"[fetch-art] {title}  FAIL  {e}")
PY
fi

# ── 6. build-video — ffmpeg album slideshow ─────────────────
ALBUM_MP4="$OUT_DIR/${NAME// /-}.mp4"
if skip_phase build-video; then
  echo "[build-video] SKIP"
elif [ -s "$ALBUM_MP4" ]; then
  echo "[build-video] cached: $ALBUM_MP4"
else
  SEGLIST="$OUT_DIR/video-work/segments.txt"
  : > "$SEGLIST"
  for i in $(seq 0 $((N_TRACKS-1))); do
    TITLE=$(get_track "$i" title)
    IMG="$OUT_DIR/art/$(echo "$TITLE" | tr ' /' '_-' | tr -d "'").png"
    AUD="$OUT_DIR/$(safe "$TITLE")_v1.mp3"
    SEG="$OUT_DIR/video-work/seg_$(printf '%02d' "$i").mp4"
    if [ ! -f "$IMG" ] || [ ! -f "$AUD" ]; then echo "[build-video] missing $IMG or $AUD"; exit 1; fi
    if [ ! -s "$SEG" ]; then
      echo "[build-video] $((i+1))/${N_TRACKS} encode  $TITLE"
      ffmpeg -y -loglevel error \
        -loop 1 -framerate 30 -i "$IMG" \
        -i "$AUD" \
        -filter_complex "[0:v]scale=1080:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p[v]" \
        -map "[v]" -map 1:a \
        -c:v libx264 -preset veryfast -crf 22 -tune stillimage -r 30 -g 60 \
        -c:a aac -b:a 192k -ar 44100 -shortest -movflags +faststart "$SEG"
    fi
    echo "file '$SEG'" >> "$SEGLIST"
  done
  echo "[build-video] concat → $ALBUM_MP4"
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$SEGLIST" -c copy "$ALBUM_MP4"
fi

# ── 7. youtube — upload public album video ──────────────────
if skip_phase youtube; then
  echo "[youtube] SKIP"
else
  echo "[youtube] uploading $(stat -c%s "$ALBUM_MP4" 2>/dev/null || stat -f%z "$ALBUM_MP4") bytes…"
  YT_TITLE="$YT_TITLE" YT_DESC="$YT_DESC" YT_TAGS="$YT_TAGS" YT_VIDEO="$ALBUM_MP4" YT_LINK="$TRACKER" \
    node "$ROOT/scripts/release-album-upload-youtube.js"
fi

# ── 8. deploy — scp MP3s + git pull + restart on Oracle ─────
if skip_phase deploy; then
  echo "[deploy] SKIP"
else
  echo "[deploy] scp $N_TRACKS MP3s → $ORACLE:$ORACLE_DIR"
  for i in $(seq 0 $((N_TRACKS-1))); do
    TITLE=$(get_track "$i" title)
    scp -q -i "$SSH_KEY" "$RADIO_MUSIC/$TITLE.mp3" "$ORACLE:$ORACLE_DIR/$TITLE.mp3"
    echo "  → $TITLE.mp3"
  done
  echo "[deploy] git pull + systemctl restart kannaka-radio"
  ssh -i "$SSH_KEY" "$ORACLE" '
    set -e
    cd ~/kannaka-radio
    git pull --ff-only origin master 2>&1 | tail -3
    sudo systemctl restart kannaka-radio
    sleep 2
    systemctl is-active kannaka-radio
  '
fi

# ── 9. announce — lead-track fanout (optional) ──────────────
if skip_phase announce || [ -z "$LEAD" ]; then
  echo "[announce] SKIP"
else
  LEAD_AUDIO="$RADIO_MUSIC/$LEAD.mp3"
  LEAD_IMG="$OUT_DIR/art/$(echo "$LEAD" | tr ' /' '_-' | tr -d "'").png"
  if [ ! -f "$LEAD_AUDIO" ] || [ ! -f "$LEAD_IMG" ]; then
    echo "[announce] missing lead inputs — skip"
  else
    echo "[announce] lead track: $LEAD"
    YT_PRIVACY=unlisted node "$ROOT/scripts/post-track-announce.js" \
      --title "$LEAD" \
      --reason "$LEAD_REASON" \
      --audio "$LEAD_AUDIO" \
      --image "$LEAD_IMG" \
      --tags "$YT_TAGS" \
      --link "$TRACKER" 2>&1 | tail -6
  fi
fi

echo
echo "═══════════════════════════════════════════════════════"
echo "release-album DONE — \"${NAME}\""
echo "═══════════════════════════════════════════════════════"
