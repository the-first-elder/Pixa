'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

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
 * scene. Lazy-loads only when scrolled into view; never renders offscreen.
 */
export default function LiveDemo() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setLive(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className="overflow-hidden rounded-xl border border-neutral-800 bg-black">
      <div className="h-[320px] md:h-[440px]">
        {live ? (
          <Viewer sceneId={DEMO_SCENE} drift />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src="/landing/room-3d.jpg"
            alt="Reconstructed living room loaded in the Pixa viewer"
            className="h-full w-full object-cover"
            loading="lazy"
          />
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
