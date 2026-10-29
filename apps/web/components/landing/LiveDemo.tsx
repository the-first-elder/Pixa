'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';

const Viewer = dynamic(() => import('@/components/SceneViewer'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[320px] items-center justify-center bg-black">
      <p className="text-sm text-neutral-500">Loading live reconstruction…</p>
    </div>
  ),
});

const DEMO_SCENE = 'scene_5abb5015';

/**
 * Live embedded reconstruction: the real Spark viewer running the real demo
 * scene. Facade pattern: a 50KB poster + play button costs nothing; the
 * ~25MB splat + viewer bundle only download when the visitor explicitly
 * presses play. (Auto-loading on scroll made the section look broken on
 * slow connections — a spinner with no progress.)
 */
export default function LiveDemo() {
  const [live, setLive] = useState(false);

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800 bg-black">
      <div className="relative h-[320px] md:h-[440px]">
        {live ? (
          <Viewer sceneId={DEMO_SCENE} drift />
        ) : (
          <button
            type="button"
            onClick={() => setLive(true)}
            className="group relative block h-full w-full"
            aria-label="Load the live 3D reconstruction"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/landing/room-3d.jpg"
              alt="Reconstructed living room — press play to explore it live"
              className="h-full w-full object-cover"
              loading="lazy"
            />
            <span className="absolute inset-0 bg-black/30 transition-colors group-hover:bg-black/20" />
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#e2a63b] text-2xl text-black transition-transform group-hover:scale-105">
                ▶
              </span>
              <span className="rounded-full border border-white/20 bg-black/60 px-3 py-1 text-xs text-neutral-200">
                Live 3D — loads ~25 MB on play
              </span>
            </span>
          </button>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-2.5">
        <p className="text-xs text-neutral-400">
          <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle" />
          Live reconstruction — drag to look around
        </p>
        <a href={`/scenes/${DEMO_SCENE}`} className="text-xs text-neutral-200 underline underline-offset-4">
          Open full scene
        </a>
      </div>
    </div>
  );
}
