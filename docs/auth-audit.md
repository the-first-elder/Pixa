# Stage 1 audit: onboarding + auth readiness (verified 2026-10-28)

## Stack
- Next.js 16 App Router (`apps/web/app`): `/` (landing), `/capture`,
  `/scenes/:id`, `/recordings/:id`, `/api/*`. No middleware, no auth module,
  no auth dependency anywhere. Entry: `app/layout.tsx` + `page.tsx`.
- Python worker (`services/reconstruction/worker`, stdlib only): probe,
  extract, analyze, process/run-job/process-segment, poll, cancel, recover,
  import-asset, split/merge, sweep. SfM+train via Spirula binary; KIRI/RunPod
  backends exist (KIRI key configured, unspent; no RunPod account).

## Persistence: JSON files in STORAGE_DIR (zero-DB convention)
`scenes.json` (visibility public/private), `jobs.json` (state machine +
transitions + trainPid for cancel), `uploads.json` (chunk bitmap sessions),
`recordings.json` (segment manifests + connections: []), `sessions.json`
(chat sessions!), `actions.json`, `scales.json`, `index/` (scene indexes),
`assets/` + `uploads/` + `work/`. All writes atomic tmp+rename. Survives
restarts; no auth, no ownership anywhere.

## Upload → queue → scene flow (verified in code + tests)
1. Direct (<50 MB, buffered) or chunked resumable upload (bitmap, offsets,
   sha256 + probe on finalize). 12/12 integration tests green.
2. Recording registered → detached `analyze` → segment manifest.
3. Per-segment `process-segment` → trimmed clip → `execute_job` (all gates).
4. Single trainer slot: port guard + visible queue + cancel + 20-min stall
   killer + 3-deep submission cap. `recover` marks interrupted, kills orphans.
5. Ready job → asset record → manifest → viewer. Scene rows carry
   `parentRecordingId`/`segmentId`; `connections: []` reserved, no alignment.
6. Progress = real stage transitions polled every 2–5 s; no fabricated pct.

## Demo + notifications today
- Demo scene: `scene_5abb5015` (user's living room), visibility public,
  linked from landing CTAs. Loads with zero auth (nothing to bypass).
- Notifications: NONE exist (no model, no UI, no push). Greenfield.
- Name collision risk: chat `sessions.json` vs future auth sessions — rename
  auth sessions distinctly (`/withAuth` cookie name + `userSessions` concept
  kept server-side only).

## Decision (fits constraints: no paid services, no new DB)
- **Auth.js v5 (Auth.js) + Google provider + JWT strategy** (no adapter/DB
  needed): encrypted HTTP-only session cookie, `sub` as stable user key,
  minimal `users.json` (id, provider, providerAccountId, email, name, image?,
  createdAt). Free, self-hosted, no subscription.
- Ownership: `ownerId` on scenes/jobs/uploads/recordings (+ backfill existing
  as a demo/system owner); server-side checks on every private read/write.
- Notifications: `notifications.json` (dedupe keys on job transitions),
  bell UI in nav; push deferred (needs VAPID + SW + deployment — documented).
- Manual setup required (developer, one time): Google Cloud OAuth client
  (ID + secret), `AUTH_SECRET`, authorized redirect URI. Documented in
  `docs/auth-setup.md` (to be written at implementation).
