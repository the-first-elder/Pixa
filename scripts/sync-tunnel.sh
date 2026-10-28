#!/usr/bin/env bash
# Sync the edge worker's ORIGIN to the currently running quick tunnel.
# Quick-tunnel URLs rotate on every cloudflared restart; the worker keeps
# serving the stale address (530s) until redeployed. Run this after any
# tunnel restart. Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env.
# (Permanent fix: named tunnel with a stable <id>.cfargotunnel.com URL —
# needs a token with Zero Trust → Tunnels:Edit. See workers/pixa-proxy.)
set -u
LOG="${CF_LOG:-/tmp/cf-tunnel.log}"
URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" 2>/dev/null | tail -1)
[ -n "$URL" ] || { echo "FATAL: no tunnel URL in $LOG"; exit 2; }
TOML="$(dirname "$0")/../workers/pixa-proxy/wrangler.toml"
if grep -q "ORIGIN = \"$URL\"" "$TOML" 2>/dev/null; then
  echo "ORIGIN already $URL — nothing to do"
else
  echo "ORIGIN -> $URL"
fi
sed -i '' "s|ORIGIN = \".*\"|ORIGIN = \"$URL\"|" "$TOML"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "FATAL: CLOUDFLARE_API_TOKEN not set"; exit 2; }
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "FATAL: CLOUDFLARE_ACCOUNT_ID not set"; exit 2; }
wrangler deploy --cwd "$(dirname "$0")/../workers/pixa-proxy" 2>&1 | grep -E "Uploaded|Deployed|https://|error" | head -4
echo "live: $(curl -s -o /dev/null -w '%{http_code}' https://pixa.autumn-test.workers.dev/ --max-time 30)"
