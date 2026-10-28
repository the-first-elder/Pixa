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

  return (
    <main className="flex h-screen flex-col">
      <header className="border-b border-neutral-800 px-6 py-3">
        <h1 className="text-sm font-medium">{scene.name}</h1>
        <p className="text-xs text-neutral-500">
          {scene.sourceVideo ? 'Source video attached' : 'No video yet'} ·{' '}
          {job ? `job ${job.status}` : 'no processing job'}{' '}
          <CoverageBadge sceneId={id} />
        </p>
      </header>
      <div className="flex flex-1 flex-col overflow-auto">
        {job && job.status !== 'ready' && (
          <div className="px-6 pt-4">
            <JobStatus jobId={job.id} />
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
