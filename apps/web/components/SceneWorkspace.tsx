'use client';

import { useRef, useState } from 'react';
import SceneViewer, { type CameraCommand, type ViewerHandle } from './SceneViewer';
import AssistantPanel from './AssistantPanel';

interface Viewpoint {
  id: string;
  label: string;
  position: [number, number, number] | null;
  target: [number, number, number] | null;
}

/** Client workspace: viewer + assistant share the camera-command path. */
export default function SceneWorkspace({ sceneId, initialViewpointId }: { sceneId: string; initialViewpointId?: string }) {
  const viewerRef = useRef<ViewerHandle>(null);
  const [touring, setTouring] = useState(false);

  function handleCamera(cmd: CameraCommand) {
    viewerRef.current?.flyTo(cmd);
  }

  function handleHighlight(positions: [number, number, number][]) {
    return viewerRef.current?.highlight(positions) ?? 0;
  }

  /** Guided tour: fly through every camera-framed viewpoint in order. */
  async function tour() {
    if (touring) return;
    setTouring(true);
    try {
      const res = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}`);
      const data = (await res.json()) as { manifest?: { viewpoints?: Viewpoint[] } | null };
      const stops = (data.manifest?.viewpoints ?? []).filter(
        (v): v is Viewpoint & { position: [number, number, number]; target: [number, number, number] } =>
          !!v.position && !!v.target,
      );
      for (const stop of stops) {
        viewerRef.current?.flyTo({
          type: 'tween',
          position: stop.position,
          target: stop.target,
          durationMs: 2200,
        });
        await new Promise((r) => setTimeout(r, 2600));
      }
    } finally {
      setTouring(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-auto p-6 lg:flex-row">
      <div className="min-h-96 flex-1 rounded-md border border-neutral-800">
        <SceneViewer ref={viewerRef} sceneId={sceneId} initialViewpointId={initialViewpointId} />
      </div>
      <aside className="flex w-full max-w-sm flex-col gap-4">
        <button
          type="button"
          onClick={tour}
          disabled={touring}
          className="rounded-md border border-neutral-700 px-3 py-2 text-sm disabled:opacity-50"
          title="Fly through every viewpoint in order"
        >
          {touring ? 'Touring…' : '▶ Take the tour'}
        </button>
        <div className="min-h-0 flex-1">
          <AssistantPanel sceneId={sceneId} onCamera={handleCamera} onHighlight={handleHighlight} />
        </div>
      </aside>
    </div>
  );
}
