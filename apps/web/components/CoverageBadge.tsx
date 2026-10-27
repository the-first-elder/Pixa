'use client';

import { useEffect, useState } from 'react';

interface Coverage {
  registeredFrames: number;
  totalFrames: number;
  percent: number;
  gapRanges: [number, number][];
}

/** Honest reconstruction-quality indicator from real registration diagnostics. */
export default function CoverageBadge({ sceneId }: { sceneId: string }) {
  const [coverage, setCoverage] = useState<Coverage | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scenes/${encodeURIComponent(sceneId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.coverage) setCoverage(d.coverage as Coverage);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sceneId]);

  if (!coverage) return null;
  const gaps = coverage.gapRanges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
  return (
    <span
      className="rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-400"
      title={
        gaps
          ? `Unreconstructed frames: ${gaps}. Treat views there as damaged/unknown.`
          : 'All extracted frames registered.'
      }
    >
      coverage {coverage.percent}%{gaps ? ` · gaps ${gaps}` : ''}
    </span>
  );
}
