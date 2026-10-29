'use client';

/**
 * Shared upload progress: determinate bar + shimmer sweep (same motion
 * language as the 3D asset loader). Always paired with a text % nearby —
 * never a bar alone.
 */
export default function UploadBar({ progress }: { progress: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div className="relative h-1.5 overflow-hidden rounded-full bg-neutral-800">
      <div className="h-full bg-white transition-all" style={{ width: `${pct}%` }} />
      <div className="load-shimmer absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-white/50 to-transparent" />
    </div>
  );
}
