#!/bin/sh
# Bundle one local TypeScript script and run it with Node: sh scripts/build.sh load|equiv
# The bundle goes to .cache/, one folder down like scripts/, so the relative imports left external still resolve.
set -e
cd "$(dirname "$0")/.."
mkdir -p .cache
name="$1"; shift
../node_modules/.bin/esbuild "scripts/$name.ts" --bundle --platform=node --format=esm --packages=external --log-level=warning \
  --alias:@netlify/blobs=./scripts/memory-blobs.ts --alias:node:https=../whole-app/src/https-stub.ts \
  --external:../../scripts/env.mjs --external:../db/data.mjs --external:../../whole-app/db/seed-kv.mjs \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
  --outfile=".cache/$name.mjs"
node ".cache/$name.mjs" "$@"
