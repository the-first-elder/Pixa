/**
 * On-device capture analysis (pure functions, no dependencies).
 * Runs on live camera frames at a few Hz: motion speed, blur, brightness.
 * Zero latency, zero server cost — the real-time half of the capture director.
 * Semantic coverage ("film the doorway") comes from server check-ins.
 *
 * Threshold provenance (calibrated 2026-10-28, not guessed):
 * - Brightness: tester3.mp4 (good capture, 86% registered) measures YAVG
 *   min 57 / mean 68 / max 87 via ffmpeg signalstats. Dark threshold 45 sits
 *   below the worst good footage; bright threshold 210 catches only
 *   genuinely blown-out frames. Canvas RGB-mean tracks YAVG within ±10.
 * - Blur 60: conservative floor — only near-flat or severely smeared frames
 *   trip it (synthetic sharp checkerboard reads ~100000, flat reads 0).
 *   May MISS mild blur but will not nag good footage. Blank walls are a
 *   coverage problem, handled separately — not blur.
 * - Speed 14: mean abs pixel diff between 0.5 s-apart frames on a 160px grid.
 *   Mid-range for walking pans; field-tunable once recorder telemetry exists.
 */

/** Mean absolute inter-frame difference, 0..255. High = fast motion. */
export function frameDiff(prev: ImageData, curr: ImageData): number {
  const a = prev.data;
  const b = curr.data;
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let count = 0;
  // Sample every ~15th pixel with a prime byte stride (61) so periodic
  // textures cannot alias the sampling grid into false stillness.
  for (let i = 0; i < n; i += 61) {
    const la = (a[i] + a[i + 1] + a[i + 2]) / 3;
    const lb = (b[i] + b[i + 1] + b[i + 2]) / 3;
    sum += Math.abs(la - lb);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/** Variance of Laplacian on a downsampled luminance grid. Higher = sharper. */
export function blurScore(frame: ImageData): number {
  const w = frame.width;
  const h = frame.height;
  const d = frame.data;
  // Downsample to ~64px wide grid.
  const gw = 64;
  const gh = Math.max(1, Math.round((h / w) * gw));
  const lum = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const sx = Math.min(w - 1, Math.floor((gx / gw) * w));
      const sy = Math.min(h - 1, Math.floor((gy / gh) * h));
      const idx = (sy * w + sx) * 4;
      lum[gy * gw + gx] = (d[idx] + d[idx + 1] + d[idx + 2]) / 3;
    }
  }
  // Laplacian variance over interior.
  let mean = 0;
  let count = 0;
  const laps: number[] = [];
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const lap =
        4 * lum[y * gw + x] -
        lum[(y - 1) * gw + x] -
        lum[(y + 1) * gw + x] -
        lum[y * gw + x - 1] -
        lum[y * gw + x + 1];
      laps.push(lap);
      mean += lap;
      count++;
    }
  }
  if (count === 0) return 0;
  mean /= count;
  let variance = 0;
  for (const l of laps) variance += (l - mean) * (l - mean);
  return variance / count;
}

/** Mean luminance 0..255. */
export function brightness(frame: ImageData): number {
  const d = frame.data;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < d.length; i += 61) {
    sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

export type AdviceKind = 'fast' | 'blur' | 'flat' | 'dark' | 'bright' | 'still' | 'good';

export interface CaptureAdvice {
  level: 'good' | 'warn' | 'bad';
  kind: AdviceKind;
  message: string;
}

/**
 * Guidance engine with hysteresis (counters prevent flickering advice).
 * Thresholds calibrated for indoor phone capture; tune from field data.
 */
export class GuideEngine {
  private fastStreak = 0;
  private blurStreak = 0;
  private darkStreak = 0;
  private brightStreak = 0;
  private stillStreak = 0;

  advise(metrics: { speed: number; blur: number; light: number }): CaptureAdvice[] {
    const out: CaptureAdvice[] = [];
    // Motion: diff > 14 sustained = too fast for overlap.
    if (metrics.speed > 14) {
      this.fastStreak++;
      if (this.fastStreak >= 3) {
        out.push({ level: 'bad', kind: 'fast', message: 'Too fast — move about half as fast for overlapping views.' });
      }
    } else {
      this.fastStreak = 0;
    }
    // Blur: variance < 60 sustained = smeared frames. Distinguish motion
    // blur (moving fast: hold steadier AND slow down) from blank walls
    // (steady but featureless: move to textured views, they reconstruct).
    if (metrics.blur < 60) {
      this.blurStreak++;
      if (this.blurStreak >= 4) {
        if (metrics.speed > 14) {
          out.push({ level: 'warn', kind: 'blur', message: 'Blurry while moving — slow down and hold steadier.' });
        } else {
          out.push({ level: 'warn', kind: 'flat', message: 'Low detail in view (blank wall?) — aim at furniture, doors, textured surfaces.' });
        }
      }
    } else {
      this.blurStreak = 0;
    }
    // Light (see provenance note above).
    if (metrics.light < 45) {
      this.darkStreak++;
      if (this.darkStreak >= 4) {
        out.push({ level: 'warn', kind: 'dark', message: 'Too dark — turn on lights or avoid filming into darkness.' });
      }
    } else {
      this.darkStreak = 0;
    }
    if (metrics.light > 210) {
      this.brightStreak++;
      if (this.brightStreak >= 4) {
        out.push({ level: 'warn', kind: 'bright', message: 'Overexposed — avoid pointing directly at bright windows or bulbs.' });
      }
    } else {
      this.brightStreak = 0;
    }
    if (out.length === 0 && this.fastStreak === 0) {
      // Standing still wastes recording time without new viewpoints — but only
      // nag after ~8 s (16 ticks at 2 Hz); brief pauses to look are fine.
      if (metrics.speed < 2) {
        this.stillStreak++;
        if (this.stillStreak >= 16) {
          out.push({ level: 'warn', kind: 'still', message: 'Standing still — keep walking slowly to cover new views.' });
        }
      } else {
        this.stillStreak = 0;
      }
    } else {
      this.stillStreak = 0;
    }
    if (out.length === 0 && this.fastStreak === 0) {
      out.push({ level: 'good', kind: 'good', message: 'Good pace — keep panning slowly with overlapping views.' });
    }
    return out;
  }
}
