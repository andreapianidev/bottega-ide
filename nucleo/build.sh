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
#
# App Intents without Xcode: swiftc runs whole-module and emits the compile-time
# constant values of the AppIntents protocols (-emit-const-values-path, with the same
# protocol list Xcode uses), the linker writes its dependency info, then
# appintentsmetadataprocessor turns all that into Contents/Resources/Metadata.appintents,
# the bundle Comandi rapidi and Spotlight read. Same flags Xcode 27 passes (see
# AppIntentsMetadata.xcspec in Xcode). The build fails if the intents are not in it.
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

SOURCES=("$HERE"/Sources/**/*.swift(N) "$HERE"/Shared/**/*.swift(N))
TRIPLE="arm64-apple-macos27.0"
BUNDLE_ID="com.andreapiani.bottega.nucleo"
# The protocols whose conformances the compiler records for the App Intents extractor
# (the list Xcode 27 writes into <target>_const_extract_protocols.json).
print -r -- '["AnyResolverProviding","AppEntity","AppEnum","AppExtension","AppIntent","AppIntentsPackage","AppShortcutProviding","AppShortcutsProvider","AppUnionValue","AppUnionValueCasesProviding","DynamicOptionsProvider","EntityQuery","ExtensionPointDefining","IntentValueQuery","Resolver","TransientEntity","_AssistantIntentsProvider","_GenerativeFunctionExtractable","_IntentValueRepresentable"]' > "$TMP/const_extract_protocols.json"

echo "nucleo: compilo ${#SOURCES} file Swift ($OPT)"
# Swift 5 language mode: the AVFoundation / Carbon callbacks this code bridges
# are not annotated for strict concurrency, and the isolation is handled by hand.
xcrun -sdk macosx swiftc \
  -target $TRIPLE \
  -swift-version 5 \
  ${=OPT} \
  -wmo \
  -module-name BottegaNucleo \
  -emit-const-values-path "$TMP/BottegaNucleo.swiftconstvalues" \
  -const-gather-protocols-list "$TMP/const_extract_protocols.json" \
  -framework AppKit -framework Metal -framework MetalKit -framework AVFoundation \
  -framework FoundationModels -framework NaturalLanguage \
  -framework Accelerate -framework UserNotifications -framework Carbon \
  -framework IOKit -framework CoreSpotlight -framework UniformTypeIdentifiers -framework AppIntents \
  -framework WidgetKit -framework SwiftUI -framework Charts -framework Vision -framework ScreenCaptureKit \
  -Xlinker -dependency_info -Xlinker "$TMP/BottegaNucleo_dependency_info.dat" \
  -o "$EXE" \
  "${SOURCES[@]}"

# App Intents metadata (Comandi rapidi, Spotlight, Siri).
print -rl -- "${SOURCES[@]}" > "$TMP/BottegaNucleo.SwiftFileList"
print -r -- "$TMP/BottegaNucleo.swiftconstvalues" > "$TMP/BottegaNucleo.SwiftConstValuesFileList"
: > "$TMP/DependencyMetadataFileList"
: > "$TMP/DependencyStaticMetadataFileList"
SWIFTC=$(xcrun -sdk macosx --find swiftc)
TOOLCHAIN="${SWIFTC:h:h:h}"
SDKROOT_PATH=$(xcrun -sdk macosx --show-sdk-path)
XCODE_BUILD=$(xcodebuild -version 2>/dev/null | awk '/Build version/ {print $3}')
xcrun -sdk macosx appintentsmetadataprocessor \
  --toolchain-dir "$TOOLCHAIN" \
  --module-name BottegaNucleo \
  --sdk-root "$SDKROOT_PATH" \
  --xcode-version "${XCODE_BUILD:-27A0000}" \
  --platform-family macOS \
  --deployment-target 27.0 \
  --bundle-identifier "$BUNDLE_ID" \
  --output "$APP/Contents/Resources" \
  --target-triple $TRIPLE \
  --binary-file "$EXE" \
  --dependency-file "$TMP/BottegaNucleo_dependency_info.dat" \
  --stringsdata-file "$TMP/ExtractedAppShortcutsMetadata.stringsdata" \
  --source-file-list "$TMP/BottegaNucleo.SwiftFileList" \
  --metadata-file-list "$TMP/DependencyMetadataFileList" \
  --static-metadata-file-list "$TMP/DependencyStaticMetadataFileList" \
  --swift-const-vals-list "$TMP/BottegaNucleo.SwiftConstValuesFileList" \
  --force --compile-time-extraction --deployment-aware-processing --no-app-shortcuts-localization \
  > "$TMP/appintents.log" 2>&1 || { cat "$TMP/appintents.log" >&2; echo "nucleo: appintentsmetadataprocessor fallito" >&2; exit 1; }
grep -E "warning|error" "$TMP/appintents.log" | sed 's/^/nucleo: appintents: /' >&2 || true
ACTIONS="$APP/Contents/Resources/Metadata.appintents/extract.actionsdata"
if [[ ! -f "$ACTIONS" ]] || ! grep -q '"ChiediAMelissa"' "$ACTIONS" || ! grep -q '"ProgettoEntity"' "$ACTIONS"; then
  cat "$TMP/appintents.log" >&2
  echo "nucleo: Metadata.appintents manca o non contiene le intents: Comandi rapidi non le vedrebbe" >&2
  exit 1
fi
echo "nucleo: Metadata.appintents pronto ($(/usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get("actions",{})), "intents,", sum(len(s.get("phraseTemplates",[])) for s in d.get("autoShortcuts",[])), "frasi")' "$ACTIONS" 2>/dev/null || echo '?'))"

# Desktop widget: an app extension in Contents/PlugIns, sandboxed (it reads only
# ~/.bottega/stato.json through a read-only exception) and signed before the app.
# Linked the way Xcode links app extensions: entry point _NSExtensionMain.
# It carries the Control Center controls too, whose intents (Shared/AzioniRapide.swift)
# need their own Metadata.appintents inside the appex, built the same way as the app's.
WIDGET="$APP/Contents/PlugIns/BottegaWidget.appex"
WEXE="$WIDGET/Contents/MacOS/BottegaWidget"
WSOURCES=("$HERE"/Widget/*.swift "$HERE/Sources/Stato.swift" "$HERE"/Shared/**/*.swift(N))
mkdir -p "$WIDGET/Contents/MacOS" "$WIDGET/Contents/Resources"
echo "nucleo: compilo il widget (${#WSOURCES} file)"
xcrun -sdk macosx swiftc \
  -target $TRIPLE \
  -swift-version 5 \
  ${=OPT} \
  -wmo -parse-as-library -application-extension \
  -module-name BottegaWidget \
  -emit-const-values-path "$TMP/BottegaWidget.swiftconstvalues" \
  -const-gather-protocols-list "$TMP/const_extract_protocols.json" \
  -framework SwiftUI -framework WidgetKit -framework AppIntents -framework Charts \
  -Xlinker -e -Xlinker _NSExtensionMain \
  -Xlinker -dependency_info -Xlinker "$TMP/BottegaWidget_dependency_info.dat" \
  -o "$WEXE" \
  "${WSOURCES[@]}"
print -rl -- "${WSOURCES[@]}" > "$TMP/BottegaWidget.SwiftFileList"
print -r -- "$TMP/BottegaWidget.swiftconstvalues" > "$TMP/BottegaWidget.SwiftConstValuesFileList"
xcrun -sdk macosx appintentsmetadataprocessor \
  --toolchain-dir "$TOOLCHAIN" \
  --module-name BottegaWidget \
  --sdk-root "$SDKROOT_PATH" \
  --xcode-version "${XCODE_BUILD:-27A0000}" \
  --platform-family macOS \
  --deployment-target 27.0 \
  --bundle-identifier "$BUNDLE_ID.widget" \
  --output "$WIDGET/Contents/Resources" \
  --target-triple $TRIPLE \
  --binary-file "$WEXE" \
  --dependency-file "$TMP/BottegaWidget_dependency_info.dat" \
  --stringsdata-file "$TMP/BottegaWidget.stringsdata" \
  --source-file-list "$TMP/BottegaWidget.SwiftFileList" \
  --metadata-file-list "$TMP/DependencyMetadataFileList" \
  --static-metadata-file-list "$TMP/DependencyStaticMetadataFileList" \
  --swift-const-vals-list "$TMP/BottegaWidget.SwiftConstValuesFileList" \
  --force --compile-time-extraction --deployment-aware-processing --no-app-shortcuts-localization \
  > "$TMP/appintents-widget.log" 2>&1 || { cat "$TMP/appintents-widget.log" >&2; echo "nucleo: metadata del widget fallito" >&2; exit 1; }
if ! grep -q '"ParlaConMelissa"' "$WIDGET/Contents/Resources/Metadata.appintents/extract.actionsdata" 2>/dev/null; then
  cat "$TMP/appintents-widget.log" >&2
  echo "nucleo: il widget non ha le intents dei controlli: il Centro di Controllo non li eseguirebbe" >&2
  exit 1
fi
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" "$HERE/Widget/Info.plist" > "$WIDGET/Contents/Info.plist"
plutil -lint -s "$WIDGET/Contents/Info.plist"
codesign --force --sign - --timestamp=none --entitlements "$HERE/Widget/Widget.entitlements" "$WIDGET"

# Shaders: every .metal in Sources (orb, sky) precompiled into ONE default.metallib (the
# shared MetalEngine loads it once); the sources always ship too (runtime fallback, one
# library per file).
METALS=("$HERE"/Sources/**/*.metal(N))
for m in $METALS; do cp "$m" "$APP/Contents/Resources/${m:t}"; done
AIRS=()
metal_ok=0
if xcrun -sdk macosx -f metal >/dev/null 2>&1; then
  metal_ok=1
  : > "$TMP/metal.log"
  for m in $METALS; do
    a="$TMP/${m:t:r}.air"
    xcrun -sdk macosx metal -c -O3 "$m" -o "$a" 2>>"$TMP/metal.log" || { metal_ok=0; break; }
    AIRS+=("$a")
  done
  (( metal_ok )) && xcrun -sdk macosx metallib "${AIRS[@]}" -o "$APP/Contents/Resources/default.metallib" 2>>"$TMP/metal.log" || metal_ok=0
fi
if (( metal_ok )); then
  echo "nucleo: shader precompilati (default.metallib, ${#METALS} file)"
else
  rm -f "$APP/Contents/Resources/default.metallib"
  echo "nucleo: toolchain Metal assente o shader in errore, compilati al primo uso (vedi $TMP/metal.log)"
fi

sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
# La stessa icona della Bottega: la vedono Comandi rapidi, il widget e le notifiche.
if [[ -f "$ROOT/brand/Bottega.icns" ]]; then
  cp "$ROOT/brand/Bottega.icns" "$APP/Contents/Resources/Bottega.icns"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string Bottega" "$APP/Contents/Info.plist" 2>/dev/null || true
fi
plutil -lint -s "$APP/Contents/Info.plist"

codesign --force --sign - --timestamp=none "$APP"
codesign --verify "$APP"
rm -rf "$TMP"

# Stable path for the Memoria hooks (the coordinator repoints it to the shipped copy).
mkdir -p "$HOME/.bottega/bin"
ln -sfn "$EXE" "$HOME/.bottega/bin/nucleo"

echo "nucleo: pronto $APP ($VERSION, build $BUILD)"
