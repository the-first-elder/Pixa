#!/usr/bin/env bash
# Supervised quick tunnel: start cloudflared, then re-point the edge worker
# at whatever URL it got (quick URLs rotate on every restart). Reads
# CLOUDFLARE_* from ~/.config/pixa/cloudflare.env when present; without it
# the tunnel still serves, but the public workers.dev URL goes stale until
# scripts/sync-tunnel.sh is run manually.
set -u
LOG="${CF_LOG:-/tmp/cf-tunnel.log}"
: > "$LOG"
if [ -f "$HOME/.config/pixa/cloudflare.env" ]; then
  # shellcheck disable=SC1090
  set -a; source "$HOME/.config/pixa/cloudflare.env"; set +a
fi
/opt/homebrew/bin/cloudflared tunnel --url http://localhost:3000 >>"$LOG" 2>&1 &
TUNNEL_PID=$!
# Wait for the tunnel URL (max 60s), then sync the edge worker.
for _ in $(seq 1 30); do
  sleep 2
  if grep -qoE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" 2>/dev/null; then
    break
  fi
done
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  # Run the REPO sync script (it derives repo paths from its own location,
  # so the ~/.config copy — made by INSTALL.md — pointed at nonexistent dirs.
  # Reading a script from Documents is fine; only exec'ing one under
  # Documents fails under launchd, and bash is the interpreter here).
  CF_LOG="$LOG" /bin/bash "$HOME/Documents/Pixa/scripts/sync-tunnel.sh" >>"$LOG" 2>&1 || true
else
  echo "no Cloudflare credentials: skipping worker sync (run scripts/sync-tunnel.sh manually)" >>"$LOG"
fi
wait $TUNNEL_PID
