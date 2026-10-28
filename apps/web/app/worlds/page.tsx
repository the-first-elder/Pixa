import Link from 'next/link';
import { redirect } from 'next/navigation';
import AuthNav from '@/components/AuthNav';
import NotificationsPanel from '@/components/NotificationsPanel';
import { authEnabled, sessionUser } from '@/lib/authz';
import { ensureNotifications } from '@/lib/notifications';
import { listMyWorlds } from '@/lib/worlds';
import { STATUS_LABELS, jobToStatus, segmentsToStatus, type ProjectStatus } from '@/lib/project-status';

function StatusPill({ status }: { status: ProjectStatus }) {
  const color =
    status === 'ready'
      ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
      : status === 'failed' || status === 'needs-attention'
        ? 'border-amber-800 bg-amber-950/40 text-amber-300'
        : status === 'cancelled'
          ? 'border-neutral-700 text-neutral-400'
          : 'border-neutral-700 bg-neutral-900 text-neutral-300';
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs ${color}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function CardThumb({ src, alt }: { src: string | null; alt: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} className="aspect-[16/10] w-full object-cover" loading="lazy" />;
  }
  return (
    <div className="flex aspect-[16/10] w-full items-center justify-center bg-gradient-to-br from-neutral-800 via-[#1a1611] to-black">
      <span className="font-display text-2xl text-neutral-700">Pixa</span>
    </div>
  );
}

/**
 * My Worlds: the caller's projects (scenes + recordings) as visual cards
 * with thumbnails, honest status, and job progress. Requires sign-in when
 * auth is enabled; single-user mode shows everything local.
 */
export default async function WorldsPage() {
  const user = await sessionUser();
  if (authEnabled() && !user) {
    redirect('/signin?callbackUrl=/worlds');
  }
  if (user) ensureNotifications(user.uid);
  const { scenes, recordings } = listMyWorlds(user?.uid ?? null);
  const empty = scenes.length === 0 && recordings.length === 0;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs text-neutral-500">
            <Link href="/" className="hover:text-white">Pixa</Link>
          </p>
          <h1 className="font-display mt-1 text-3xl tracking-tight">My Worlds</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {scenes.length + recordings.length === 0
              ? 'Your captures and reconstructions will live here.'
              : `${scenes.length} scene${scenes.length === 1 ? '' : 's'} · ${recordings.length} recording${recordings.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <span className="flex items-center gap-3">
          <Link
            href="/capture"
            className="rounded-md bg-[#e2a63b] px-4 py-2 text-sm font-medium text-black transition-transform hover:scale-[1.03]"
          >
            + New world
          </Link>
          <AuthNav />
        </span>
      </header>

      {empty && (
        <div className="mt-12 rounded-xl border border-white/10 bg-[#111113] p-10 text-center">
          <p className="font-display text-xl">No worlds yet.</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-neutral-400">
            Record a walkthrough of any room and Pixa will reconstruct it into
            an explorable 3D scene.
          </p>
          <Link
            href="/capture"
            className="mt-6 inline-block rounded-md bg-[#e2a63b] px-6 py-3 text-sm font-medium text-black"
          >
            Create your world
          </Link>
        </div>
      )}

      <NotificationsPanel />

      {scenes.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">
            Scenes
          </h2>
          <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {scenes.map((s) => {
              const status = jobToStatus(s.job);
              const failed = s.job?.status === 'failed';
              const progress = typeof s.job?.progress === 'number' ? s.job.progress : null;
              const working = progress !== null && status !== 'ready' && status !== 'failed' && status !== 'cancelled';
              return (
                <article key={s.id} className="group overflow-hidden rounded-xl border border-white/10 bg-[#111113] transition-colors hover:border-white/25">
                  <Link href={`/scenes/${s.id}`} className="block">
                    <div className="relative">
                      <CardThumb src={s.thumb} alt={`Capture frame from ${s.name}`} />
                      <span className="absolute left-3 top-3">
                        <StatusPill status={status} />
                      </span>
                      {s.visibility === 'public' && (
                        <span className="absolute right-3 top-3 rounded-full border border-white/20 bg-black/60 px-2.5 py-0.5 text-xs text-neutral-200">
                          Public
                        </span>
                      )}
                    </div>
                  </Link>
                  <div className="px-4 pb-4 pt-3">
                    <Link href={`/scenes/${s.id}`} className="block truncate text-sm font-medium group-hover:text-white">
                      {s.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {fmtDate(s.createdAt)}
                      {s.job ? ` · job ${s.job.status}` : ' · no job yet'}
                      {failed && s.job?.errorCode ? ` · ${s.job.errorCode.slice(0, 32)}` : ''}
                    </p>
                    {working && (
                      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-neutral-800" title={`Reconstruction ${progress}%`}>
                        <div className="h-full rounded-full bg-[#e2a63b] transition-all" style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
                      </div>
                    )}
                    <div className="mt-3">
                      {status === 'ready' && s.job ? (
                        <Link href={`/scenes/${s.id}`} className="inline-block rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black">
                          Explore world
                        </Link>
                      ) : (
                        <Link href={`/scenes/${s.id}`} className="inline-block rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-400">
                          {failed ? 'View details' : 'View progress'}
                        </Link>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {recordings.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">
            Recordings
          </h2>
          <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {recordings.map((r) => {
              const states = r.recording.manifest?.segments.map((s) => s.status) ?? [];
              const status = segmentsToStatus(states);
              const done = states.filter((s) => s === 'ready').length;
              return (
                <article key={r.id} className="group overflow-hidden rounded-xl border border-white/10 bg-[#111113] transition-colors hover:border-white/25">
                  <Link href={`/recordings/${r.id}`} className="block">
                    <div className="relative">
                      <CardThumb src={r.thumb} alt={`Thumbnail from ${r.name}`} />
                      <span className="absolute left-3 top-3">
                        <StatusPill status={status} />
                      </span>
                    </div>
                  </Link>
                  <div className="px-4 pb-4 pt-3">
                    <Link href={`/recordings/${r.id}`} className="block truncate text-sm font-medium group-hover:text-white">
                      {r.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {fmtDate(r.createdAt)} · {states.length} segment(s)
                      {states.length > 0 && ` · ${done}/${states.length} ready`}
                    </p>
                    {states.length > 0 && done < states.length && (
                      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-neutral-800" title={`${done}/${states.length} segments ready`}>
                        <div className="h-full rounded-full bg-[#e2a63b] transition-all" style={{ width: `${Math.max(2, (done / states.length) * 100)}%` }} />
                      </div>
                    )}
                    <div className="mt-3">
                      <Link href={`/recordings/${r.id}`} className="inline-block rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-400">
                        {status === 'ready' ? 'View' : 'View progress'}
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
