import { notFound } from 'next/navigation';
import CoverageBadge from '@/components/CoverageBadge';
import JobStatus from '@/components/JobStatus';
import SceneWorkspace from '@/components/SceneWorkspace';
import SharePanel from '@/components/SharePanel';
import { canRead, sessionUser } from '@/lib/authz';
import { getScene, latestJobForScene } from '@/lib/store';

/**
 * Scene workspace shell. Stage 1 mounts the real Spark viewer here driven by
 * the scene manifest; Stages 3–7 add explorer / assistant / evidence panels.
 */
export default async function ScenePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}) {
  const { id } = await params;
  const { v } = await searchParams;
  const scene = getScene(id);
  const user = await sessionUser();
  // Server-side check: no flash of protected content before authorization.
  if (!scene || !canRead(scene, user?.uid ?? null)) notFound();
  const job = latestJobForScene(id);
  const ownerMismatch = Boolean(scene.ownerId && user && scene.ownerId !== user.uid);

  return (
    <main className="flex h-screen flex-col">
      <header className="border-b border-neutral-800 px-6 py-3">
        <h1 className="text-sm font-medium">{scene.name}</h1>
        <p className="text-xs text-neutral-500">
          {scene.sourceVideo ? 'Source video attached' : 'No video yet'} ·{' '}
          {job ? `job ${job.status}` : 'no processing job'}{' '}
          <CoverageBadge sceneId={id} />
          {user ? ` · signed in as ${user.email ?? user.name ?? 'you'}` : ''}
        </p>
        {ownerMismatch && (
          <p className="mt-1 rounded-md border border-amber-800 bg-amber-950/40 px-2 py-1 text-xs text-amber-300">
            This world was saved to a different account — you&rsquo;re signed in as {user!.email ?? user!.name ?? 'another account'},
            so progress and notifications go there, not here.
          </p>
        )}
      </header>
      <div className="flex flex-1 flex-col overflow-auto">
        {job && job.status !== 'ready' && (
          <div className="px-6 pt-4">
            <JobStatus jobId={job.id} notifyEmail={user?.email ?? null} />
          </div>
        )}
        {(!job || job.status === 'ready') && (
          <div className="px-6 pt-4">
            <SharePanel sceneId={id} />
          </div>
        )}
        <SceneWorkspace sceneId={id} initialViewpointId={typeof v === 'string' ? v : undefined} />
      </div>
    </main>
  );
}
