#!/bin/bash
# Builds only the small shared diagnostic into a temporary directory. No app signing/install.
set -euo pipefail
worker_script_dir="$(cd "$(dirname "$0")" && pwd)"
worker_root_dir="$(dirname "$worker_script_dir")"
worker_scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/bottega-worker-benchmark.XXXXXX")"
trap 'rm -rf "$worker_scratch_dir"' EXIT
xcrun --sdk macosx swiftc -O -swift-version 5 -parse-as-library \
  "$worker_root_dir/ios/Bottega/Worker/WorkerBenchmark.swift" \
  "$worker_script_dir/benchmark-worker-main.swift" \
  -framework Foundation -framework NaturalLanguage -framework Vision \
  -framework CoreGraphics -framework CoreText -framework ImageIO -framework CryptoKit \
  -o "$worker_scratch_dir/benchmark-worker"
"$worker_scratch_dir/benchmark-worker" "$@"
