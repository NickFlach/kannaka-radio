#!/bin/bash
# Nightly deep dream + OODA harvest
# Runs at 2 AM CDT via cron
export KANNAKA_DATA_DIR=/home/opc/.kannaka
export KANNAKA_CONSOLIDATE=on   # ADR-0036 Phase 2: nightly resonance-merge apply (enabled 2026-06-19)
# Load NATS credentials (ADR-0026 #73) so subsequent kannaka + push-nats
# calls authenticate as kannaka_internal. Best-effort — anon still works
# until the NATS server is locked down.
if [ -f /home/opc/.kannaka-nats.env ]; then
  set -a; . /home/opc/.kannaka-nats.env; set +a
fi
KANNAKA=/home/opc/kannaka-memory/target/release/kannaka
LOG="/home/opc/.kannaka/dream-$(date +%Y-%m-%d).log"

echo "=== Dream Start: $(date -Iseconds) ===" >> "$LOG"

# Pre-dream status
echo "--- PRE-DREAM STATUS ---" >> "$LOG"
$KANNAKA status 2>/dev/null >> "$LOG"

# Single-writer maintenance window: kannaka-memory (swarm join) is the sole
# CONTINUOUS HRM writer. A standalone `kannaka dream` is also a writer, so the
# two race (last-writer-wins) and silently drop each other's changes. Stop the
# writer for the duration of the dream so the dream is the only process touching
# the .hrm, then bring it back (it reloads the freshly-consolidated file). The
# EXIT trap guarantees the writer is restarted even if the dream times out/errs.
echo "--- STOPPING WRITER (single-writer dream window) ---" >> "$LOG"
sudo systemctl stop kannaka-memory >> "$LOG" 2>&1
trap 'sudo systemctl start kannaka-memory >> "$LOG" 2>&1; trap - EXIT' EXIT

# Run deep dream with chiral perturbation — now the ONLY HRM writer.
echo "--- DREAMING (sole writer) ---" >> "$LOG"
timeout 1800 $KANNAKA dream --mode deep --chiral 0.05 >> "$LOG" 2>&1

# Kannaktopus tick (ADR-0030): grow/crawl one arm over the freshly-consolidated
# clusters. Reads the HRM, writes only kannaktopus-arms.json (never the .hrm),
# so it's safe inside the single-writer window.
echo "--- KANNAKTOPUS STEP ---" >> "$LOG"
$KANNAKA kannaktopus step >> "$LOG" 2>&1

# Bring the writer back immediately; it reloads the consolidated HRM.
echo "--- RESTARTING WRITER ---" >> "$LOG"
sudo systemctl start kannaka-memory >> "$LOG" 2>&1
trap - EXIT

# Post-dream status
echo "--- POST-DREAM STATUS ---" >> "$LOG"
$KANNAKA status 2>/dev/null >> "$LOG"

# Record this dream into dream-history.json so the observatory Dreams tab
# reflects the autonomous nightly dream (not just observatory-triggered ones).
echo "--- RECORDING DREAM HISTORY ---" >> "$LOG"
node /home/opc/kannaka-radio/scripts/record-dream.js --log "$LOG" >> "$LOG" 2>&1

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
