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
      const sub = (profile as { sub?: string } | null)?.sub ?? (token.sub as string | undefined);
      if (sub) {
        token.uid = `google:${sub}`;
        token.providerSubject = sub;
      }
      return token;
    },
    async session({ session, token }) {
      (session as { uid?: string }).uid = typeof token.uid === 'string' ? token.uid : '';
      return session;
    },
  },
});
