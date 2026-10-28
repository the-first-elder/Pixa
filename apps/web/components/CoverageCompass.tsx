'use client';

import { useEffect, useRef, useState } from 'react';

const SECTORS = 12; // 30° each

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
 * Marks which yaw sectors have been filmed with acceptable quality and
 * whether the user ever tilted to ceilings/floors. Gracefully absent
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
  const coveredRef = useRef<boolean[]>(Array(SECTORS).fill(false));
  const flagsRef = useRef({ up: false, down: false });
  const qualityRef = useRef(qualityOk);
  qualityRef.current = qualityOk;

  useEffect(() => {
    if (!active) return;
    const DOE = window.DeviceOrientationEvent as unknown as
      | { requestPermission?: () => Promise<string> }
      | undefined;
    if (!window.DeviceOrientationEvent) return;
    setState((s) => ({ ...s, supported: true }));
    let mounted = true;

    const mark = (alpha: number | null, beta: number | null) => {
      if (alpha === null || !qualityRef.current) return;
      const yaw = ((alpha % 360) + 360) % 360;
      coveredRef.current[Math.floor(yaw / (360 / SECTORS)) % SECTORS] = true;
      if (beta !== null) {
        // Portrait upright ≈ 90. Tilt back (look up) drops beta; tilt forward raises it.
        if (beta < 45) flagsRef.current.up = true;
        if (beta > 135) flagsRef.current.down = true;
      }
      if (!mounted) return;
      const covered = [...coveredRef.current];
      const missing = covered
        .map((c, i) => (!c ? i : -1))
        .filter((i) => i >= 0);
      let hint: string | null = null;
      if (missing.length > 0 && covered.some(Boolean)) {
        // Find the largest missing run and name its direction.
        const names = ['ahead', 'right-ahead', 'right', 'right-behind', 'behind', 'left-behind', 'left', 'left-ahead'];
        // Map sector index to rough direction relative to start (sector 0 = start).
        const first = missing[0];
        const dir = names[Math.round(((first / SECTORS) * 8) % 8)];
        hint = `Unfilmed area ${dir} — turn slowly that way.`;
      }
      setState({
        supported: true,
        permission: 'granted',
        covered,
        lookedUp: flagsRef.current.up,
        lookedDown: flagsRef.current.down,
        uncoveredHint: hint,
      });
    };

    const handler = (e: DeviceOrientationEvent) => mark(e.alpha, e.beta);
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
        const handler = (e: DeviceOrientationEvent) => {
          if (e.alpha === null || !qualityRef.current) return;
          const yaw = ((e.alpha % 360) + 360) % 360;
          coveredRef.current[Math.floor(yaw / (360 / SECTORS)) % SECTORS] = true;
        };
        window.addEventListener('deviceorientation', handler);
        setState((s) => ({ ...s, permission: 'granted' }));
      } else {
        setState((s) => ({ ...s, permission: 'denied' }));
      }
    } catch {
      setState((s) => ({ ...s, permission: 'denied' }));
    }
  }

  function reset() {
    coveredRef.current = Array(SECTORS).fill(false);
    flagsRef.current = { up: false, down: false };
    setState((s) => ({ ...s, covered: [...coveredRef.current], lookedUp: false, lookedDown: false, uncoveredHint: null }));
  }

  return { state, requestPermission, reset };
}

/** Circular coverage display: lit sectors filmed, dim sectors missing. */export function CompassDial({ covered }: { covered: boolean[] }) {
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
