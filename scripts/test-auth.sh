#!/usr/bin/env bash
# Auth/authorization HTTP tests. Requires dev server WITH dummy creds set
# (AUTH_SECRET + GOOGLE_CLIENT_ID/SECRET = any non-empty values) so
# enforcement is active but no real Google login exists (all requests anon).
# Usage: BASE=http://localhost:3000 bash scripts/test-auth.sh
set -u
BASE="${BASE:-http://localhost:3000}"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
expect() { # expect <want-code> <desc> <curl-args...>
  local want="$1" desc="$2"; shift 2
  code=$(curl -s -o /dev/null -w "%{http_code}" "$@")
  if [ "$code" = "$want" ]; then ok "$desc"; else bad "$desc (want $want got $code)"; fi
}

ME=$(curl -s "$BASE/api/me")
echo "$ME" | grep -q '"enabled":true' || { echo "FATAL: server not in auth-enabled mode: $ME"; exit 2; }
ok "auth enabled, anon session null"

# Public demo (scene_5abb5015) open without login.
expect 200 "public demo scene read" "$BASE/api/scenes/scene_5abb5015"
expect 200 "public demo asset" "$BASE/api/scenes/scene_5abb5015/asset"
expect 200 "landing" "$BASE/"
expect 200 "signin page" "$BASE/signin"
# Worlds redirects to signin when anonymous.
code=$(curl -s -o /dev/null -w "%{http_code}" --max-redirs 0 "$BASE/worlds"); [ "$code" = "307" ] || [ "$code" = "302" ] && ok "worlds redirects anon" || bad "worlds redirect (got $code)"

# Creates require auth.
expect 401 "anon scene create" -X POST "$BASE/api/scenes" -H 'Content-Type: application/json' -d '{"name":"x"}'
expect 401 "anon upload session" -X POST "$BASE/api/uploads" -H 'Content-Type: application/json' -d '{"filename":"a.mp4","size":10}'
expect 401 "anon recording create" -X POST "$BASE/api/recordings" -H 'Content-Type: application/json' -d '{"name":"x","videoPath":"/tmp/x"}'
expect 401 "anon query on public demo" -X POST "$BASE/api/scenes/scene_5abb5015/query" -H 'Content-Type: application/json' -d '{"message":"hi"}'
expect 401 "anon notifications list" "$BASE/api/notifications"

# Legacy records grandfathered (read open).
expect 200 "legacy scene read" "$BASE/api/scenes/scene_d7259e7e"

# Owner-stamped isolation: stamp, verify 404/401/403, restore.
python3 -c "
import json
p = '/Users/thefirstelder/Documents/Pixa/data/scenes.json'
s = json.load(open(p)); s['scene_d88d263e']['ownerId'] = 'google:some-other-user'; json.dump(s, open(p, 'w'), indent=2)
"
expect 404 "owned-private scene read anon" "$BASE/api/scenes/scene_d88d263e"
expect 404 "owned-private page anon" "$BASE/scenes/scene_d88d263e"
expect 401 "owned-private PATCH anon" -X PATCH "$BASE/api/scenes/scene_d88d263e" -H 'Content-Type: application/json' -d '{"name":"hijack"}'
expect 404 "owned-private asset anon" "$BASE/api/scenes/scene_d88d263e/asset"
python3 -c "
import json
p = '/Users/thefirstelder/Documents/Pixa/data/scenes.json'
s = json.load(open(p)); s['scene_d88d263e']['ownerId'] = None; json.dump(s, open(p, 'w'), indent=2)
"
echo "stamp restored to legacy"

echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
