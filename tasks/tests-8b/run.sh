#!/bin/sh
# Runs one test file: tasks/tests-8b/run.sh replies   (bundles with esbuild, runs with node)
set -e
cd "$(dirname "$0")/../.."
OUT="${TMPDIR:-/tmp}/tests-8b"
mkdir -p "$OUT"
for name in "$@"; do
  npx esbuild "tasks/tests-8b/$name.test.ts" --bundle --platform=node --format=esm --outfile="$OUT/$name.mjs" --log-level=error
  node "$OUT/$name.mjs"
done
