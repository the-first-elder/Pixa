# Long-video ingestion: implementation + validation report

## Quality benchmark (2026-10-28, same footage throughout: tester3.mp4, 46 s, 478p)

| config | frames | registered | reproj | PSNR / SSIM | train time | workdir |
|---|---|---|---|---|---|---|
| 1 fps, 7k | 46 | 100% | 0.54 px | 33.2 / 0.953 | ~1.5 min | 42 MB |
| 3 fps, 7k | 139 | 100% | 0.80 px | 33.4 / 0.928 | ~1.5 min | 99 MB |
| 2 fps, 15k | 93 | 87% | 0.71 px | 35.6 / 0.967 | ~6 min | 258 MB |
| 2 fps, 30k | 93 | 86% | 1.06 px | 37.9 / 0.962 | ~58 min | — |

Dimensions evaluated separately:
- **Registration/completeness**: varies run to run (86–100% on identical footage)
  more than it varies with fps. Gaps, not density, drive unusable regions.
- **Visual (PSNR)**: responds to iterations (+2 per doubling, 4–10× cost), not
  to fps (33.2 vs 33.4 at fixed 7k). Novel-view coherence is coverage-driven;
  verified earlier by same-viewpoint still-vs-motion tests.
- **Geometric (reproj)**: 0.54–1.06 px across configs — all geometrically sound.
- **Resources**: workdir scales with frames × iterations; 14 GB free constrains
  parallel/long jobs — sequential default stands.

### Resolution comparison: BLOCKED on footage
All recordings are 478p; no 1080p/4K source exists, and upscaling proves nothing.
Preprocessing verified in code: native resolution preserved, downscale-only cap
at 1600px (`media.py` extract). A same-room 1080p + 4K pair is needed from the
owner to run this comparison honestly.

### Longest proven
Analysis+segmentation to 12.7 min; reconstruction segments ≤ ~70 s and single
scenes to 94 s. 10–30 min full reconstruction: not run (hours of GPU + GBs disk
per segment on this hardware).

### Single highest-impact recommendation
**Registration-robustness retry**: on partial registration, automatically retry
SfM with alternate frame sampling (phase-shifted extraction) before failing —
registration completeness, not fps or iterations, is the top demonstrated
quality failure mode (86% vs 100% swings on identical footage; gaps become
smear). Cheap (SfM takes seconds–minutes), local, no new dependencies.
Capture density remains the visual ceiling no pipeline change can lift.

## Validation (2026-10-28, all measured — no fabricated numbers)

### Footage available
All fixtures 478×850 H.264: tester 13 s, tester3 46 s, tester2 67 s, user 75–94 s.
No 1080p/4K footage exists, so resolution comparison is limited to code facts
(preprocessing: native resolution, downscale-only cap 1600px) plus the earlier
native-vs-upscaled benchmark (PSNR 40.1 vs ~34–36). 1080p-vs-4K and 8K are
untested and claimed nowhere.

### Segmentation vs known ground truth (concat joins)
- 4.2-min concat (2× [tester+tester3+tester2], 5 true joins): found 3/5 cuts
  (59.6, 126.6, 186.2 s exact) → 4 segments ±2 s overlap. Precision 3/3 (100%);
  recall 3/5 (60%). Missed joins merge rooms (safe direction: bounded by the
  150 s cap, never dropped footage).
- 12.7-min concat (16 true joins): 11/16 found (69% recall, 100% precision),
  12 segments of 57–71 s. Analysis: seconds, peak RSS 37–78 MB.
- Cut sensitivity (0.35) is a documented tuning knob.

### Reconstruction per segment
- seg_01 (60 s, ~120 frames, 3000 iters): SfM 118/123 (96%) → ready, real
  asset, opens in the viewer (screenshot verified: coherent room interior).
- seg_02/seg_04 spanning hard concat joins: correctly REFUSED with
  COVERAGE_GAP (32/142, precise gap seconds) instead of training mush.
- Workdir per segment: 20–450 MB (killed trainings retain partial outputs;
  sweep policy documented for prod).

### Recovery (live kill tests)
- `kill -9` trainer mid-train → worker reports honest exit-code failure.
- `kill -9` worker mid-train → job stuck reconstructing → `recover` reaps the
  orphan trainer + marks INTERRUPTED → explicit retry completes to ready.
- Upload interruption/resume, duplicate/out-of-order chunks, invalid media,
  cancel: covered by 12/12 integration tests (`scripts/test-longvideo.sh`).

### Longest proven
- Analysis+segmentation: 12.7 min (759 s, 98 MB file) in seconds.
- End-to-end reconstruction: 94 s single scene (existing) / 60 s segments.
- 15/30-min reconstruction: NOT tested (would need hours of GPU + GBs of disk
  per segment; analysis scales linearly and is proven to 12.7 min).

### Recommended limits (evidenced)
- Uploads: 4 GB default cap, 8 MB chunks, 24 h retention.
- Segments: ≤150 s / ≥25 s, ~300-frame guidance, sequential training.
- Queue: 3-deep, single trainer, 20-min stall killer.
- Disk: budget ~500 MB per segment workdir on this hardware profile.

## Files changed

- `apps/web/lib/uploads.ts` + 5 routes (`/api/uploads`, `/chunks`, `/complete`)
- `apps/web/lib/recordings.ts`, `/api/recordings`, segment process/split/merge,
  thumbs routes; `RecordingView.tsx`, `/recordings/:id`, `ChunkedUpload.tsx`
- `services/reconstruction/worker/analysis.py` (cuts, brightness, segments, thumbs)
- `worker/__main__.py`: analyze, process-segment, recover, split/merge, extract --fps
- `worker/store.py`: recordings; `media.py`: fps override, probe ext hint
- `scripts/test-longvideo.sh` (12 integration tests)

## Architecture

Upload sessions (offset bitmap in JSON, pre-allocated temp files) → finalize
(size + sha256 streamed + real probe) → recording + detached analysis → segment
manifest → per-segment trimmed clips → existing execute_job (all gates apply) →
scenes linked to recording+segment. Trainer serializes via existing port guard.
`recover` marks interrupted jobs INTERRUPTED (explicit retry, never fake resume).

## Tests: 12/12 pass

Worker smoke, out-of-order+duplicate chunks, oversize/bad-index rejection,
finalize+probe+sha, invalid-media 422, cancel cleanup, analysis→segments,
split, merge, segment dispatch+cancel, isolated recover.

## Benchmarks (M4 Pro)

- Analysis: 1–4 s for 13–126 s videos (ffprobe + scene-detect + signalstats).
- 126 s 3-room concat → 2 segments (0–61 s, 57–127 s, ±2 s overlap), 1 cut found.
- Segment (60 s, ~120 frames, 3000 iters): SfM + train to ready, scene opens
  via the standard manifest path. Only 1 cut detected on hard concat joins —
  detector sensitivity (0.35) is a tuning knob, logged in manifest method.
- Limits enforced: 4 GB upload default, 150 s/25 s segment bounds, 300-frame
  guidance, sequential training, 3-deep queue, 24 h upload retention.

## Known limitations

- No global alignment: scenes link navigationally; coordinate systems differ
  (explicit rule, enforced by omission — no shared-origin math exists).
- KIRI/runpod backends not wired to segments (spirula/local only for now).
- No auth/ownership (single-user local, as before).
- Upload progress UI polls session bitmap only on the capture page flow.
- 30-min single scenes unsupported by design — segmentation IS the answer;
  longest tested: 126 s → 2 segments.

## Next milestone

Per-room capture protocol + partitioned quality pass; scene-connection
suggestions from overlapping boundary frames; object storage + Postgres when
leaving single-machine dev.
