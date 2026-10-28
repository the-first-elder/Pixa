import Link from 'next/link';
import { sessionUser } from '@/lib/authz';
import { unreadCount } from '@/lib/notifications';

/** Server-rendered bell with unread count. Renders nothing when signed out. */
export default async function NotificationsBell() {
  const user = await sessionUser();
  if (!user) return null;
  const count = unreadCount(user.uid);
  return (
    <Link
      href="/worlds#notifications"
      className="relative rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-400 hover:text-white"
      title={count > 0 ? `${count} unread notification(s)` : 'No new notifications'}
    >
      <span aria-hidden>🔔</span>
      {count > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#e2a63b] px-1 text-[10px] font-medium text-black">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  );
}
