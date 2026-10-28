'use client';

import type { CaptureAdvice } from '@/lib/capture-analysis';
import { CompassDial } from './CoverageCompass';

function fmt(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * On-video director overlay: glanceable guidance while walking, so the user
 * never looks away from the viewfinder. Shows the single worst live issue,
 * pace, timer, resolution honesty, tilt bubble, and coverage compass.
 * Purely presentational — all signals computed by the parent.
 */
export default function DirectorOverlay({
  advice,
  meters,
  elapsed,
  paused,
  resolution,
  tilt,
  covered,
}: {
  advice: CaptureAdvice[];
  meters: { speed: number; blur: number; light: number };
  elapsed: number;
  paused: boolean;
  resolution: { w: number; h: number } | null;
  tilt: { supported: boolean; gamma: number | null; beta: number | null };
  covered: boolean[] | null;
}) {
  const worst =
    advice.find((a) => a.level === 'bad') ?? advice.find((a) => a.level === 'warn') ?? null;
  const pace = Math.min(1, meters.speed / 21);
  const paceColor = meters.speed >= 14 ? 'bg-red-500' : meters.speed >= 10 ? 'bg-amber-400' : 'bg-emerald-400';
  const resMax = resolution ? Math.max(resolution.w, resolution.h) : null;
  const resTone =
    resMax == null ? 'text-neutral-300' : resMax < 720 ? 'text-red-300' : resMax < 1280 ? 'text-amber-300' : 'text-neutral-300';
  const gamma = tilt.supported ? tilt.gamma : null;
  const offLevel = gamma != null && Math.abs(gamma) > 12;
  // Bubble position: clamped mapping; off-center always means "not level"
  // regardless of device sign conventions (no directional claims).
  const bubbleX = gamma == null ? 0 : Math.max(-1, Math.min(1, gamma / 45)) * 26;
  const beta = tilt.supported ? tilt.beta : null;
  const pitchHint = beta == null ? null : beta < 45 ? 'looking steeply up' : beta > 135 ? 'looking steeply down' : null;

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between rounded-md p-2.5" aria-hidden={worst == null}>
      {/* Top row: REC + timer + resolution */}
      <div className="flex items-start justify-between gap-2">
        <span className="rounded bg-black/60 px-2 py-1 text-xs font-medium text-red-400 tabular-nums">
          ● {fmt(elapsed)}{paused ? ' (paused)' : ''}
        </span>
        {resolution && (
          <span className={`rounded bg-black/60 px-2 py-1 text-xs tabular-nums ${resTone}`} title="Capture resolution — detail ceiling for the reconstruction">
            {resolution.w}×{resolution.h}
          </span>
        )}
      </div>

      {/* Priority instruction banner (only when something needs fixing) */}
      <div className="flex flex-1 items-start justify-center pt-2">
        {worst && (
          <p
            className={`max-w-[90%] rounded-md px-3 py-1.5 text-center text-sm font-medium ${
              worst.level === 'bad' ? 'bg-red-600/85 text-white' : 'bg-amber-500/85 text-black'
            }`}
          >
            {worst.message}
          </p>
        )}
      </div>

      {/* Bottom row: pace + tilt + compass */}
      <div className="flex items-end justify-between gap-2">
        <div className="w-28 rounded bg-black/60 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wider text-neutral-400">pace</p>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-700">
            <div className={`h-full rounded-full ${paceColor}`} style={{ width: `${Math.round(pace * 100)}%` }} />
          </div>
          <p className="mt-0.5 text-[10px] tabular-nums text-neutral-400">
            {meters.speed >= 14 ? 'too fast' : 'good'}
          </p>
        </div>
        {gamma != null && (
          <div className="rounded bg-black/60 px-2.5 py-1.5 text-center" title="Bubble level — center the dot">
            <div className="relative mx-auto h-1.5 w-16 overflow-hidden rounded-full bg-neutral-700">
              <div
                className={`absolute top-0 h-1.5 w-1.5 rounded-full ${offLevel ? 'bg-amber-400' : 'bg-emerald-400'}`}
                style={{ left: `calc(50% - 3px + ${bubbleX}px)` }}
              />
            </div>
            <p className="mt-0.5 text-[10px] text-neutral-400">{offLevel ? 'hold level' : 'level'}{pitchHint ? ` · ${pitchHint}` : ''}</p>
          </div>
        )}
        {covered && (
          <div className="origin-bottom-right scale-[0.62] rounded bg-black/60 p-1" title="Filmed directions">
            <CompassDial covered={covered} />
          </div>
        )}
      </div>
    </div>
  );
}
