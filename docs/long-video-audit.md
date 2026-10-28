# Phase 0 audit: long-video readiness (verified 2026-10-28)

## Current architecture

- Next.js 16 App Router. Routes: `/`, `/capture`, `/scenes/:id`, `/api/scenes`, `/api/jobs`, `/api/capture/*`.
- No auth, no tests, single local user.

## Bottlenecks (verified, not assumed)

1. **Upload buffers whole file**: `Buffer.from(await file.arrayBuffer())` in
   `upload/route.ts`. Default cap 500 MB (`MAX_UPLOAD_BYTES`). Multi-GB = OOM.
2. **Storage is local JSON** (`data/*.json`, atomic tmp+rename writes). Survives
   restarts ✓ but no object storage; disk free only **~14 GB**.
3. **Worker is synchronous, no checkpoints**: `run-job` runs extract→sfm→train
   in one process. Train writes ckpts but resume is NOT wired — retry restarts
   the job (stage-level restart only where artefacts already exist on disk).
   `cancel` exists. One trainer at a time (port guard + queue + stall killer).
4. **Frames**: ffmpeg `fps=2` (+ analysis 1 fps), native resolution (no upscale).
   A 30-min video = ~3,600 frames ≈ 700 MB+ frames, hours of SfM, untrainable
   on this Mac in one job. KIRI caps at 3 min/call anyway.
5. **Progress**: real stage transitions via shared JSON; UI polls. Types/limits
   enforced per-endpoint, no central queue depth bound (added: 3).

## Reusable as-is

Job state machine + transitions, coverage gate, COVERAGE_GAP diagnostics,
SPZ conversion, manifest/index/scene stores, query/tool loop, capture UI flow,
`cancel`, `import-asset`, `poll`.

## Decisions

- Chunked uploads alongside (not replacing) short-video direct upload.
- Segments = trimmed clips → existing `execute_job` (max reuse, incl. gates).
- Sequential reconstruction default; retries rerun jobs; `recover` marks
  interrupted non-terminal jobs failed/INTERRUPTED (no fake resume).
- Recordings + segments + scene links in JSON stores (same conventions).
- Connections modelled as data, no alignment claims, no UI promises.
