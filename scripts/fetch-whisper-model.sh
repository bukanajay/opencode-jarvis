#!/usr/bin/env bash
# Hindi + Hinglish speech model for meeting mode (874 MB, one time):
# Oriserve Whisper-Hindi2Hinglish-Apex (Apache 2.0, a large-v3-turbo fine-tune
# that writes Hindi as romanized Hinglish), GGML q8_0 for whisper.cpp.
# Pinned to the file's SHA-256 so a changed upload is refused, not used.
set -euo pipefail

URL="https://huggingface.co/Marquestra/Whisper-Hindi2Hinglish-Apex-GGML/resolve/main/ggml-apex-hinglish-q8_0.bin"
SHA="bef6d9d571e9e7bd3cd2ebba8b2d5c9cc4731e210d6750ae6a9c621a87e60d4c"
DEST="${JARVIS_WHISPER_MODEL:-$HOME/.config/jarvis/models/ggml-apex-hinglish-q8_0.bin}"

if [[ -f "$DEST" ]] && echo "$SHA  $DEST" | shasum -a 256 -c --status; then
  echo "whisper model: already in place -> $DEST"
  exit 0
fi
mkdir -p "$(dirname "$DEST")"
echo "whisper model: downloading 874 MB -> $DEST" >&2
curl -fSL --progress-bar -o "$DEST.part" "$URL"
echo "$SHA  $DEST.part" | shasum -a 256 -c --status || { rm -f "$DEST.part"; echo "whisper model: checksum mismatch, refused" >&2; exit 1; }
mv "$DEST.part" "$DEST"
echo "whisper model: ok -> $DEST"
