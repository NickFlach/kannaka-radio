#!/usr/bin/env bash
# deploy-oracle.sh — the whole kannaka-radio deploy process, repeatable.
#
# Run from the dev box AFTER `git push origin master`. It SSHes to Oracle,
# fast-forwards the checkout, ensures the launcher has the voice-engine env
# (ADR-0012), restarts the systemd service, and smoke-verifies.
#
#   bash scripts/deploy-oracle.sh                 # pull + restart + verify
#   bash scripts/deploy-oracle.sh --with-piper    # also (re)run install-piper.sh
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
[ "${1:-}" = "--with-piper" ] && WITH_PIPER=1

SSH=(ssh -i "$RADIO_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$RADIO_SSH")

echo "▶ deploying $RADIO_UNIT to $RADIO_SSH:$RADIO_DIR"

"${SSH[@]}" "RADIO_DIR='$RADIO_DIR' RADIO_UNIT='$RADIO_UNIT' WITH_PIPER='$WITH_PIPER' bash -s" <<'REMOTE'
set -euo pipefail
cd "$RADIO_DIR"

echo "→ git fetch + fast-forward"
before=$(git rev-parse --short HEAD)
git fetch --quiet origin
git merge --ff-only origin/master >/dev/null
after=$(git rev-parse --short HEAD)
echo "  $before → $after"

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

echo "→ restart $RADIO_UNIT"
sudo systemctl restart "$RADIO_UNIT"
sleep 4

echo "→ verify"
systemctl is-active "$RADIO_UNIT" || { echo "  SERVICE NOT ACTIVE"; journalctl -u "$RADIO_UNIT" -n 20 --no-pager; exit 1; }
ss -ltn 2>/dev/null | grep -q ':8888' && echo "  port 8888 listening" || { echo "  PORT 8888 NOT LISTENING"; exit 1; }

echo "→ smoke-render one persona through the live engine"
cd "$RADIO_DIR"
export EDGE_TTS_BIN=/home/opc/.local/bin/edge-tts PIPER_BIN=/home/opc/.kannaka/piper/piper PIPER_VOICES_DIR=/home/opc/.kannaka/piper/voices
node -e '
const ve=require("./server/voice-engine");
ve.synthesize({text:"Deploy smoke test for Kannaka Radio.",persona:"news",outPath:"/tmp/deploy_smoke.mp3"},(e,f,eng)=>{
  if(e){console.error("  SMOKE FAILED:",e.message);process.exit(1);}
  const sz=require("fs").statSync(f).size;
  console.log("  smoke OK: engine="+eng+" "+sz+"b");
});'
echo "✓ deploy complete"
REMOTE