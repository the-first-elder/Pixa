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

## Go-live wiring (verified 2026-10-29)

- Public URL: `https://pixa.autumn-test.workers.dev` (edge proxy → quick tunnel → `next start` on Mac).
- Google OAuth client `20964591116-…`: redirect URIs registered for localhost (`http://localhost:3000/api/auth/callback/google`) and public (`https://pixa.autumn-test.workers.dev/api/auth/callback/google`). Login leg verified to Google's account chooser (no `redirect_uri_mismatch`).
- `AUTH_URL=https://pixa.autumn-test.workers.dev` in server `.env`: the tunnel chain rewrites forwarding headers to the origin, so Auth.js cannot infer the public host — the pinned URL makes every flow complete on the public callback.
- CI deploy: repo secrets `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` set; `deploy-edge` job redeploys the worker on push to `main`/`dev`.
- Completion mail: Brevo SMTP, sender verified, `EMAIL_FROM` + `APP_URL` in server `.env`; live-tested end to end.
- Still manual: quick-tunnel URL rotates on restart → run `scripts/sync-tunnel.sh` (or promote to a named tunnel once the token gains Tunnels:Edit).
