#!/usr/bin/env bash
# install-piper.sh — fetch the Piper neural TTS binary + the per-persona voice
# models kannaka-radio uses, into ~/.kannaka/piper. Piper is local, self-hosted,
# MIT-licensed, and its voices are fine-tunable — the "own voices" tier of
# ADR-0012. Until this runs, voice-engine.js falls back to edge-tts, so the
# radio works with or without Piper.
#
# Usage:
#   bash scripts/install-piper.sh            # binary + default persona voices
#   bash scripts/install-piper.sh --bin-only # just the piper binary
#
# After install, the engine auto-detects PIPER_BIN + models. To make it the
# preferred engine you don't need to do anything — voice-personas.json already
# lists "piper" first; it engages the moment the model file exists.
#
# Env:
#   KANNAKA_PIPER_DIR   override install dir (default ~/.kannaka/piper)
#   PIPER_VERSION       piper release tag (default 2023.11.14-2)
set -euo pipefail

PIPER_DIR="${KANNAKA_PIPER_DIR:-$HOME/.kannaka/piper}"
VOICES_DIR="$PIPER_DIR/voices"
PIPER_VERSION="${PIPER_VERSION:-2023.11.14-2}"
BIN_ONLY=0
[ "${1:-}" = "--bin-only" ] && BIN_ONLY=1

mkdir -p "$PIPER_DIR" "$VOICES_DIR"

# ── Detect platform → piper release asset ──────────────────────
uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s" in
  Linux)
    case "$uname_m" in
      x86_64)         ASSET="piper_linux_x86_64.tar.gz" ;;
      aarch64|arm64)  ASSET="piper_linux_aarch64.tar.gz" ;;   # Oracle ARM box
      armv7l)         ASSET="piper_linux_armv7l.tar.gz" ;;
      *) echo "Unsupported Linux arch: $uname_m" >&2; exit 1 ;;
    esac ;;
  Darwin)
    case "$uname_m" in
      x86_64) ASSET="piper_macos_x64.tar.gz" ;;
      arm64)  ASSET="piper_macos_aarch64.tar.gz" ;;
      *) echo "Unsupported macOS arch: $uname_m" >&2; exit 1 ;;
    esac ;;
  MINGW*|MSYS*|CYGWIN*)
    ASSET="piper_windows_amd64.zip" ;;
  *) echo "Unsupported OS: $uname_s" >&2; exit 1 ;;
esac

BASE="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}"
echo "→ piper ${PIPER_VERSION} for ${uname_s}/${uname_m}: ${ASSET}"

# ── Fetch + unpack the binary ──────────────────────────────────
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "${BASE}/${ASSET}" -o "$tmp/$ASSET"
case "$ASSET" in
  *.tar.gz) tar -xzf "$tmp/$ASSET" -C "$tmp" ;;
  *.zip)    unzip -q "$tmp/$ASSET" -d "$tmp" ;;
esac
# The archive unpacks to a `piper/` dir containing the binary + espeak-ng data.
if [ -d "$tmp/piper" ]; then
  cp -r "$tmp/piper/." "$PIPER_DIR/"
fi
PIPER_BIN="$PIPER_DIR/piper"
[[ "$uname_s" == MINGW* || "$uname_s" == MSYS* || "$uname_s" == CYGWIN* ]] && PIPER_BIN="$PIPER_DIR/piper.exe"
chmod +x "$PIPER_DIR/piper" 2>/dev/null || true
echo "✓ piper binary: $PIPER_BIN"

if [ "$BIN_ONLY" = "1" ]; then
  echo "Done (binary only). Add models to $VOICES_DIR to enable the piper engine."
  exit 0
fi

# ── Per-persona voice models (from huggingface rhasspy/piper-voices) ──
# Each entry: "<model-name> <hf-path>". The .onnx + .onnx.json both download.
# These map to the `piper.model` fields in server/voice-personas.json.
HF="https://huggingface.co/rhasspy/piper-voices/resolve/main"
declare -a MODELS=(
  "en_US-amy-medium      en/en_US/amy/medium/en_US-amy-medium"          # dj
  "en_US-ryan-high       en/en_US/ryan/high/en_US-ryan-high"            # news
  "en_GB-cori-high       en/en_GB/cori/high/en_GB-cori-high"            # oration
  "en_US-kristin-medium  en/en_US/kristin/medium/en_US-kristin-medium"  # gossip
)

for entry in "${MODELS[@]}"; do
  name="$(echo "$entry" | awk '{print $1}')"
  hfpath="$(echo "$entry" | awk '{print $2}')"
  onnx="$VOICES_DIR/${name}.onnx"
  if [ -f "$onnx" ]; then
    echo "  • ${name} already present — skipping"
    continue
  fi
  echo "  ↓ ${name}"
  curl -fsSL "${HF}/${hfpath}.onnx"      -o "$onnx"
  curl -fsSL "${HF}/${hfpath}.onnx.json" -o "${onnx}.json"
done

echo
echo "✓ Piper installed."
echo "  binary : $PIPER_BIN"
echo "  voices : $VOICES_DIR"
echo
echo "On Oracle, add these to /home/opc/kannaka-radio's run-radio.sh (or the"
echo "systemd unit's Environment=) so the service picks them up:"
echo "  export PIPER_BIN=\"$PIPER_BIN\""
echo "  export PIPER_VOICES_DIR=\"$VOICES_DIR\""
echo
echo "voice-personas.json already lists piper first per persona — it engages"
echo "automatically now that the models exist. Restart the radio to pick it up."
