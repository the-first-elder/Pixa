'use client';

function fmtMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Asset loading screen: real download progress with a shimmer sweep,
 * not a dead spinner. Two phases — downloading (measured bytes) then
 * parsing (indeterminate: geometry build has no byte signal).
 */
export default function AssetLoader({
  loaded,
  total,
  parsing,
}: {
  loaded: number;
  total: number;
  parsing: boolean;
}) {
  const pct = total > 0 ? Math.min(100, (loaded / total) * 100) : null;
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center bg-black px-6 text-center">
      <div className="font-display text-5xl text-[#e2a63b]">P</div>
      <p className="mt-4 font-display text-6xl tabular-nums tracking-tight text-white">
        {parsing ? '✦' : pct === null ? '…' : `${Math.floor(pct)}%`}
      </p>
      <div className="relative mt-5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-neutral-800">
        <div
          className="h-full rounded-full bg-[#e2a63b] transition-[width]"
          style={{ width: parsing ? '100%' : `${pct ?? 8}%`, transitionDuration: parsing ? '600ms' : '150ms' }}
        />
        <div className="load-shimmer absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      </div>
      <p className="mt-3 text-xs tabular-nums text-neutral-400">
        {parsing ? (
          <>Parsing geometry — almost there…</>
        ) : total > 0 ? (
          <>Downloading splats… {fmtMB(loaded)} / {fmtMB(total)}</>
        ) : (
          <>Downloading splats… {fmtMB(loaded)}</>
        )}
      </p>
      <p className="mt-1 text-[11px] text-neutral-600">
        Big scenes take a moment on first load, then stream from cache.
      </p>
    </div>
  );
}
