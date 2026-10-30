'use client';

import { useEffect, useRef, useState } from 'react';
import {
  SECTORS,
  accumulateDwell,
  coveredFromDwell,
  largestGapHint,
  sectorFor,
  tiltFlags,
} from '@/lib/coverage-logic';

export { SECTORS };

export interface CompassState {
  supported: boolean;
  permission: 'unknown' | 'granted' | 'denied' | 'needed';
  covered: boolean[];
  lookedUp: boolean;
  lookedDown: boolean;
  uncoveredHint: string | null;
}

/**
 * Coverage compass from device orientation (gyro/compass).
 * Sectors are relative to the heading where filming started and require
 * ~1.2s of dwell at acceptable quality — sweeps don't count, which is
 * what keeps the UI honest about reconstruction gaps. Gracefully absent
 * where the API doesn't exist (desktop).
 */
export function useCoverageCompass(active: boolean, qualityOk: boolean) {
  const [state, setState] = useState<CompassState>({
    supported: false,
    permission: 'unknown',
    covered: Array(SECTORS).fill(false),
    lookedUp: false,
    lookedDown: false,
    uncoveredHint: null,
  });
  const dwellRef = useRef<number[]>(Array(SECTORS).fill(0));
  const flagsRef = useRef({ up: false, down: false });
  const startYawRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const qualityRef = useRef(qualityOk);
  qualityRef.current = qualityOk;
  const markRef = useRef<((a: number | null, b: number | null) => void) | null>(null);

  useEffect(() => {
    if (!active) return;
    const DOE = window.DeviceOrientationEvent as unknown as
      | { requestPermission?: () => Promise<string> }
      | undefined;
    if (!window.DeviceOrientationEvent) return;
    setState((s) => ({ ...s, supported: true }));
    let mounted = true;

    const mark = (alpha: number | null, beta: number | null) => {
      if (alpha === null) return;
      if (startYawRef.current === null) startYawRef.current = alpha;
      const now = performance.now();
      const delta = lastTimeRef.current ? now - lastTimeRef.current : 0;
      lastTimeRef.current = now;
      const sector = sectorFor(alpha, startYawRef.current);
      const changed = accumulateDwell(dwellRef.current, sector, delta, qualityRef.current);
      const flags = tiltFlags(beta);
      if (flags.up) flagsRef.current.up = true;
      if (flags.down) flagsRef.current.down = true;
      if (!mounted || (!changed && !flags.up && !flags.down)) return;
      const covered = coveredFromDwell(dwellRef.current);
      setState({
        supported: true,
        permission: 'granted',
        covered,
        lookedUp: flagsRef.current.up,
        lookedDown: flagsRef.current.down,
        uncoveredHint: largestGapHint(covered),
      });
    };

    const handler = (e: DeviceOrientationEvent) => mark(e.alpha, e.beta);
    markRef.current = mark;
    if (DOE && typeof DOE.requestPermission === 'function') {
      setState((s) => ({ ...s, permission: 'needed' }));
      return () => {
        mounted = false;
      };
    }
    window.addEventListener('deviceorientation', handler);
    setState((s) => ({ ...s, permission: 'granted' }));
    return () => {
      mounted = false;
      window.removeEventListener('deviceorientation', handler);
    };
  }, [active]);

  async function requestPermission() {
    const DOE = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    try {
      const res = await DOE.requestPermission?.();
      if (res === 'granted') {
        // Same mark() as the direct path (relative sectors + dwell + hint);
        // the old iOS handler marked absolute sectors and never refreshed
        // state, so granted iPhones showed a permanently empty compass.
        const mark = markRef.current;
        if (mark) {
          window.addEventListener('deviceorientation', (e) => mark(e.alpha, e.beta));
        }
        setState((s) => ({ ...s, permission: 'granted' }));
      } else {
        setState((s) => ({ ...s, permission: 'denied' }));
      }
    } catch {
      setState((s) => ({ ...s, permission: 'denied' }));
    }
  }

  function reset() {
    dwellRef.current = Array(SECTORS).fill(0);
    flagsRef.current = { up: false, down: false };
    startYawRef.current = null;
    lastTimeRef.current = 0;
    setState((s) => ({ ...s, covered: [...dwellRef.current.map(() => false)], lookedUp: false, lookedDown: false, uncoveredHint: null }));
  }

  return { state, requestPermission, reset };
}

/** Circular coverage display: lit sectors filmed, dim sectors missing. */
export function CompassDial({ covered }: { covered: boolean[] }) {
  const r = 26;
  const cx = 32;
  const cy = 32;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-label="Filmed direction coverage">
      {covered.map((c, i) => {
        const a0 = (i / covered.length) * Math.PI * 2 - Math.PI / 2;
        const a1 = ((i + 1) / covered.length) * Math.PI * 2 - Math.PI / 2;
        const x0 = cx + r * Math.cos(a0);
        const y0 = cy + r * Math.sin(a0);
        const x1 = cx + r * Math.cos(a1);
        const y1 = cy + r * Math.sin(a1);
        return (
          <path
            key={i}
            d={`M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1} Z`}
            fill={c ? '#fff' : 'none'}
            stroke="#525252"
            strokeWidth="1"
            opacity={c ? 0.9 : 1}
          />
        );
      })}
      <circle cx={cx} cy={cy} r="4" fill="#fff" />
    </svg>
  );
}

/**
 * Live tilt for the horizon indicator. Throttled to ~4 Hz so the overlay
 * doesn't re-render on every sensor event. Returns nulls where unsupported.
 * gamma = left-right roll (0 = level); beta ≈ 90 upright in portrait.
 */
export function useDeviceTilt(active: boolean): {
  supported: boolean;
  gamma: number | null;
  beta: number | null;
} {
  const [tilt, setTilt] = useState<{ gamma: number | null; beta: number | null }>({
    gamma: null,
    beta: null,
  });
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (!active || !window.DeviceOrientationEvent) {
      if (active) setSupported(false);
      return;
    }
    setSupported(true);
    let last = 0;
    let mounted = true;
    const handler = (e: DeviceOrientationEvent) => {
      const now = Date.now();
      if (!mounted || now - last < 250) return;
      last = now;
      if (e.gamma !== null || e.beta !== null) {
        setTilt({ gamma: e.gamma, beta: e.beta });
      }
    };
    window.addEventListener('deviceorientation', handler);
    return () => {
      mounted = false;
      window.removeEventListener('deviceorientation', handler);
    };
  }, [active]);

  return { supported, gamma: tilt.gamma, beta: tilt.beta };
}
