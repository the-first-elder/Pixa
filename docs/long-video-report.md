# Long-video ingestion: implementation report

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
