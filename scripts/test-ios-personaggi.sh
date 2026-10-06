#!/bin/zsh
# Esegue i test dei personaggi e dei riempitivi di Melissa (ios/Bottega/Voce/Personaggi.swift, Riempitivi.swift) su
# macOS, senza simulatore.
set -euo pipefail
ROOT=${0:A:h:h}
TEST_DIR=$(mktemp -d /tmp/bottega-personaggi-tests.XXXXXX)
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/Sources/Bottega" "$TEST_DIR/Tests/BottegaTests"
# Personaggi.swift legge anche i riempitivi (Riempitivi.swift): le regole della 9.11 stanno nei due file
# SegniVoce.swift: quando cambia il nome di chi parla (logica pura di FlussoVoce)
cp "$ROOT/ios/Bottega/Voce/Personaggi.swift" "$ROOT/ios/Bottega/Voce/Riempitivi.swift" "$ROOT/ios/Bottega/Voce/SegniVoce.swift" \
    "$TEST_DIR/Sources/Bottega/"
cp "$ROOT/ios/Tests/PersonaggiTests.swift" "$ROOT/ios/Tests/RiempitiviTests.swift" "$ROOT/ios/Tests/SegniVoceTests.swift" \
    "$TEST_DIR/Tests/BottegaTests/"
cat > "$TEST_DIR/Package.swift" <<'SWIFT'
// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "Personaggi", platforms: [.macOS(.v13)], targets: [
    .target(name: "Bottega"), .testTarget(name: "BottegaTests", dependencies: ["Bottega"])
])
SWIFT
# i personaggi veri, dai file del repository
BOTTEGA_PERSONAGGI="$ROOT/extensions/bottega-home/personaggi" swift test --package-path "$TEST_DIR" "$@"
