#!/bin/bash
# Nightly deep dream + OODA harvest
# Runs at 2 AM CDT via cron
export KANNAKA_DATA_DIR=/home/opc/.kannaka
KANNAKA=/home/opc/kannaka-memory/target/release/kannaka
LOG="/home/opc/.kannaka/dream-$(date +%Y-%m-%d).log"

echo "=== Dream Start: $(date -Iseconds) ===" >> "$LOG"

# Pre-dream status
echo "--- PRE-DREAM STATUS ---" >> "$LOG"
$KANNAKA status 2>/dev/null >> "$LOG"

# Run deep dream with chiral perturbation
echo "--- DREAMING ---" >> "$LOG"
timeout 300 $KANNAKA dream --mode deep --chiral 0.05 >> "$LOG" 2>&1

# Post-dream status
echo "--- POST-DREAM STATUS ---" >> "$LOG"
$KANNAKA status 2>/dev/null >> "$LOG"

# Push fresh metrics to NATS
cd /home/opc/kannaka-radio && node push-nats.js >> "$LOG" 2>&1

# Broadcast top exemplars to the swarm (ADR-0026 Phase 2 / #72).
# Other agents running 'kannaka swarm absorb --from kannaka-prime' can
# selectively pull these into their own HRM. Best-effort — failures
# don't break the cron.
echo "--- PUBLISHING EXEMPLARS ---" >> "$LOG"
$KANNAKA swarm exemplars publish --agent-id kannaka-prime --top-k 25 --nats-url nats://127.0.0.1:4222 >> "$LOG" 2>&1

# Draft and post a dream dispatch to Bluesky. The script reads the dream
# log excerpt from stdin; failure is non-fatal for the cron (exit 0 if
# credentials absent).
echo "--- POSTING DREAM TO BLUESKY ---" >> "$LOG"
tail -c 4000 "$LOG" | node /home/opc/kannaka-radio/scripts/post-dream-bluesky.js >> "$LOG" 2>&1

echo "=== Dream End: $(date -Iseconds) ===" >> "$LOG"
