#!/bin/zsh
# Esegue i test della chat di Moony per iPhone (ios/Bottega/Chat/ChatPura.swift: modelli, schede, tagli verso il ponte,
# allegati, markdown, zip dei documenti) su macOS, senza simulatore.
set -euo pipefail
ROOT=${0:A:h:h}
TEST_DIR=$(mktemp -d /tmp/bottega-chat-tests.XXXXXX)
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/Sources/Bottega" "$TEST_DIR/Tests/BottegaTests"
cp "$ROOT/ios/Bottega/Chat/ChatPura.swift" "$TEST_DIR/Sources/Bottega/"
cp "$ROOT/ios/Tests/ChatTests.swift" "$TEST_DIR/Tests/BottegaTests/"
cat > "$TEST_DIR/Package.swift" <<'SWIFT'
// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "Chat", platforms: [.macOS(.v13)], targets: [
    .target(name: "Bottega"), .testTarget(name: "BottegaTests", dependencies: ["Bottega"])
])
SWIFT
swift test --package-path "$TEST_DIR" "$@"
