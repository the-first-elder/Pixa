/**
 * On-device capture analysis (pure functions, no dependencies).
 * Runs on live camera frames at a few Hz: motion speed, blur, brightness.
 * Zero latency, zero server cost — the real-time half of the capture director.
 * Semantic coverage ("film the doorway") comes from server check-ins.
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

export interface CaptureAdvice {
  level: 'good' | 'warn' | 'bad';
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

  advise(metrics: { speed: number; blur: number; light: number }): CaptureAdvice[] {
    const out: CaptureAdvice[] = [];
    // Motion: diff > 14 sustained = too fast for overlap.
    if (metrics.speed > 14) {
      this.fastStreak++;
      if (this.fastStreak >= 3) {
        out.push({ level: 'bad', message: 'Too fast — move about half as fast for overlapping views.' });
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
          out.push({ level: 'warn', message: 'Blurry while moving — slow down and hold steadier.' });
        } else {
          out.push({ level: 'warn', message: 'Low detail in view (blank wall?) — aim at furniture, doors, textured surfaces.' });
        }
      }
    } else {
      this.blurStreak = 0;
    }
    // Light.
    if (metrics.light < 38) {
      this.darkStreak++;
      if (this.darkStreak >= 4) {
        out.push({ level: 'warn', message: 'Too dark — turn on lights or avoid filming into darkness.' });
      }
    } else {
      this.darkStreak = 0;
    }
    if (metrics.light > 215) {
      this.brightStreak++;
      if (this.brightStreak >= 4) {
        out.push({ level: 'warn', message: 'Overexposed — avoid pointing directly at bright windows or bulbs.' });
      }
    } else {
      this.brightStreak = 0;
    }
    if (out.length === 0 && this.fastStreak === 0) {
      out.push({ level: 'good', message: 'Good pace — keep panning slowly with overlapping views.' });
    }
    return out;
  }
}
