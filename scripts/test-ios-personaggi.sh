#!/bin/zsh
# Esegue i test dei personaggi di Melissa (ios/Bottega/Voce/Personaggi.swift) su macOS, senza simulatore.
set -euo pipefail
ROOT=${0:A:h:h}
TEST_DIR=$(mktemp -d /tmp/bottega-personaggi-tests.XXXXXX)
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/Sources/Bottega" "$TEST_DIR/Tests/BottegaTests"
cp "$ROOT/ios/Bottega/Voce/Personaggi.swift" "$TEST_DIR/Sources/Bottega/"
cp "$ROOT/ios/Tests/PersonaggiTests.swift" "$TEST_DIR/Tests/BottegaTests/"
cat > "$TEST_DIR/Package.swift" <<'SWIFT'
// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "Personaggi", platforms: [.macOS(.v13)], targets: [
    .target(name: "Bottega"), .testTarget(name: "BottegaTests", dependencies: ["Bottega"])
])
SWIFT
# i personaggi veri, dai file del repository
BOTTEGA_PERSONAGGI="$ROOT/extensions/bottega-home/personaggi" swift test --package-path "$TEST_DIR" "$@"
