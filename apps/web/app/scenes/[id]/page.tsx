import SceneViewer from '@/components/SceneViewer';

/**
 * Stage 1 mounts the real Spark/Three.js viewer here, driven by the scene
 * manifest. Placeholder shell so the route exists from Stage 0.
 */
export default async function ScenePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="flex h-screen flex-col">
      <header className="border-b border-neutral-800 px-6 py-3">
        <h1 className="text-sm text-neutral-400">Scene {id}</h1>
      </header>
      <SceneViewer sceneId={id} />
    </main>
  );
}
