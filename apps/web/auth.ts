import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { upsertUser } from '@/lib/users';

/**
 * Auth.js v5 + Google + JWT sessions (no adapter/DB needed).
 * - Encrypted HTTP-only session cookie (AUTH_SECRET).
 * - Stable identity = provider Google `sub`, stored as users.json id key.
 * - Minimal profile only (sub, email, name, image?). No phone, no extras.
 * - Demo/public scenes never require a session (checked per-route).
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  pages: { signIn: '/signin' },
  session: { strategy: 'jwt', maxAge: 30 * 24 * 3600 },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: { params: { prompt: 'select_account' } },
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      // Persist/refresh the minimal user record on every login.
      const sub = (profile as { sub?: string } | null)?.sub;
      if (!sub) return false;
      upsertUser({
        provider: 'google',
        providerAccountId: sub,
        email: (profile as { email?: string } | null)?.email ?? null,
        name: (profile as { name?: string } | null)?.name ?? null,
        image: (profile as { picture?: string } | null)?.picture ?? null,
      });
      return true;
    },
    async jwt({ token, profile }) {
      // profile is present ONLY on the sign-in call. Derive the stable
      // identity here and never touch it again: on later calls profile is
      // absent and token.sub is Auth.js's INTERNAL random user id
      // (crypto.randomUUID by design) — falling back to it silently
      // re-identifies the user as a random stranger on every session
      // (measured: a new phantom google:<uuid> owner per login).
      const sub = (profile as { sub?: string } | null)?.sub;
      if (sub) {
        token.sub = sub;
        token.uid = `google:${sub}`;
        token.providerSubject = sub;
      }
      return token;
    },
    async session({ session, token }) {
      const uid = typeof token.uid === 'string' ? token.uid : '';
      // Migration: pre-fix sessions stored Auth.js's random internal id as
      // the Google subject (google:<uuid>). Google subs are always numeric,
      // so anything else is a poisoned identity — treat as signed out so
      // the holder re-authenticates to their stable id (one re-login).
      (session as { uid?: string }).uid = /^google:\d+$/.test(uid) ? uid : '';
      return session;
    },
  },
});
