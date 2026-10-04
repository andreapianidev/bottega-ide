#!/bin/zsh
# Esegue la classe iOS reale su macOS, senza simulatore, microfono o chiavi.
# I test ElevenLabs reali richiedono BOTTEGA_TEST_REALE=1 e le chiavi nell'ambiente.
set -euo pipefail
ROOT=${0:A:h:h}
TEST_DIR=$(mktemp -d /tmp/bottega-voice-tests.XXXXXX)
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/Sources/Bottega" "$TEST_DIR/Tests/BottegaTests"
cp "$ROOT/ios/Bottega/Voce/VoceTelefono.swift" "$TEST_DIR/Sources/Bottega/"
cp "$ROOT/ios/Tests/VoceTelefono"*Tests.swift "$TEST_DIR/Tests/BottegaTests/"
cat > "$TEST_DIR/Package.swift" <<'SWIFT'
// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "VoiceRegression", platforms: [.macOS(.v13)], targets: [
    .target(name: "Bottega"), .testTarget(name: "BottegaTests", dependencies: ["Bottega"])
])
SWIFT
cat > "$TEST_DIR/Sources/Bottega/Stubs.swift" <<'SWIFT'
import Foundation
enum Log { static func info(_ text: String) {} ; static func warn(_ text: String) {} }
struct ErrorePonte: LocalizedError { let messaggio: String; var errorDescription: String? { messaggio } }
SWIFT
swift test --package-path "$TEST_DIR" "$@"
