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

echo "=== Dream End: $(date -Iseconds) ===" >> "$LOG"
