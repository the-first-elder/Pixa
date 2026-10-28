/**
 * Capture report: truthful pre-reconstruction quality assessment (no models).
 * Built ONLY from recorded session telemetry: per-sample meters, orientation
 * coverage, tracking-loss events, duration/size. Anything not measured is
 * listed under unevaluated — never invented.
 */

export interface MetricSample {
  t: number; // seconds since record start
  speed: number;
  blur: number;
  light: number;
}

export interface CompassSummary {
  supported: boolean;
  sectorsCovered: number;
  sectorsTotal: number;
  lookedUp: boolean;
  lookedDown: boolean;
  uncoveredHint: string | null;
}

export interface CaptureReport {
  durationSec: number;
  estimatedBytes: number;
  mimeType: string;
  sharpness: { mean: number; p10: number; blurrySharePct: number };
  exposure: { mean: number; min: number; max: number; darkSharePct: number; brightSharePct: number };
  motion: { meanSpeed: number; fastSharePct: number; stillSharePct: number; trackingLossEvents: number };
  orientation: {
    sensors: boolean;
    yawSectorsCovered: string | null;
    ceilingChecked: boolean | null;
    floorChecked: boolean | null;
    rollWarnings: number;
    pitchWarnings: number;
    suddenMoves: number;
  };
  coverage: {
    status: 'provisional';
    note: string;
  };
  unevaluated: string[];
  recommendations: string[];
  verdict: 'likely-ok' | 'needs-work' | 'unknown';
}

function pct(xs: number[], pred: (v: number) => boolean): number {
  if (xs.length === 0) return 0;
  return Math.round((xs.filter(pred).length / xs.length) * 100);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function buildReport(args: {
  samples: MetricSample[];
  durationSec: number;
  estimatedBytes: number;
  mimeType: string;
  compass: CompassSummary;
  rollWarnings: number;
  pitchWarnings: number;
  suddenMoves: number;
}): CaptureReport {
  const { samples } = args;
  const speeds = samples.map((s) => s.speed);
  const blurs = [...samples.map((s) => s.blur)].sort((a, b) => a - b);
  const lights = samples.map((s) => s.light);
  // Tracking loss: sustained extreme frame-to-frame change.
  let trackingLossEvents = 0;
  let run = 0;
  for (const v of speeds) {
    if (v > 60) {
      run++;
      if (run === 4) trackingLossEvents++;
    } else {
      run = 0;
    }
  }
  const blurrySharePct = pct(samples.map((s) => s.blur), (v) => v < 60);
  const darkSharePct = pct(samples.map((s) => s.light), (v) => v < 45);
  const brightSharePct = pct(samples.map((s) => s.light), (v) => v > 210);
  const fastSharePct = pct(speeds, (v) => v > 14);
  const stillSharePct = pct(speeds, (v) => v < 2);

  const recommendations: string[] = [];
  if (args.durationSec < 30) {
    recommendations.push('Short recording — aim for 30–120 s covering the whole connected space.');
  }
  if (blurrySharePct > 25) {
    recommendations.push(`${blurrySharePct}% of sampled frames were blurry/low-detail — re-record those stretches slower and steadier.`);
  }
  if (darkSharePct > 25) {
    recommendations.push(`${darkSharePct}% of sampled frames were dark — add light or re-record those parts brighter.`);
  }
  if (fastSharePct > 40) {
    recommendations.push(`Fast motion in ${fastSharePct}% of samples — overlap likely broke; redo at half speed.`);
  }
  if (trackingLossEvents > 0) {
    recommendations.push(`${trackingLossEvents} tracking-loss event(s) (sudden visual jumps) — re-walk those transitions continuously.`);
  }
  if (args.compass.supported) {
    const missing = args.compass.sectorsTotal - args.compass.sectorsCovered;
    if (missing > 0) {
      recommendations.push(`${missing}/${args.compass.sectorsTotal} look directions unfilmed — turn through the missing sectors slowly.`);
    }
    if (!args.compass.lookedUp) recommendations.push('Ceiling never inspected — tilt up once.');
    if (!args.compass.lookedDown) recommendations.push('Floor never inspected — tilt down once.');
  }
  if (args.rollWarnings > 2) {
    recommendations.push('Phone was often tilted sideways — hold it level (horizon indicator helps).');
  }
  if (args.pitchWarnings > 2) {
    recommendations.push('Camera often aimed at floor/ceiling — keep it roughly level while walking.');
  }
  if (args.suddenMoves > 2) {
    recommendations.push('Several sudden turns detected — each one risks breaking the reconstruction chain.');
  }

  const bad =
    blurrySharePct > 40 || darkSharePct > 40 || fastSharePct > 60 || trackingLossEvents > 2;
  const unevaluated = [
    'Semantic content (doors, furniture, room identity) — needs server analysis, not measured on-device.',
    'True 3D overlap — estimated from motion continuity, verified only by reconstruction.',
    'Audio — not recorded.',
  ];
  if (!args.compass.supported) {
    unevaluated.push('Look-direction coverage — motion sensors unavailable on this device/browser.');
  }

  return {
    durationSec: Math.round(args.durationSec),
    estimatedBytes: args.estimatedBytes,
    mimeType: args.mimeType,
    sharpness: {
      mean: Math.round(blurs.reduce((a, b) => a + b, 0) / Math.max(1, blurs.length)),
      p10: Math.round(quantile(blurs, 0.1)),
      blurrySharePct,
    },
    exposure: {
      mean: Math.round(lights.reduce((a, b) => a + b, 0) / Math.max(1, lights.length)),
      min: lights.length ? Math.round(Math.min(...lights)) : 0,
      max: lights.length ? Math.round(Math.max(...lights)) : 0,
      darkSharePct,
      brightSharePct,
    },
    motion: { meanSpeed: Math.round(speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length)), fastSharePct, stillSharePct, trackingLossEvents },
    orientation: {
      sensors: args.compass.supported,
      yawSectorsCovered: args.compass.supported
        ? `${args.compass.sectorsCovered}/${args.compass.sectorsTotal}`
        : null,
      ceilingChecked: args.compass.supported ? args.compass.lookedUp : null,
      floorChecked: args.compass.supported ? args.compass.lookedDown : null,
      rollWarnings: args.rollWarnings,
      pitchWarnings: args.pitchWarnings,
      suddenMoves: args.suddenMoves,
    },
    coverage: {
      status: 'provisional',
      note: 'On-device directional coverage only — not room geometry. True coverage is established by reconstruction diagnostics.',
    },
    unevaluated,
    recommendations,
    verdict: samples.length === 0 ? 'unknown' : bad ? 'needs-work' : 'likely-ok',
  };
}
