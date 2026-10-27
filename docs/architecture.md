# Architecture

```
┌──────────────┐  upload   ┌──────────────────┐  jobs   ┌─────────────────────┐
│  apps/web    │ ────────▶ │ services/        │ ──────▶ │ backends/           │
│  Next.js+TS  │  status   │ reconstruction/  │ frames  │ local | kiri |      │
│  Spark/Three │ ◀──────── │ Python worker    │  poses  │ runpod (pluggable)  │
└──────┬───────┘           └────────┬─────────┘         └─────────────────────┘
       │ query/actions              │ scene index
       ▼                            ▼
┌──────────────┐           ┌──────────────────┐
│ lib/assistant│ ────────▶ │ services/        │
│ Muse Spark   │  tools    │ scene-index/     │
│ tool loop    │ ◀──────── │ detections/      │
└──────────────┘  evidence │ registration/    │
                           │ graph/coverage   │
                           └──────────────────┘
```

## Subsystems (PRD §19)

- **A. Web client** (`apps/web`): upload, status, Spark/Three rendering, voice/text
  input, AI responses, navigation, evidence/uncertainty display.
- **B. Backend** (`apps/web/app/api`): auth, scene metadata, upload coordination,
  job records, AI orchestration, tool validation, access control, audit logs.
- **C. AI orchestration** (`apps/web/lib` + `packages/model-adapters`): Meta model
  calls, structured-output validation, evidence retrieval, tool loop, grounding rules.
- **D. Reconstruction worker** (`services/reconstruction`, Python): FFmpeg,
  frame extraction, pose estimation, 3DGS training (via pluggable backend),
  validation, compression, diagnostics. GPU work never runs in the web process.
- **E. Scene index** (`services/scene-index` + `apps/web/lib/scene-index`):
  objects, regions, relationships, viewpoints, evidence refs, coverage.
- **F. Storage**: `STORAGE_DIR` locally (./data, gitignored); S3-compatible
  object storage in production. Signed URLs for private assets.

## Key design decisions

1. **Adapters, not inline fetch.** All Meta calls go through
   `packages/model-adapters` (spark/sam/voice/image). Endpoint + model IDs from
   config/env. A provider change = adapter change, not app rewrite.
2. **Worker backends are swappable.** `services/reconstruction/backends/` exposes
   one interface (`submit/status/fetch-asset/fetch-poses/fetch-diagnostics`).
   Local (FFmpeg+COLMAP-sparse where feasible), KIRI hosted API, RunPod remote
   GPU. The web app never knows which backend ran a job — only the manifest.
3. **Detection ≠ registration.** SAM masks are image-space. 3D positions exist
   only after `registration/` establishes them with provenance; otherwise
   `position: null` + evidence thumbnails. No fabricated coordinates, ever.
4. **Tools execute server-side-validated actions.** Spark requests; the backend
   validates against the scene index; the renderer reports actual execution.
   SceneAction records store request vs. result.
5. **Persistence (dev → prod).** Dev: SQLite/JSON file store under `STORAGE_DIR`
   (zero-dependency, survives refresh). Prod: PostgreSQL + object storage.
   Schema is defined once in `packages/scene-schema` and shared.
6. **Progress is measured, never faked.** Job progress derives from backend
   job-state transitions or frame counts — no timers.

## Data flow: upload → explore

1. `POST /api/scenes` → scene record. `POST …/upload` → stored video
   (direct-to-storage signed URL for large files). `POST …/process` → job.
2. Worker: probe → extract frames (Pipeline A analysis + Pipeline B
   reconstruction, separate policies) → poses → train → validate → compress →
   manifest + diagnostics → job `ready`.
3. Scene index: SAM detections + Spark interpretation → entities (evidence-linked)
   → registration attempt → graph → viewpoints.
4. Query: `POST /api/scenes/:id/query` → retrieve entities → Spark tool loop →
   validate → execute in renderer → record SceneAction → grounded answer.
