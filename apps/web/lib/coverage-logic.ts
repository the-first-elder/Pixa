/**
 * Coverage compass math (pure, unit-tested). Sectors are RELATIVE to the
 * heading where recording started — never absolute compass points (the
 * old code marked absolute yaw but labeled directions as if relative, so
 * hints pointed the wrong way unless you started facing north).
 *
 * A sector counts as covered only after DWELL_MS of accumulated filming
 * in it at acceptable quality: one sensor tick sweeping past a direction
 * is not coverage, and treating it as such produced reconstructions full
 * of gaps the UI claimed were filmed.
 */

export const SECTORS = 12; // 30° each
export const DWELL_MS = 1200;

const DIRECTIONS = [
  'ahead', 'right-ahead', 'right', 'right-behind',
  'behind', 'left-behind', 'left', 'left-ahead',
] as const;

/** Yaw normalized to 0..360. */
export function normYaw(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Sector index for a yaw relative to startYaw (sector 0 = ahead). */
export function sectorFor(yawDeg: number, startYawDeg: number): number {
  const rel = normYaw(yawDeg - startYawDeg);
  return Math.floor(rel / (360 / SECTORS)) % SECTORS;
}

/**
 * Accumulate dwell for the current sector. Returns true when state changed
 * (sector newly covered). Mutates dwellMs; covered is derived.
 */
export function accumulateDwell(
  dwellMs: number[],
  sector: number,
  deltaMs: number,
  qualityOk: boolean,
): boolean {
  if (!qualityOk || deltaMs <= 0 || deltaMs > 2000) return false;
  const before = dwellMs[sector] >= DWELL_MS;
  dwellMs[sector] += deltaMs;
  return !before && dwellMs[sector] >= DWELL_MS;
}

export function coveredFromDwell(dwellMs: number[]): boolean[] {
  return dwellMs.map((d) => d >= DWELL_MS);
}

/**
 * Direction hint for the largest uncovered run (circular), named relative
 * to start. Null when nothing filmed yet or everything is covered.
 */
export function largestGapHint(covered: boolean[]): string | null {
  const n = covered.length;
  if (!covered.some(Boolean) || covered.every(Boolean)) return null;
  // Find the longest circular run of uncovered sectors.
  let bestStart = -1;
  let bestLen = 0;
  for (let s = 0; s < n; s++) {
    if (covered[s]) continue;
    // Only start at run boundaries.
    if (!covered[(s - 1 + n) % n]) continue;
    let len = 0;
    while (len < n && !covered[(s + len) % n]) len++;
    if (len > bestLen) {
      bestLen = len;
      bestStart = s;
    }
  }
  if (bestStart < 0) return null;
  const centerSector = (bestStart + bestLen / 2) % n;
  const dir = DIRECTIONS[Math.round((centerSector / n) * 8) % 8];
  return `Unfilmed area ${dir} — turn slowly that way and hold a moment.`;
}

/** Tilt flags from beta (portrait upright ≈ 90). */
export function tiltFlags(beta: number | null): { up: boolean; down: boolean } {
  return {
    up: beta !== null && beta < 45,
    down: beta !== null && beta > 135,
  };
}
