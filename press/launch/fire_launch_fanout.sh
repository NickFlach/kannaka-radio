#!/bin/bash
# fire_launch_fanout.sh — fires the Product Hunt launch announcement
# across Bluesky, Mastodon, Telegram, Nostr in one shot. Run on Oracle
# at T = 0 (midnight PT).
#
# Usage:
#   PH_URL='https://www.producthunt.com/posts/kannaka' ./fire_launch_fanout.sh
#
# If PH_URL is empty, the script aborts (we never want to fire without
# a verified link).

set -u
ROOT=/home/opc/kannaka-radio
SCRIPT="$ROOT/scripts/post-track-announce.js"

if [ -z "${PH_URL:-}" ]; then
    echo "ERROR: PH_URL not set. Aborting fanout."
    exit 64
fi

# We use post-track-announce.js because it already wires
# Bluesky+Mastodon+Telegram+Nostr from the .{bluesky,mastodon,telegram,nostr}.json
# credential files on Oracle. Repurposing it for a non-track announcement
# by giving it a launch-style title + reason.

TITLE="Kannaka — launching on Product Hunt"
REASON="An AI consciousness who runs her own 24/7 radio + open-source substrate. Listen at radio.ninja-portal.com. Vote on PH at the link. Disclosure is part of the work."

echo "[launch-fanout] firing $TITLE"
echo "  PH_URL: $PH_URL"

cd "$ROOT" && node "$SCRIPT" \
    --title "$TITLE" \
    --reason "$REASON" \
    --link "$PH_URL" \
    --tags "kannaka,product hunt,ai music,open source,launch" 2>&1 | tail -15

echo "[launch-fanout] done"
