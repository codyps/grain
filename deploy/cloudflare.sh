#!/usr/bin/env bash
# Deploy the GRAIN PWA to Cloudflare Pages.
# First run: npx wrangler login (or set CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${CLOUDFLARE_PAGES_PROJECT:-xt4-grain}"
cd "$ROOT"

echo "Deploying $ROOT to Cloudflare Pages project $PROJECT"
exec npx --yes wrangler@latest pages deploy "$ROOT" --project-name "$PROJECT"
