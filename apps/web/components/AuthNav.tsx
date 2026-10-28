import { auth, signOut } from '@/auth';
import { authEnabled } from '@/lib/authz';
import NotificationsBell from '@/components/NotificationsBell';
import Link from 'next/link';

/**
 * Server-rendered auth area: sign-in link when out, worlds link + sign-out
 * when in. No client JS, no session flash (rendered with the page).
 */
export default async function AuthNav() {
  if (!authEnabled()) return null;
  const session = await auth();
  const user = session?.user;
  const uid = (session as { uid?: string } | null)?.uid;
  if (!user || !uid) {
    return (
      <Link
        href="/signin"
        className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-200 transition-colors hover:border-neutral-400"
      >
        Sign in
      </Link>
    );
  }
  return (
    <span className="flex items-center gap-3">
      <NotificationsBell />
      <Link href="/worlds" className="text-sm text-neutral-200 transition-colors hover:text-white">
        My Worlds
      </Link>
      <form
        action={async () => {
          'use server';
          await signOut({ redirectTo: '/' });
        }}
      >
        <button
          type="submit"
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:border-neutral-400 hover:text-white"
          title={user.email ?? user.name ?? 'Signed in'}
        >
          Sign out
        </button>
      </form>
    </span>
  );
}
