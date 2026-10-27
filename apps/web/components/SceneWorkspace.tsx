'use client';

import { useRef } from 'react';
import SceneViewer, { type CameraCommand, type ViewerHandle } from './SceneViewer';
import AssistantPanel from './AssistantPanel';

/** Client workspace: viewer + assistant share the camera-command path. */
export default function SceneWorkspace({ sceneId }: { sceneId: string }) {
  const viewerRef = useRef<ViewerHandle>(null);

  function handleCamera(cmd: CameraCommand) {
    viewerRef.current?.flyTo(cmd);
  }

  function handleHighlight(positions: [number, number, number][]) {
    return viewerRef.current?.highlight(positions) ?? 0;
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-auto p-6 lg:flex-row">
      <div className="min-h-96 flex-1 rounded-md border border-neutral-800">
        <SceneViewer ref={viewerRef} sceneId={sceneId} />
      </div>
      <aside className="flex w-full max-w-sm flex-col gap-4">
        <AssistantPanel sceneId={sceneId} onCamera={handleCamera} onHighlight={handleHighlight} />
      </aside>
    </div>
  );
}
