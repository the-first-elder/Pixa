# Building-quality report: make the reconstruction feel like a real building

Date: 2026-10-27. Scene under test: User scene 4 (scene_5abb5015, 150-frame phone capture).

## 1. Audit findings (verified, not assumed)

| # | Symptom | Root cause (evidence) | Layer |
|---|---|---|---|
| 1 | World visibly banked ~31° | SfM "levelled on ground plane (11% of points)" locked onto a weak plane. RANSAC floor fit: 31.2° tilt, 867/4000 inliers | Reconstruction |
| 2 | Initial view black / staring at floor | Viewpoints used blind pose forwards; some poses are SfM orientation outliers (B0061 forward reads 77° down while its photo is level) | Navigation data |
| 3 | Camera forward convention uncertain | Resolved empirically: door projection lands inside its SAM box with +z depth (frame B121 MATCH); table flights center correctly | Verified OK |
| 4 | Smears off the capture path | Single-pass portrait capture; areas seen once at grazing angles stretch. Floater filter removed only 719/973K (not noise — missing views) | Reconstruction (source-limited) |
| 5 | WASD moved camera while typing | Global key handler ignored focus target | UI bug (fixed) |
| 6 | Orbit felt detached/miniature | FOV 60 + exterior-biased initial framing | Camera (fixed: FOV 72) |
| 7 | Abrupt motion starts/stops | Direct position integration, no velocity smoothing | Camera (fixed) |

## 2. Improvements implemented

- **Gravity levelling**: RANSAC floor plane → correction quaternion in manifest (`upCorrection`); splats, collision mesh, and markers render inside a rotated world group. Backend positions untouched (distances preserved).
- **Entity-anchored viewpoints**: capture views look at the nearest multi-view-validated entity instead of blind pose forwards (immune to orientation outliers).
- **Mid-walk first spawn** (frame 0 is often a doorway fumble).
- **FOV 60 → 72**, ACES tone mapping (compared, kept — no washout observed).
- **Velocity smoothing** (accel/decel lerp) in rooms walk; eye-scaled collision distance; floor snap; entry snap to eye level + level gaze.
- **Chat typing** never hijacked by movement keys (verified: "wasd WASD test" typed in Rooms mode).

## 3. Before / after (same scene)

- Before: initial spawn stared at the floor / black void (`wl-t3room4.png`).
- After: initial spawn shows the room — curtain rod, door, tiled wall (`wl-entity-view.png`).
- Banking: pre-correction views lean ~30° (`wl-fwd.png`); post-correction views are near-level (`wl-level.png`, `wl-entity-view.png`).

## 4. Systematic test results (headless Chromium, M4 Pro)

Load, 360° look, slow + fast rotation, rooms walk (W/A/S/D), tour transitions, chat highlight ("Show me the door" → obj_01 in focus), two resizes: **all pass, 0 console errors, 0 failed requests** across every session.
- FPS idle: 60 (vsync-capped). JS heap after full workout: ~148 MB.
- Asset: 24.7 MB SPZ (973K splats) + 18 MB collision mesh; manifest-driven load.
- Headless software-GL asset parse is slow (~60–90 s); real GPUs stream the same bytes far faster. Not claimed as a load-time figure.

## 5. Remaining defects (reconstruction-limited, documented not hidden)

1. **Off-path smearing persists**: single-pass portrait footage leaves thinly-observed angles that stretch. Only denser capture fixes it (two heights, loop closure, landscape).
2. **World-up is approximate**: RANSAC floor fit has 22% consensus; residual bank of a few degrees is possible. A mesh-normal histogram would refine it.
3. **Multi-instance entities**: two physical doors share one "door" entity (consensus pair wins). True instance tracking needs SAM video tracking.
4. **No metric scale by default**: eye height (0.3–0.6 units) and speeds are unit-relative until the user calibrates with a real measurement.
5. **Collision is proxy-grade**: blobby mesh; soft walls, approximate door edges. Labelled experimental in the UI.
6. **Portrait lens**: narrow FOV capture → thin rooms need more passes than landscape.

## 6. Genuinely supported now

Orbit / fly / eye-level rooms walk with wall slide + floor snap; NL navigation to 4 pose-derived viewpoints; object highlight markers at triangulated positions; evidence-viewpoint flights for unregistered detections; guided tours; voice input; coverage badges with gap-aware refusal; measurement in units + meter calibration flow.

## 8. Addendum: interior containment (2026-10-28)

Complaint: exterior imagery visible when moving up/outside.

**Reproduction results**: looking up shows the real ceiling (fan, light, poster — good coverage); fly-up stays inside via the volume clamp; wheel-zoom was suspected broken but verified working (harness delivery issue, not app code).
**Cause of exterior exposure**: orbit zoom-out and free flight can leave the room volume; splats span x −2..6.9 / y −2.8..3.8 / z −4.4..2.4 (sampled) while the capture trajectory spans ~2 — far splats are legitimate walls/floor/ceiling seen from inside, not removable background. Per the spec's own warning, no box-filter was applied (it would cut real walls).
**Implemented**: Orbit renamed to Overview (explicit outside mode); Rooms is first-person with floor snap + wall slide + new ceiling clamp (raycast up, capped below ceiling; unknown overhead stays passable); bounds clamp in all modes; AI flights and tours use the same validated controls.
**Verified**: rooms walk screenshot shows coherent interior at eye level, 0 console errors.

Complaint: scene looks good stationary, degrades when moving.

**Diagnosis (evidence-backed): the renderer is exonerated; the cause is viewpoint content, not motion.**
- No adaptive degradation exists in our code or Spark defaults (LOD off, fixed DPR, fixed density, sortRadial on).
- Decisive test: screenshotted the SAME off-path viewpoint mid-drag and after a 10 s settle — visually identical smears. If motion caused it, the settled frame would be clean. It is not.
- Sort-staleness is real in principle (async worker sort), but A/B showed decimation 973K→498K→243K and a 10× minAlpha bump do not change the artifact, while a small dense scene stays clean in motion. Severity tracks reconstruction thinness, not motion speed.
- The settled-vs-motion gap the user sees is: initial views are entity-anchored (dense areas look good); any rotation leaves them for thinly-observed angles (single-pass portrait capture). Movement only *reveals* thin regions.

**What was changed**: reverted all experimental tweaks (minAlpha, decimated assets); removed the AB test scene. No renderer change can recover views that were never captured.
**What actually helps**: denser capture (the existing guidance); guided movement already prefers validated viewpoints; free orbit into thin zones renders honest smear/black, flagged by coverage.
