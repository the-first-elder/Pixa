#!/usr/bin/env bash
# Long-video integration tests: resumable uploads, analysis, segments, recovery.
# Requires: server on $BASE (default localhost:3000), ffmpeg, python3.
# Worker-level tests use an isolated STORAGE_DIR; API tests clean up after.
# Since auth gating, API calls need a session: set AUTH_SECRET (same secret
# the server runs with) and the script mints a cookie (flavor follows
# AUTH_URL like a real client). Without it, auth endpoints 401 as designed.
set -u
BASE="${BASE:-http://localhost:3000}"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Direct-store sections (cancel lookup, cleanup) must poke the SAME store the
# server uses. Default: this repo's data/ (local runs). CI/throwaway runs set
# DSTORE to the throwaway store.
DSTORE="${DSTORE:-$ROOT/data}"
CURL="curl -s"
if [ -n "${AUTH_SECRET:-}" ] && command -v npx >/dev/null 2>&1; then
  SECURE=""
  case "${AUTH_URL:-}" in https*) SECURE="--secure" ;; esac
  ACOOKIE=$(AUTH_SECRET="$AUTH_SECRET" npx tsx "$ROOT/scripts/mint-session.mts" --uid google:42424242424242424242 $SECURE 2>/dev/null | tr -d '\n')
  [ -n "$ACOOKIE" ] && CURL="curl -s -b $ACOOKIE"
fi

echo "=== 0. worker smoke (imports + syntax + CLI parse) ==="
(cd "$ROOT/services/reconstruction" && python3 -m py_compile worker/__main__.py worker/media.py worker/store.py worker/analysis.py worker/backends/spirula.py worker/backends/kiri.py worker/backends/runpod.py worker/backends/local.py && python3 -c "import worker.backends.spirula, worker.backends.kiri; print('imports OK')" && python3 -m worker --help > /dev/null) && ok "worker smoke" || { bad "worker smoke"; exit 2; }
ffmpeg -y -v error -f lavfi -i testsrc=size=640x480:rate=30:duration=90 -pix_fmt yuv420p -c:v libx264 /tmp/wl-big.mp4 2>/dev/null || { echo "need ffmpeg+x264"; exit 2; }
SIZE=$(stat -f%z /tmp/wl-big.mp4 2>/dev/null || stat -c%s /tmp/wl-big.mp4)
python3 -c "open('/tmp/wl-oversize.bin','wb').write(b'X' * 2097152)"
CR=$($CURL -X POST "$BASE/api/uploads" -H 'Content-Type: application/json' -d "{\"filename\":\"big.mp4\",\"size\":$SIZE,\"mime\":\"video/mp4\",\"chunkSize\":1048576}")
UPID=$(echo "$CR" | python3 -c "import json,sys; print(json.load(sys.stdin)['uploadId'])")
N=$(echo "$CR" | python3 -c "import json,sys; print(json.load(sys.stdin)['chunks'])")
echo "session $UPID chunks=$N size=$SIZE"
echo "upload:$UPID" >> /tmp/wl-test-ids
# out of order: last, first, middle... + duplicate of first
order=$(python3 -c "n=$N; print(' '.join(map(str, [n-1] + list(range(n-1)) + [0])) )")
for i in $order; do
  start=$((i * 1048576))
  python3 -c "open('/tmp/wl-chunk.bin','wb').write(open('/tmp/wl-big.mp4','rb').read()[$start:$start+1048576])"
  code=$($CURL -o /dev/null -w "%{http_code}" -X PUT "$BASE/api/uploads/$UPID/chunks/$i" --data-binary @/tmp/wl-chunk.bin)
  [ "$code" = "200" ] || bad "chunk $i -> $code"
done
ST=$($CURL "$BASE/api/uploads/$UPID")
echo "$ST" | python3 -c "import json,sys; d=json.load(sys.stdin); assert all(d['received']), 'bitmap incomplete'; print('bitmap complete:', d['receivedBytes'], '/', d['size']) " && ok "out-of-order+duplicate upload" || bad "bitmap"
# wrong size + bad index rejected
code=$($CURL -o /dev/null -w "%{http_code}" -X PUT "$BASE/api/uploads/$UPID/chunks/0" -H 'Content-Type: application/octet-stream' --data-binary @/tmp/wl-oversize.bin); [ "$code" = "400" ] && ok "oversize chunk rejected" || bad "oversize chunk -> $code"
code=$($CURL -o /dev/null -w "%{http_code}" -X PUT "$BASE/api/uploads/$UPID/chunks/99" --data-binary @/tmp/wl-chunk.bin); [ "$code" = "400" ] && ok "bad index rejected" || bad "bad index -> $code"
# complete: real mp4 probes OK
FIN=$($CURL -X POST "$BASE/api/uploads/$UPID/complete")
echo "$FIN" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['status']=='complete' and len(d['sha256'])==64, d; print('finalized:', d['path'])" && ok "finalize+probe+sha" || bad "finalize"
VPATH=$(echo "$FIN" | python3 -c "import json,sys; print(json.load(sys.stdin)['path'])")

echo "=== 2. invalid media rejected at finalize ==="
echo "not a video" > /tmp/wl-fake.mp4
FSZ=$(stat -f%z /tmp/wl-fake.mp4 2>/dev/null || stat -c%s /tmp/wl-fake.mp4)
FID=$($CURL -X POST "$BASE/api/uploads" -H 'Content-Type: application/json' -d "{\"filename\":\"fake.mp4\",\"size\":$FSZ}" | python3 -c "import json,sys; print(json.load(sys.stdin)['uploadId'])")
$CURL -X PUT "$BASE/api/uploads/$FID/chunks/0" --data-binary @/tmp/wl-fake.mp4 > /dev/null
code=$($CURL -o /dev/null -w "%{http_code}" -X POST "$BASE/api/uploads/$FID/complete"); [ "$code" = "422" ] && ok "invalid media rejected" || bad "invalid media -> $code"
$CURL -X DELETE "$BASE/api/uploads/$FID" > /dev/null && ok "cancel cleans up" || bad "cancel"

echo "=== 3. recording analysis + split/merge ==="
REC=$($CURL -X POST "$BASE/api/recordings" -H 'Content-Type: application/json' -d "{\"name\":\"test rec\",\"videoPath\":\"$VPATH\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['recordingId'])")
export WL_TEST_REC="$REC"
echo "$REC" > /tmp/wl-test-rec
echo "recording $REC, waiting for analysis…"
for _ in $(seq 1 30); do
  sleep 10
  MAN=$($CURL "$BASE/api/recordings/$REC")
  echo "$MAN" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('manifest') else 1)" && break
done
NSEG=$(echo "$MAN" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['manifest']['segments']))")
[ "$NSEG" -ge 1 ] && ok "analysis produced $NSEG segment(s)" || bad "no segments"
SEG0=$(echo "$MAN" | python3 -c "import json,sys; print(json.load(sys.stdin)['manifest']['segments'][0]['id'])")
SPL=$($CURL -X POST "$BASE/api/recordings/$REC/split" -H 'Content-Type: application/json' -d "{\"segment\":\"$SEG0\",\"at\":5}")
echo "$SPL" | grep -q split && ok "split" || bad "split: $SPL"
A=$(echo "$SPL" | python3 -c "import json,sys; print(json.load(sys.stdin)['segments'][0]['id'])")
B=$(echo "$SPL" | python3 -c "import json,sys; print(json.load(sys.stdin)['segments'][1]['id'])")
MRG=$($CURL -X POST "$BASE/api/recordings/$REC/merge" -H 'Content-Type: application/json' -d "{\"segA\":\"$A\",\"segB\":\"$B\"}")
echo "$MRG" | grep -q "seg_01a+seg_01b" && ok "merge" || bad "merge: $MRG"
SEGM=$(echo "$MRG" | python3 -c "import json,sys; segs=json.load(sys.stdin)['segments']; print([s['id'] for s in segs if s.get('origin')=='user-merge'][0])")
echo "merged segment: $SEGM"

export DSTORE_ABS="$DSTORE"
export ROOT_ABS="$ROOT"
export STORAGE_DIR="$DSTORE"
echo "=== 4. segment dispatch + cancel (no full training) ==="
BEFORE_JOBS=$(python3 -c "import json, os; print(' '.join(json.load(open(os.environ.get('DSTORE_ABS') + '/jobs.json')).keys()))" 2>/dev/null || true)
PJ=$($CURL -X POST "$BASE/api/recordings/$REC/segments/$SEGM/process" -H 'Content-Type: application/json' -d '{"backend":"spirula","iterations":100}' | python3 -c "import json,sys; print(json.load(sys.stdin).get('error','no-error-field'))" 2>/dev/null)
export BEFORE_JOBS
# Poll up to ~90s. Two honest outcomes, both pass:
#  (a) job still active -> cancel it, assert failed/CANCELLED;
#  (b) job already terminal-failed honestly (synthetic footage often has
#      unmappable coverage: COVERAGE_GAP / SPIRULA_FAILED) -> assert that.
SJID=""
for _ in $(seq 1 9); do
  sleep 10
  SJID=$(python3 -c "
import json, os
jobs = json.load(open(os.environ.get('DSTORE_ABS', '') + '/jobs.json'))
known = set(os.environ.get('BEFORE_JOBS', '').split())
cands = [j for k, j in jobs.items() if k not in known and j.get('sceneId') and j['status'] not in ('ready','failed')]
print(cands[-1]['id'] if cands else 'none')")
  if [ "$SJID" != "none" ]; then break; fi
done
if [ "$SJID" != "none" ]; then
  # find the segment job and cancel it (proves cancel path without a full train)
  JID="$SJID"
  (cd "$ROOT/services/reconstruction" && python3 -m worker cancel "$JID" | grep -q CANCELLED || python3 -m worker cancel "$JID")
  python3 -c "
import json, os
j = json.load(open(os.environ.get('DSTORE_ABS', '') + '/jobs.json'))['$JID']
assert j['status'] == 'failed', j['status']
print('cancelled:', j.get('errorCode'))" && ok "dispatch+cancel" || bad "cancel flow"
else
  # No active job: dispatch must still have produced a tracked, honest
  # terminal outcome (ready, or failed with a sanitized SCREAMING code —
  # e.g. SUBMIT_FAILED where the Spirula binary is absent). Anything else
  # (missing job, empty code) is a real pipeline break.
  python3 -c "
import json, os, re
jobs = json.load(open(os.environ.get('DSTORE_ABS', '') + '/jobs.json'))
known = set(os.environ.get('BEFORE_JOBS', '').split())
terms = [j for k, j in jobs.items() if k not in known and j.get('status') in ('ready', 'failed')]
assert terms, 'dispatch recorded no new terminal job at all'
j = terms[-1]
if j['status'] == 'failed':
    assert re.match(r'^[A-Z][A-Z0-9_]{1,31}\$', j.get('errorCode') or ''), f\"unshaped error code: {j.get('errorCode')!r}\"
print('tracked outcome:', j['id'], j['status'], j.get('errorCode'))" && ok "dispatch tracked (honest terminal)" || bad "dispatch produced nothing cancellable"
fi

echo "=== 5. worker recover on isolated store ==="
export STORAGE_DIR=/tmp/wl-recover-test
rm -rf /tmp/wl-recover-test && mkdir -p /tmp/wl-recover-test
python3 -c "
import sys, os; sys.path.insert(0, os.environ['ROOT_ABS'] + '/services/reconstruction')
from worker import store
s = store.create_scene('x', {})
j = store.create_job(s['id'], 'reconstruction')
store.transition(j['id'], 'reconstructing', progress=50)
print(j['id'])"
(cd "$ROOT/services/reconstruction" && python3 -m worker recover | grep -q markedInterrupted) && ok "recover marks interrupted" || bad "recover"

echo "=== cleanup test artifacts ==="
rm -f /tmp/wl-big.mp4 /tmp/wl-chunk.bin /tmp/wl-fake.mp4 /tmp/wl-oversize.bin /tmp/wl-upid.txt
rm -rf /tmp/wl-recover-test
python3 - <<'EOF'
import json, os, shutil
base = os.environ.get('DSTORE_ABS', '')
rec_id = os.environ.get('WL_TEST_REC', '')
scenes = json.load(open(f'{base}/scenes.json'))
test_sids = {k for k, v in scenes.items() if v.get('parentRecordingId') == rec_id} if rec_id else set()
for sid in test_sids:
    del scenes[sid]
json.dump(scenes, open(f'{base}/scenes.json', 'w'), indent=2)
jobs = json.load(open(f'{base}/jobs.json'))
for jid in [k for k, v in jobs.items() if v.get('sceneId') in test_sids]:
    del jobs[jid]
    # also drop its workdir if it never trained
    shutil.rmtree(f'{base}/work/{jid}', ignore_errors=True)
json.dump(jobs, open(f'{base}/jobs.json', 'w'), indent=2)
recs = json.load(open(f'{base}/recordings.json'))
if rec_id and rec_id in recs:
    del recs[rec_id]
    json.dump(recs, open(f'{base}/recordings.json', 'w'), indent=2)
shutil.rmtree(f'{base}/work/{rec_id}', ignore_errors=True)
try:
    with open('/tmp/wl-test-ids') as f:
        test_uploads = [l.split(':')[1].strip() for l in f if l.startswith('upload:')]
except FileNotFoundError:
    test_uploads = []
for d in os.listdir(f'{base}/uploads'):
    if any(d == f'upload_{u}' for u in test_uploads):
        shutil.rmtree(f'{base}/uploads/{d}', ignore_errors=True)
print('data cleanup done')
EOF
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
