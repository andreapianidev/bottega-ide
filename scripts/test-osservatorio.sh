#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
xcrun swiftc -swift-version 5 \
  "$ROOT/nucleo/Sources/Motore/SkyScene.swift" \
  "$ROOT/nucleo/Sources/Osservatorio/OsservatorioData.swift" \
  "$ROOT/nucleo/Tests/OsservatorioGeometryTests.swift" \
  -o "$TEST_DIR/osservatorio-tests"
"$TEST_DIR/osservatorio-tests"
