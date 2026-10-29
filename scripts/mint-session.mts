/**
 * Test helper: mint an Auth.js session cookie for a given uid, printed as a
 * ready-to-use `Cookie:` header value. Tests run against throwaway servers
 * with dummy AUTH_SECRET, so mint with the SAME secret (env AUTH_SECRET).
 * The cookie name/salt MUST match what the server expects: pass --secure
 * iff the server env resolves AUTH_URL to https (a plain-named cookie is
 * silently ignored by design — no error, just no session).
 * Usage: HDR=$(AUTH_SECRET=dummy npx tsx scripts/mint-session.mts --uid google:42424242424242424242 [--secure])
 *   curl -H "Cookie: $HDR" $BASE/api/me
 * Never use with production secrets; test-only.
 */
import { encode } from 'next-auth/jwt';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
// Numeric default: the app only accepts google:<digits> (real Google subs).
// Non-numeric uids simulate poisoned pre-fix sessions and must be rejected.
const uid = arg('uid', 'google:42424242424242424242')!;
const secure = process.argv.includes('--secure');
const secret = process.env.AUTH_SECRET;
if (!secret) {
  console.error('AUTH_SECRET missing');
  process.exit(2);
}
const sub = uid.includes(':') ? uid.split(':').slice(1).join(':') : uid;
const salt = secure ? '__Secure-authjs.session-token' : 'authjs.session-token';
const token = await encode({ token: { sub, uid }, secret, salt });
const name = secure ? '__Secure-authjs.session-token' : 'authjs.session-token';
console.log(`${name}=${token}`);
