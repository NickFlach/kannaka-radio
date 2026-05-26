#!/usr/bin/env bash
# prune-voice-cache.sh — delete old TTS audio chunks.
#
# voice-dj.js writes generated DJ-talk audio into chunks/voice/ and the
# browser loads each one via /audio-voice/<basename> for the few seconds
# it's spoken. After that the file is dead weight — but nothing else
# cleaned it up, so the dir grew unbounded (~140 MB/day → 549 MB / 4d
# observed before this script existed).
#
# We keep the last RETAIN_HOURS worth of clips (6h default) so a long-
# scrolled-back listener still has a chance of loading recent ones, then
# delete the rest. The radio's TTS cache is hash-keyed on the spoken text
# — if a deleted clip is needed again, the next regenerate is one OpenAI
# round-trip away.
#
# Cron suggestion:
#   slot/ * * * *  /home/opc/kannaka-radio/scripts/prune-voice-cache.sh
#   (i.e. once per hour)
#
# Tunable via env:
#   VOICE_DIR       (default: /home/opc/kannaka-radio/chunks/voice)
#   RETAIN_HOURS    (default: 6)

set -eu

VOICE_DIR="${VOICE_DIR:-/home/opc/kannaka-radio/chunks/voice}"
RETAIN_HOURS="${RETAIN_HOURS:-6}"

if [ ! -d "$VOICE_DIR" ]; then
  echo "[prune-voice] $VOICE_DIR does not exist — nothing to do"
  exit 0
fi

BEFORE_COUNT=$(find "$VOICE_DIR" -maxdepth 1 -type f | wc -l)
BEFORE_SIZE=$(du -sh "$VOICE_DIR" 2>/dev/null | awk '{print $1}')

# -mmin uses minutes, so retain_hours * 60.
MINS=$((RETAIN_HOURS * 60))
DELETED=$(find "$VOICE_DIR" -maxdepth 1 -type f -name 'dj_*.mp3' -mmin +"$MINS" -print -delete | wc -l)

AFTER_COUNT=$(find "$VOICE_DIR" -maxdepth 1 -type f | wc -l)
AFTER_SIZE=$(du -sh "$VOICE_DIR" 2>/dev/null | awk '{print $1}')

echo "[prune-voice] $(date -Iseconds)  retain=${RETAIN_HOURS}h  files ${BEFORE_COUNT}→${AFTER_COUNT}  size ${BEFORE_SIZE}→${AFTER_SIZE}  deleted=${DELETED}"
