#!/usr/bin/env bash
# Build a zip for Netlify Drop (https://app.netlify.com/drop).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(dirname "$ROOT")/grain-pwa.zip"
rm -f "$OUT"

( cd "$ROOT" && zip -r "$OUT" . \
    -x 'deploy/*' \
    -x '.github/*' \
    -x '*.zip' )

echo "Wrote $OUT"
echo "Drag it to https://app.netlify.com/drop"
