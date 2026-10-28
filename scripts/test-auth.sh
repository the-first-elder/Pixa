#!/usr/bin/env bash
# Auth/authorization HTTP tests against an ISOLATED store.
# The server must run with STORAGE_DIR=$STORE and dummy creds set
# (AUTH_SECRET + GOOGLE_CLIENT_ID/SECRET = any non-empty values) so
# enforcement is active but no real Google login exists (all requests anon).
# Seeds its own fixtures (public/legacy/owned scenes + tiny fake asset);
# never touches real data. No billed API calls (401s fire before AI work).
# Usage: STORE=/tmp/wl-authtest BASE=http://localhost:3000 bash scripts/test-auth.sh
set -u
BASE="${BASE:-http://localhost:3000}"
STORE="${STORE:-/tmp/wl-authtest}"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
expect() { # expect <want-code> <desc> <curl-args...>
  local want="$1" desc="$2"; shift 2
  code=$(curl -s -o /dev/null -w "%{http_code}" "$@")
  if [ "$code" = "$want" ]; then ok "$desc"; else bad "$desc (want $want got $code)"; fi
}

# --- seed fixtures into the isolated store ---
mkdir -p "$STORE/assets/scene_pub"
printf 'seed-spz-bytes' > "$STORE/assets/scene_pub/seed.spz"
python3 - "$STORE" <<'EOF'
import json, sys
store = sys.argv[1]
now = "2026-10-28T00:00:00Z"
base_scene = {"status": "created", "createdAt": now, "sourceVideo": None,
              "visualAssetId": None, "manifestId": None, "sceneGraphVersion": 0,
              "processingError": None}
scenes = {
    "scene_pub": {**base_scene, "id": "scene_pub", "name": "Public Demo",
                  "visibility": "public", "ownerId": None},
    "scene_leg": {**base_scene, "id": "scene_leg", "name": "Legacy Room",
                  "visibility": "private", "ownerId": None},
    "scene_own": {**base_scene, "id": "scene_own", "name": "Someone Elses",
                  "visibility": "private", "ownerId": "google:some-other-user"},
}
jobs = {
    "job_seed1": {"id": "job_seed1", "sceneId": "scene_pub",
                  "jobType": "reconstruction", "status": "ready",
                  "progress": 100, "startedAt": now, "completedAt": now,
                  "errorCode": None, "errorMessage": None,
                  "diagnostics": {"seeded": True}, "transitions": [],
                  "asset": {"assetPath": f"{store}/assets/scene_pub/seed.spz",
                            "format": "spz", "posesPath": None,
                            "posesFormat": "colmap-sparse"},
                  "ownerId": None},
}
json.dump(scenes, open(f"{store}/scenes.json", "w"), indent=2)
json.dump(jobs, open(f"{store}/jobs.json", "w"), indent=2)
print("seeded 3 scenes, 1 ready job")
EOF

ME=$(curl -s "$BASE/api/me")
echo "$ME" | grep -q '"enabled":true' || { echo "FATAL: server not in auth-enabled mode: $ME"; exit 2; }
ok "auth enabled, anon session null"

# Public scene open without login.
expect 200 "public scene read" "$BASE/api/scenes/scene_pub"
expect 200 "public asset" "$BASE/api/scenes/scene_pub/asset"
expect 200 "landing" "$BASE/"
expect 200 "signin page" "$BASE/signin"
# Worlds redirects to signin when anonymous.
code=$(curl -s -o /dev/null -w "%{http_code}" --max-redirs 0 "$BASE/worlds"); [ "$code" = "307" ] || [ "$code" = "302" ] && ok "worlds redirects anon" || bad "worlds redirect (got $code)"

# Creates require auth.
expect 401 "anon scene create" -X POST "$BASE/api/scenes" -H 'Content-Type: application/json' -d '{"name":"x"}'
expect 401 "anon upload session" -X POST "$BASE/api/uploads" -H 'Content-Type: application/json' -d '{"filename":"a.mp4","size":10}'
expect 401 "anon recording create" -X POST "$BASE/api/recordings" -H 'Content-Type: application/json' -d '{"name":"x","videoPath":"/tmp/x"}'
expect 401 "anon query on public scene" -X POST "$BASE/api/scenes/scene_pub/query" -H 'Content-Type: application/json' -d '{"message":"hi"}'
expect 401 "anon notifications list" "$BASE/api/notifications"

# Legacy records grandfathered (read open).
expect 200 "legacy scene read" "$BASE/api/scenes/scene_leg"

# Owner-stamped isolation: private scenes are not enumerable anon.
expect 404 "owned-private scene read anon" "$BASE/api/scenes/scene_own"
expect 401 "owned-private PATCH anon" -X PATCH "$BASE/api/scenes/scene_own" -H 'Content-Type: application/json' -d '{"name":"hijack"}'
expect 404 "owned-private asset anon" "$BASE/api/scenes/scene_own/asset"

echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
