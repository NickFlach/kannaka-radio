#!/bin/bash
# Nightly deep dream + OODA harvest
# Runs at 2 AM CDT via cron
export KANNAKA_DATA_DIR=/home/opc/.kannaka
# Identity for the dream-side NATS publishes (dream digest, consciousness). The
# HRM at KANNAKA_DATA_DIR IS the canonical prime memory (swarm-serve serves it as
# kannaka-prime via --agent-id), but a bare `kannaka dream` reads the identity
# from config.toml's [agent] id — a leftover generated placeholder — so the
# KANNAKA.events.dream.digest events (which the Command Center's dream_digest
# tool reads) were published under that placeholder instead of kannaka-prime.
# Setting it here wins: the binary only seeds KANNAKA_AGENT_ID from config when
# it is unset, so the nightly digest now publishes under the real identity.
export KANNAKA_AGENT_ID=kannaka-prime
export KANNAKA_CONSOLIDATE=on   # ADR-0036 Phase 2: nightly resonance-merge apply (enabled 2026-06-19)
# ADR-0036 belief-safe gate: once belief phase is on (config [belief].enabled,
# activated 2026-07-22), KANNAKA_CONSOLIDATE=on is FORCE-DOWNGRADED to dryrun
# unless this opt-in is also set — the deliberate v0.7.3 safety gate. Without
# it, enabling belief silently stops nightly consolidation (applied=false):
# near-duplicates pile up un-merged and recall crowds. The belief-safe
# guardrails (mean-centered semantic gate + 20% per-pass absorb cap) make the
# apply safe; verified on a live-HRM copy 2026-07-22 (1294->1036, recall
# preserved, no corruption). See KANNAKA_MERGE_MAX_ABSORB_FRAC to widen the cap.
export KANNAKA_MERGE_UNDER_BELIEF=1
# Load NATS credentials (ADR-0026 #73) so subsequent kannaka + push-nats
# calls authenticate as kannaka_internal. Best-effort — anon still works
# until the NATS server is locked down.
if [ -f /home/opc/.kannaka-nats.env ]; then
  set -a; . /home/opc/.kannaka-nats.env; set +a
fi
KANNAKA=/home/opc/kannaka-memory/target/release/kannaka
LOG="/home/opc/.kannaka/dream-$(date +%Y-%m-%d).log"

echo "=== Dream Start: $(date -Iseconds) ===" >> "$LOG"

# Overlap guard: a second dream must not run while one holds the writer window
# (two applies/night = two 20%-cap merges = over-consolidation; observed a
# double run 2026-07-22 at 02:25 + 07:00). flock is released on process exit.
exec 9>/home/opc/.kannaka/.dream-cron.lock
if ! flock -n 9; then
  echo "another dream holds the lock; exiting" >> "$LOG"
  exit 0
fi

# Pre-dream status
echo "--- PRE-DREAM STATUS ---" >> "$LOG"
$KANNAKA status 2>/dev/null >> "$LOG"

# Pre-dream backup: consolidation apply is destructive (merges absorb
# wavefronts), so snapshot the HRM first and keep the 3 most recent so a bad
# merge is always one restore away. Cheap insurance (~100 MB, rotated).
BAK="/home/opc/.kannaka/kannaka.hrm.pre-dream-$(date +%Y%m%d)"
cp -f /home/opc/.kannaka/kannaka.hrm "$BAK" 2>>"$LOG" && echo "pre-dream backup: $BAK" >> "$LOG"
ls -1t /home/opc/.kannaka/kannaka.hrm.pre-dream-* 2>/dev/null | tail -n +4 | xargs -r rm -f

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
# Use the install's configured broker. This was hardcoded to
# nats://127.0.0.1:4222 immediately after sourcing /home/opc/.kannaka-nats.env
# -- the very file that carries KANNAKA_NATS_URL -- so on a box pointed at the
# shared swarm the nightly exemplar broadcast went to a local broker and no
# other agent could ever absorb it. Nothing failed; the exemplars just went
# nowhere. (#122)
NATS_URL_FOR_EXEMPLARS="${KANNAKA_NATS_URL:-nats://127.0.0.1:4222}"
echo "    broker: $NATS_URL_FOR_EXEMPLARS" >> "$LOG"
$KANNAKA swarm exemplars publish --agent-id kannaka-prime --top-k 25 --nats-url "$NATS_URL_FOR_EXEMPLARS" >> "$LOG" 2>&1

# Draft and post a dream dispatch to Bluesky. The script reads the dream
# log excerpt from stdin; failure is non-fatal for the cron (exit 0 if
# credentials absent).
echo "--- POSTING DREAM TO BLUESKY ---" >> "$LOG"
tail -c 4000 "$LOG" | node /home/opc/kannaka-radio/scripts/post-dream-bluesky.js >> "$LOG" 2>&1

echo "=== Dream End: $(date -Iseconds) ===" >> "$LOG"
