import { notFound } from 'next/navigation';
import JobStatus from '@/components/JobStatus';
import SceneViewer from '@/components/SceneViewer';
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
          {job ? `job ${job.status}` : 'no processing job'}
        </p>
      </header>
      <div className="flex flex-1 flex-col gap-4 overflow-auto p-6 lg:flex-row">
        <div className="min-h-96 flex-1 rounded-md border border-neutral-800">
          <SceneViewer sceneId={id} />
        </div>
        <aside className="w-full max-w-sm space-y-4">
          {job && <JobStatus jobId={job.id} />}
        </aside>
      </div>
    </main>
  );
}
