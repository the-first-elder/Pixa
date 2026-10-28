# Auth setup (Google OAuth, one-time manual steps)

Pixa uses Auth.js v5 + Google + encrypted JWT session cookies. No database
adapter, no paid services. Without the three variables below, the app runs in
single-user local mode (all routes open, as before) — auth enforcement only
activates when all three are set.

## 1. Google Cloud Console (free)

1. Create/select a project at console.cloud.google.com.
2. APIs & Services → OAuth consent screen → External, fill app name + support
   email, add your email as a test user (no verification needed for testing).
3. Credentials → Create Credentials → OAuth client ID → Web application.
4. Authorized redirect URIs, add exactly:
   - `http://localhost:3000/api/auth/callback/google` (dev)
   - `https://YOUR-DOMAIN/api/auth/callback/google` (prod, when deployed)
5. Copy the Client ID and Client secret.

## 2. Environment

```bash
openssl rand -base64 32   # → AUTH_SECRET
```

`.env`:
```
AUTH_SECRET=<output above>
GOOGLE_CLIENT_ID=<from step 1>
GOOGLE_CLIENT_SECRET=<from step 1>
```

Restart the dev server. Sign-in is available at `/signin` and from the
Create flow; sessions last 30 days and survive refresh via HTTP-only cookie.

## 3. Verify

- Signed out: landing + public demo scene load; creating/uploading prompts sign-in.
- Signed in: `/worlds` lists your projects; another account cannot open them
  (private scenes return 404, writes return 403).
- Real Google login has NOT been tested in this environment (no OAuth client
  exists yet) — run through it once after setup and confirm `/api/me` shows
  your `google:<sub>` uid.

## Security notes

- `AUTH_SECRET` must stay server-side; never commit `.env`.
- CSRF: SameSite=Lax session cookies (Auth.js default) — cross-site POSTs
  cannot carry them. No custom token flow.
- `trustHost: true` trusts `X-Forwarded-*` from the deployment proxy; keep
  the app behind a trusted reverse proxy in production.
