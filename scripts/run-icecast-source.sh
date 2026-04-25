#!/bin/bash
# ADR-0004 Phase 1 — ffmpeg-driven Icecast source on /preview.
# Loops the One More Life album indefinitely, encoding to MP3 128kbps,
# pushing to localhost:8000/preview. Runs under systemd (auto-restart on crash).
set -u
MUSIC=/home/opc/kannaka-radio/music
ICECAST_URL="icecast://source:kannaka_source_2026@127.0.0.1:8000/preview"
PLAYLIST=/tmp/kannaka-preview.m3u8
# Build a concat-format playlist over the One More Life v2 files.
{
  echo "ffconcat version 1.0"
  for f in "$MUSIC"/*" v2.mp3"; do
    [ -f "$f" ] && printf 'file %q\n' "$f"
  done
  for f in "$MUSIC/Was Ist Das_.mp3" "$MUSIC/Control Room Constellation.mp3" "$MUSIC/Agentic Engineering Anthem.mp3"; do
    [ -f "$f" ] && printf 'file %q\n' "$f"
  done
} > $PLAYLIST
echo "[icecast-source] playlist:"; cat $PLAYLIST
exec ffmpeg -hide_banner -re -f concat -safe 0 -stream_loop -1 -i $PLAYLIST   -c:a libmp3lame -b:a 128k -ar 44100 -ac 2   -content_type audio/mpeg   -ice_name "Kannaka Radio Preview"   -ice_description "ADR-0004 Phase 1 parallel mount"   -ice_genre "experimental"   -f mp3   "$ICECAST_URL"
