'use client';

/**
 * 3D viewport. Stage 1 implements the real SparkRenderer + SplatMesh mount,
 * camera transitions, and highlight hooks here. Client component: WebGL only.
 */
export default function SceneViewer({ sceneId }: { sceneId: string }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-black">
      <p className="text-sm text-neutral-500">
        3D viewer mounts here (Stage 1) — scene {sceneId}
      </p>
    </div>
  );
}
