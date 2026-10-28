# Production notes: worker, queue, push (no-cost constraints)

## Local worker operation (current reality)

- The worker runs on the developer's Mac, spawned detached by the API
  (`spawnWorker`) — localhost only, no public endpoint, no remote claims.
- One trainer at a time (fixed Spirula viewer port): port guard + visible
  queue + per-job cancel + 20-min stall killer + 3-deep submission cap.
- While the Mac sleeps / the worker stops / disk is full, jobs stay queued
  with honest `waiting` status — never shown as reconstructing.
- Rerunning `recover` after a crash marks interrupted jobs (kills orphan
  trainers); retries are explicit, never fake-resumed.

## What a deployed version still needs

- Object storage + Postgres instead of JSON files; Redis/BullMQ queue;
  GPU fleet or hosted reconstruction for throughput. API shapes stay the same.
- `trustHost: true` requires a trusted reverse proxy in production.

## Browser push: deferred (documented, not built)

Feasible without paid services (VAPID + web-push + service worker), but needs
deployment decisions first: public HTTPS origin, SW registration, VAPID key
management, subscription storage + cleanup, and per-browser testing. In-app
notifications (shipped) are the prerequisite and work regardless. Do not
claim push works until all of the above is configured and tested.

## Rate limits (in-memory, single-instance)

- POST /api/scenes: 20/min, POST /api/uploads + /api/recordings: 10/min
  (per user, else per IP). Move to Redis with multi-instance deploys.
