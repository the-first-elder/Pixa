#!/usr/bin/env bash
# Scene lifecycle tests against an ISOLATED store + throwaway server.
# Covers: gated create, rename, multi-pass join, delete, ensureUser row.
# Requires: server on $BASE with STORAGE_DIR=$STORE, AUTH_SECRET=$AUTH_SECRET,
# and (if server env resolves an https AUTH_URL) matching secure cookies.
# Usage: STORE=/tmp/wl-scenes BASE=http://localhost:3100 AUTH_SECRET=dummy bash scripts/test-scenes.sh
set -u
BASE="${BASE:-http://localhost:3000}"
STORE="${STORE:-/tmp/wl-scenes}"
AUTH_SECRET="${AUTH_SECRET:?set AUTH_SECRET (same secret the server runs with)}"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Cookie flavor must match the server: https AUTH_URL -> secure cookie name.
SECURE=""
case "${AUTH_URL:-}" in https*) SECURE="--secure" ;; esac
HDR=$(AUTH_SECRET="$AUTH_SECRET" npx tsx "$ROOT/scripts/mint-session.mts" --uid google:42424242424242424242 $SECURE | tr -d '\n')
[ -n "$HDR" ] || { echo "FATAL: could not mint test session"; exit 2; }
api() { curl -s -H "Cookie: $HDR" "$@"; }

# 1. create (owner stamped) + read-back
SID=$(api -X POST "$BASE/api/scenes" -H 'Content-Type: application/json' -d '{"name":"qa scene"}' | python3 -c "import json,sys; print(json.load(sys.stdin).get('sceneId',''))")
[ -n "$SID" ] && ok "create scene $SID" || { bad "create scene"; exit 2; }
echo "$SID" | grep -q . || exit 2

# 2. ensureUser wrote the owner row (prevents phantom-owner 404s/mail skips)
python3 - "$STORE" <<'EOF' || { echo "FAIL: owner row"; exit 1; }
import json, sys
users = json.load(open(f"{sys.argv[1]}/users.json"))
assert "google:42424242424242424242" in users, "owner row missing"
print("PASS: ensureUser owner row exists")
EOF
PASS=$((PASS+1))

# 3. rename via PATCH
RN=$(api -X PATCH "$BASE/api/scenes/$SID" -H 'Content-Type: application/json' -d '{"name":"qa scene renamed"}')
echo "$RN" | grep -q "qa scene renamed" && ok "rename scene" || bad "rename scene: $RN"

# 4. join two passes (tiny generated clips)
ffmpeg -v error -y -f lavfi -i testsrc=size=320x240:rate=30:duration=2 -pix_fmt yuv420p -c:v libx264 /tmp/wl-s1.mp4
ffmpeg -v error -y -f lavfi -i testsrc=size=320x240:rate=30:duration=3 -pix_fmt yuv420p -c:v libx264 /tmp/wl-s2.mp4
JR=$(curl -s -H "Cookie: $HDR" -X POST "$BASE/api/scenes/$SID/passes" -F "pass-0=@/tmp/wl-s1.mp4;type=video/mp4" -F "pass-1=@/tmp/wl-s2.mp4;type=video/mp4")
echo "$JR" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('passes')==2, d; print('joined duration:', d['probe']['duration'])" && ok "join 2 passes" || bad "passes join: $JR"
# 4b. mixed container/codec/size + silent webm forces the normalized re-encode
ffmpeg -v error -y -f lavfi -i testsrc=size=160x120:rate=25:duration=2 -pix_fmt yuv420p -c:v vp9 -an /tmp/wl-s3.webm
JR3=$(curl -s -H "Cookie: $HDR" -X POST "$BASE/api/scenes/$SID/passes" -F "pass-0=@/tmp/wl-s1.mp4;type=video/mp4" -F "pass-1=@/tmp/wl-s3.webm;type=video/webm")
echo "$JR3" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('passes')==2 and d.get('reencoded') is True, d; print('mixed join re-encoded:', d['probe']['duration'])" && ok "join mixed mp4+webm (re-encode)" || bad "mixed join: $JR3"
rm -f /tmp/wl-s3.webm

# 5. single pass rejected
JR1=$(curl -s -H "Cookie: $HDR" -X POST "$BASE/api/scenes/$SID/passes" -F "pass-0=@/tmp/wl-s1.mp4;type=video/mp4")
echo "$JR1" | grep -q "at least 2 passes" && ok "single pass rejected" || bad "single pass accepted: $JR1"

# 5b. staged passes: stage individually, finalize joins; missing pass -> 409
SID3=$(api -X POST "$BASE/api/scenes" -H 'Content-Type: application/json' -d '{"name":"qa staged"}' | python3 -c "import json,sys; print(json.load(sys.stdin).get('sceneId',''))")
ST0=$(curl -s -H "Cookie: $HDR" -X POST "$BASE/api/scenes/$SID3/passes/stage" -F "pass=@/tmp/wl-s1.mp4;type=video/mp4" -F "index=0")
echo "$ST0" | grep -q '"staged":true' && ok "stage pass 0" || bad "stage pass 0: $ST0"
FIN0=$(curl -s -H "Cookie: $HDR" -X POST "$BASE/api/scenes/$SID3/passes/finalize" -H 'Content-Type: application/json' -d '{"count":2}')
echo "$FIN0" | grep -q "Pass 2 is not staged" && ok "finalize missing pass -> 409 named" || bad "finalize missing: $FIN0"
curl -s -H "Cookie: $HDR" -X POST "$BASE/api/scenes/$SID3/passes/stage" -F "pass=@/tmp/wl-s2.mp4;type=video/mp4" -F "index=1" > /dev/null
FIN=$(curl -s -H "Cookie: $HDR" -X POST "$BASE/api/scenes/$SID3/passes/finalize" -H 'Content-Type: application/json' -d '{"count":2}')
echo "$FIN" | grep -q '"passes":2' && ok "finalize joins staged passes" || bad "finalize staged: $FIN"
# Reprocess path (recovery): returns 202 + jobId; worker outcome is async.
PROC=$(api -X POST "$BASE/api/scenes/$SID3/process" -H 'Content-Type: application/json' -d '{"backend":"spirula"}')
echo "$PROC" | grep -q '"jobId"' && ok "reprocess accepted (202 + jobId)" || bad "reprocess: $PROC"
api -X DELETE "$BASE/api/scenes/$SID3" > /dev/null

# 6. delete + gone
DEL=$(api -X DELETE "$BASE/api/scenes/$SID")
echo "$DEL" | grep -q "$SID" && ok "delete scene" || bad "delete: $DEL"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Cookie: $HDR" "$BASE/api/scenes/$SID")
[ "$code" = "404" ] && ok "deleted scene 404s" || bad "deleted scene -> $code"

# 7. anon cannot delete others' scenes (401, not 404/200)
SID2=$(api -X POST "$BASE/api/scenes" -H 'Content-Type: application/json' -d '{"name":"qa owned"}' | python3 -c "import json,sys; print(json.load(sys.stdin).get('sceneId',''))")
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/scenes/$SID2")
[ "$code" = "401" ] && ok "anon delete rejected (401)" || bad "anon delete -> $code"
api -X DELETE "$BASE/api/scenes/$SID2" > /dev/null

rm -f /tmp/wl-s1.mp4 /tmp/wl-s2.mp4
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
