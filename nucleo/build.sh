#!/bin/zsh
# Builds nucleo/build/Bottega Nucleo.app (arm64 only, macOS 27+), ad-hoc signed, and
# points ~/.bottega/bin/nucleo at its executable.
#
#   nucleo/build.sh            release build (-O)
#   nucleo/build.sh --debug    -Onone, with debug info
#
# Version: CFBundleShortVersionString/CFBundleVersion come from bottega.json when it has
# them (version / build), else 0.1.0 / 1. The Metal shader is precompiled into
# default.metallib when the Metal toolchain is installed; otherwise the .metal source
# ships as a resource and is compiled at runtime.
set -euo pipefail

HERE="${0:A:h}"
ROOT="${HERE:h}"
OUT="$HERE/build"
APP="$OUT/Bottega Nucleo.app"
EXE="$APP/Contents/MacOS/BottegaNucleo"
TMP="$OUT/tmp"
OPT="-O"
[[ "${1:-}" == "--debug" ]] && OPT="-Onone -g"

VERSION="0.1.0"
BUILD="1"
if [[ -f "$ROOT/bottega.json" ]]; then
  v=$(/usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("version",""))' "$ROOT/bottega.json" 2>/dev/null || true)
  b=$(/usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("build",""))' "$ROOT/bottega.json" 2>/dev/null || true)
  [[ -n "$v" ]] && VERSION="$v"
  [[ -n "$b" ]] && BUILD="$b"
fi

rm -rf "$APP" "$TMP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$TMP"

SOURCES=("$HERE"/Sources/**/*.swift(N))
echo "nucleo: compilo ${#SOURCES} file Swift ($OPT)"
# Swift 5 language mode: the AVFoundation / Speech / Carbon callbacks this code bridges
# are not annotated for strict concurrency, and the isolation is handled by hand.
xcrun -sdk macosx swiftc \
  -target arm64-apple-macos27.0 \
  -swift-version 5 \
  ${=OPT} \
  -module-name BottegaNucleo \
  -framework AppKit -framework Metal -framework MetalKit -framework AVFoundation \
  -framework Speech -framework FoundationModels -framework NaturalLanguage \
  -framework Accelerate -framework UserNotifications -framework Carbon \
  -o "$EXE" \
  "${SOURCES[@]}"

# Shader: precompiled if possible, source always (runtime fallback).
cp "$HERE/Sources/Orb/OrbShaders.metal" "$APP/Contents/Resources/OrbShaders.metal"
if xcrun -sdk macosx -f metal >/dev/null 2>&1 && \
   xcrun -sdk macosx metal -c -O3 "$HERE/Sources/Orb/OrbShaders.metal" -o "$TMP/orb.air" 2>"$TMP/metal.log" && \
   xcrun -sdk macosx metallib "$TMP/orb.air" -o "$APP/Contents/Resources/default.metallib" 2>>"$TMP/metal.log"; then
  echo "nucleo: shader precompilato (default.metallib)"
else
  echo "nucleo: toolchain Metal assente, lo shader sara' compilato al primo avvio della sfera"
fi

sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
plutil -lint -s "$APP/Contents/Info.plist"

codesign --force --sign - --timestamp=none "$APP"
codesign --verify "$APP"
rm -rf "$TMP"

# Stable path for the Memoria hooks (the coordinator repoints it to the shipped copy).
mkdir -p "$HOME/.bottega/bin"
ln -sfn "$EXE" "$HOME/.bottega/bin/nucleo"

echo "nucleo: pronto $APP ($VERSION, build $BUILD)"
