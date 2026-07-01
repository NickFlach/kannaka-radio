#!/usr/bin/env bash
# deploy-oracle.sh — the whole kannaka-radio deploy process, repeatable.
#
# Run from the dev box AFTER `git push origin master`. It SSHes to Oracle,
# fast-forwards the checkout, ensures the launcher has the voice-engine env
# (ADR-0012), restarts the systemd service, smoke-verifies, and ROLLS BACK to
# the previous commit if the smoke check fails.
#
#   bash scripts/deploy-oracle.sh                  # pull + restart + verify (+rollback on fail)
#   bash scripts/deploy-oracle.sh --with-piper     # also (re)run install-piper.sh
#   bash scripts/deploy-oracle.sh --restart-kannaka# also cycle the full kannaka-* fleet
#
# --restart-kannaka (alias --fleet): after the radio deploy verifies, restart
# every active kannaka-*.service so no process keeps running an old, replaced
# binary inode. REQUIRED whenever this deploy accompanies a kannaka-memory
# binary rebuild — `cargo build --release` swaps the file in place but leaves
# long-running PIDs (kannaka-swarm-serve / -attention / -staff / -substrate /
# -ui-bridge, etc.) on the deleted inode running the OLD code. See memory
# oracle-kannaka-zombie-binaries. The step verifies no /proc/PID/exe still
# points at a "(deleted)" kannaka binary.
#
# Rollback: the pre-deploy commit is recorded before the fast-forward. If the
# service fails to come active, port 8888 never listens, or the voice smoke
# render fails, the remote checkout is `git reset --hard`-ed back to that
# commit and the service restarted, so a bad push never stays live. (Untracked
# machine-specific wrappers like run-radio.sh are left untouched — see memory
# oracle-deploy-git-stash-u.)
#
# Env overrides:
#   RADIO_SSH   ssh target           (default opc@170.9.238.136)
#   RADIO_KEY   identity file        (default ~/.ssh/ninja-portal-ed25519)
#   RADIO_DIR   remote checkout      (default /home/opc/kannaka-radio)
#   RADIO_UNIT  systemd unit         (default kannaka-radio)
set -euo pipefail

RADIO_SSH="${RADIO_SSH:-opc@170.9.238.136}"
RADIO_KEY="${RADIO_KEY:-$HOME/.ssh/ninja-portal-ed25519}"
RADIO_DIR="${RADIO_DIR:-/home/opc/kannaka-radio}"
RADIO_UNIT="${RADIO_UNIT:-kannaka-radio}"

WITH_PIPER=0
RESTART_KANNAKA=0
for arg in "$@"; do
  case "$arg" in
    --with-piper) WITH_PIPER=1 ;;
    --restart-kannaka|--fleet) RESTART_KANNAKA=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg (see --help)" >&2; exit 2 ;;
  esac
done

SSH=(ssh -i "$RADIO_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$RADIO_SSH")

echo "▶ deploying $RADIO_UNIT to $RADIO_SSH:$RADIO_DIR"

"${SSH[@]}" "RADIO_DIR='$RADIO_DIR' RADIO_UNIT='$RADIO_UNIT' WITH_PIPER='$WITH_PIPER' RESTART_KANNAKA='$RESTART_KANNAKA' bash -s" <<'REMOTE'
set -euo pipefail
cd "$RADIO_DIR"

# ── Record the rollback point BEFORE we move HEAD ───────────────────────────
before=$(git rev-parse HEAD)
before_short=$(git rev-parse --short HEAD)

echo "→ git fetch + fast-forward"
git fetch --quiet origin
git merge --ff-only origin/master >/dev/null
after_short=$(git rev-parse --short HEAD)
echo "  $before_short → $after_short"

echo "→ ensure launcher voice-engine env (idempotent)"
LAUNCHER=/home/opc/run-radio.sh
if [ -f "$LAUNCHER" ] && ! grep -q "EDGE_TTS_BIN" "$LAUNCHER"; then
  cp -n "$LAUNCHER" "$LAUNCHER.bak-$(date +%Y%m%d)" || true
  python3 - "$LAUNCHER" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
block="""
# -- Voice engine (ADR-0012): local-first persona TTS --
export EDGE_TTS_BIN=/home/opc/.local/bin/edge-tts
export PIPER_BIN=/home/opc/.kannaka/piper/piper
export PIPER_VOICES_DIR=/home/opc/.kannaka/piper/voices

"""
a="export KANNAKA_ICECAST_SOURCE=1"
if "EDGE_TTS_BIN" not in s and a in s:
    s=s.replace(a, block+a, 1); open(p,"w").write(s); print("  launcher patched")
PY
else
  echo "  launcher already configured"
fi

if [ "$WITH_PIPER" = "1" ]; then
  echo "→ install-piper.sh"
  bash "$RADIO_DIR/scripts/install-piper.sh"
fi

# ── Verify: service active + port listening + one live voice render ─────────
verify_radio() {
  systemctl is-active --quiet "$RADIO_UNIT" || {
    echo "  SERVICE NOT ACTIVE"; journalctl -u "$RADIO_UNIT" -n 20 --no-pager || true; return 1;
  }
  ss -ltn 2>/dev/null | grep -q ':8888' || { echo "  PORT 8888 NOT LISTENING"; return 1; }
  ( cd "$RADIO_DIR"
    export EDGE_TTS_BIN=/home/opc/.local/bin/edge-tts PIPER_BIN=/home/opc/.kannaka/piper/piper PIPER_VOICES_DIR=/home/opc/.kannaka/piper/voices
    node -e '
      const ve=require("./server/voice-engine");
      ve.synthesize({text:"Deploy smoke test for Kannaka Radio.",persona:"news",outPath:"/tmp/deploy_smoke.mp3"},(e,f,eng)=>{
        if(e){console.error("  SMOKE FAILED:",e.message);process.exit(1);}
        const sz=require("fs").statSync(f).size;
        console.log("  smoke OK: engine="+eng+" "+sz+"b");
      });' ) || return 1
  return 0
}

echo "→ restart $RADIO_UNIT"
sudo systemctl restart "$RADIO_UNIT"
sleep 4

echo "→ verify"
if verify_radio; then
  echo "✓ radio deploy verified at $after_short"
else
  echo "✗ verify failed — rolling back $after_short → $before_short"
  git reset --hard "$before" >/dev/null
  sudo systemctl restart "$RADIO_UNIT"
  sleep 4
  if verify_radio; then
    echo "✓ rolled back to $before_short and service healthy"
  else
    echo "✗ ROLLBACK ALSO UNHEALTHY — manual intervention required"
    journalctl -u "$RADIO_UNIT" -n 30 --no-pager || true
  fi
  exit 1
fi

# ── Optional: cycle the full kannaka-* fleet (zombie-binary rule) ───────────
if [ "$RESTART_KANNAKA" = "1" ]; then
  echo "→ restart kannaka-* fleet (zombie-binary rule)"
  mapfile -t KUNITS < <(systemctl list-units --type=service --state=active --no-legend 'kannaka-*.service' 2>/dev/null | awk '{print $1}')
  if [ "${#KUNITS[@]}" -eq 0 ]; then
    echo "  no active kannaka-* services found"
  else
    # Restart the single-writer (kannaka-memory) first, then the rest.
    ordered=()
    for u in "${KUNITS[@]}"; do [ "$u" = "kannaka-memory.service" ] && ordered+=("$u"); done
    for u in "${KUNITS[@]}"; do [ "$u" != "kannaka-memory.service" ] && ordered+=("$u"); done

    fleet_ok=1
    for u in "${ordered[@]}"; do
      printf '  restart %-28s ' "$u"
      if sudo systemctl restart "$u"; then echo "ok"; else echo "FAILED"; fleet_ok=0; fi
    done
    sleep 3

    for u in "${ordered[@]}"; do
      systemctl is-active --quiet "$u" || {
        echo "  ✗ $u not active after restart"; journalctl -u "$u" -n 15 --no-pager || true; fleet_ok=0;
      }
    done

    # Zombie check: any kannaka process still executing a replaced (deleted)
    # binary inode? /proc/PID/exe resolves to "…/kannaka (deleted)" if so.
    for pid in $(pgrep -f 'target/release/kannaka' 2>/dev/null || true); do
      target=$(sudo readlink "/proc/$pid/exe" 2>/dev/null || true)
      case "$target" in
        *"(deleted)"*) echo "  ⚠ pid $pid still on a deleted kannaka inode: $target"; fleet_ok=0 ;;
      esac
    done

    if [ "$fleet_ok" = "1" ]; then
      echo "  ✓ kannaka-* fleet restarted cleanly (no deleted-inode zombies)"
    else
      echo "  ✗ kannaka-* fleet restart had failures — investigate above"
      exit 1
    fi
  fi
fi

echo "✓ deploy complete"
REMOTE
