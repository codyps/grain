#!/usr/bin/env bash
# Deploy the GRAIN PWA to Netlify.
# First run: npx netlify-cli login (or set NETLIFY_AUTH_TOKEN).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Deploying $ROOT to Netlify"
exec npx --yes netlify-cli@latest deploy --prod --dir "$ROOT"
