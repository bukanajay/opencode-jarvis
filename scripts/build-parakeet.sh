#!/usr/bin/env bash
# Build the Apple Silicon voice helpers:
#   apps/audio-parakeet/bin/parakeet   speech to text (Parakeet TDT v3)
#   apps/audio-voice/bin/jarvis-voice  text to speech (Kokoro-82M, Jarvis's voice)
#
# Tries SwiftPM first. When SwiftPM is unusable (Command Line Tools without
# Xcode ship a swift-package that can crash on load), falls back to compiling
# FluidAudio straight with swiftc: same sources, same excludes as its
# Package.swift, no Xcode required.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/apps/audio-parakeet"
BIN="$PKG/bin/parakeet"
FA_TAG="${FLUIDAUDIO_TAG:-v0.9.1}"
WORK="$PKG/.build/manual"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "parakeet: Apple Silicon only (this is $(uname -m)); use npm run build:audio for the sim" >&2
  exit 1
fi
mkdir -p "$PKG/bin"

# A Command Line Tools update can leave a newer default SDK than the compiler
# understands ("this SDK is not supported by the compiler"). Pick the SDK whose
# Swift interface was built by this compiler's major.minor.
if [[ -z "${SDKROOT:-}" ]]; then
  want="$(swiftc --version 2>&1 | sed -nE 's/.*Apple Swift version ([0-9]+\.[0-9]+).*/\1/p' | head -1)"
  sdk_swift() { sed -nE 's/^\/\/ swift-compiler-version: Apple Swift version ([0-9]+\.[0-9]+).*/\1/p' "$1/usr/lib/swift/Swift.swiftmodule/arm64e-apple-macos.swiftinterface" 2>/dev/null | head -1; }
  def="$(xcrun --show-sdk-path 2>/dev/null || true)"
  if [[ -n "$want" && -n "$def" && "$(sdk_swift "$def")" != "$want" ]]; then
    for s in $(ls -d "$(dirname "$def")"/MacOSX[0-9]*.[0-9]*.sdk 2>/dev/null | sort -rV); do
      if [[ "$(sdk_swift "$s")" == "$want" ]]; then export SDKROOT="$s"; echo "parakeet: using $s (matches Swift $want)" >&2; break; fi
    done
  fi
fi

VOICE="$ROOT/apps/audio-voice"
VBIN="$VOICE/bin/jarvis-voice"
mkdir -p "$VOICE/bin"

SPM_OK=0
if [[ "${PARAKEET_MANUAL:-0}" != "1" ]] && (cd "$PKG" && swift build -c release) ; then
  cp "$PKG/.build/release/parakeet" "$BIN"
  echo "parakeet: built with SwiftPM -> $BIN"
  SPM_OK=1
else
  echo "parakeet: SwiftPM unavailable, building with swiftc" >&2
fi

mkdir -p "$WORK"
FA="$WORK/FluidAudio-$FA_TAG"
if [[ ! -d "$FA" ]]; then
  git clone -q --depth 1 --branch "$FA_TAG" https://github.com/FluidInference/FluidAudio "$FA" 2>/dev/null
fi
S="$FA/Sources"
OUT="$WORK/out-$FA_TAG"
TARGET="arm64-apple-macosx15.0"

if [[ ! -f "$OUT/libFluidAudio.a" ]]; then
  rm -rf "$OUT" && mkdir -p "$OUT/mts"
  clang -O2 -target "$TARGET" -c "$S/MachTaskSelfWrapper/MachTaskSelf.c" -I "$S/MachTaskSelfWrapper/include" -o "$OUT/MachTaskSelf.o"
  clang++ -O2 -std=c++17 -target "$TARGET" -Wno-\#pragma-messages -Wno-unknown-warning-option \
    -c "$S/FastClusterWrapper/FastClusterWrapper.cpp" -I "$S/FastClusterWrapper/include" -o "$OUT/FastCluster.o"
  printf 'module MachTaskSelfWrapper {\n  header "%s"\n  export *\n}\n' "$S/MachTaskSelfWrapper/include/MachTaskSelf.h" > "$OUT/mts/module.modulemap"

  # Mirrors FluidAudio's Package.swift excludes for the FluidAudio target.
  FILES=()
  while IFS= read -r f; do FILES+=("$f"); done < <(
    find "$S/FluidAudio" -name '*.swift' \
      -not -path '*/Frameworks/*' -not -path '*/ASR/ContextBiasing/*' -not -name 'CtcModels.swift' | sort)

  swiftc -O -wmo -parse-as-library -swift-version 5 -suppress-warnings -target "$TARGET" \
    -module-name FluidAudio -emit-module -emit-module-path "$OUT/FluidAudio.swiftmodule" \
    -emit-library -static -o "$OUT/libFluidAudio.a" \
    -Xcc -fmodule-map-file="$S/FastClusterWrapper/include/module.modulemap" \
    -Xcc -fmodule-map-file="$OUT/mts/module.modulemap" \
    "${FILES[@]}"
fi

MAPS=(-Xcc -fmodule-map-file="$S/FastClusterWrapper/include/module.modulemap" -Xcc -fmodule-map-file="$OUT/mts/module.modulemap")

if [[ "$SPM_OK" != "1" ]]; then
  swiftc -O -swift-version 5 -suppress-warnings -target "$TARGET" -I "$OUT" "${MAPS[@]}" \
    "$PKG/src/helper.swift" "$OUT/libFluidAudio.a" "$OUT/MachTaskSelf.o" "$OUT/FastCluster.o" \
    -lc++ -o "$BIN"
  echo "parakeet: built with swiftc (FluidAudio $FA_TAG) -> $BIN"
fi

# Text to speech: FluidAudioTTS (Kokoro) needs the ESpeakNG framework for
# grapheme-to-phoneme; it ships next to the binary and loads via rpath.
ESPEAK="$FA/Frameworks/ESpeakNG.xcframework/macos-arm64_x86_64"
if [[ ! -f "$OUT/libFluidAudioTTS.a" ]]; then
  TTS_FILES=()
  while IFS= read -r f; do TTS_FILES+=("$f"); done < <(find "$S/FluidAudioTTS" -name '*.swift' | sort)
  swiftc -O -wmo -parse-as-library -swift-version 5 -suppress-warnings -target "$TARGET" \
    -module-name FluidAudioTTS -emit-module -emit-module-path "$OUT/FluidAudioTTS.swiftmodule" \
    -emit-library -static -o "$OUT/libFluidAudioTTS.a" \
    -I "$OUT" -F "$ESPEAK" "${MAPS[@]}" "${TTS_FILES[@]}"
fi
rm -rf "$VOICE/bin/ESpeakNG.framework"
cp -R "$ESPEAK/ESpeakNG.framework" "$VOICE/bin/"
swiftc -O -swift-version 5 -suppress-warnings -target "$TARGET" -I "$OUT" -F "$ESPEAK" "${MAPS[@]}" \
  "$VOICE/src/tts.swift" "$OUT/libFluidAudioTTS.a" "$OUT/libFluidAudio.a" "$OUT/MachTaskSelf.o" "$OUT/FastCluster.o" \
  -framework ESpeakNG -Xlinker -rpath -Xlinker @executable_path -lc++ -o "$VBIN"
echo "jarvis-voice: built with swiftc (FluidAudioTTS $FA_TAG) -> $VBIN"
