import { notFound } from 'next/navigation';
import CoverageBadge from '@/components/CoverageBadge';
import JobStatus from '@/components/JobStatus';
import SceneWorkspace from '@/components/SceneWorkspace';
import { getScene, latestJobForScene } from '@/lib/store';

/**
 * Scene workspace shell. Stage 1 mounts the real Spark viewer here driven by
 * the scene manifest; Stages 3–7 add explorer / assistant / evidence panels.
 */
export default async function ScenePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scene = getScene(id);
  if (!scene) notFound();
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
        <SceneWorkspace sceneId={id} />
      </div>
    </main>
  );
}
