# Reconstruction benchmark: premium visual quality on Apple Silicon

Date: 2026-10-28. Baseline scene: User scene 4 (scene_5abb5015).

## Phase 1 — Audited pipeline (verified)

| Component | Version / setting |
|---|---|
| Trainer | Spirula Studio 2026.10.16 (Vulkan/Metal, M4 Pro) |
| Poses | `spirula sfm auto`, `--data-type video --pairs sequential`, loop closure on |
| Frames | 2 fps, ≤1600px wide (WAS upscaling 478p→1600px: wasteful, fixed to downscale-only) |
| Source | 478×850 H.264 portrait phone video, 30 fps, 75 s |
| Registration | 150/150 (100%), 37.5K points, reproj mean 1.10 px |
| Training | 30k iters, ~60 min, final PSNR ~34–36, 973K splats (1M cap hit) |
| Assets | 247 MB PLY → 24 MB SPZ; 18 MB textured mesh (310K tris) |
| Renderer | @sparkjsdev/spark 2.4.0 + three 0.186.1; radial sort, LOD off, DPR≤2, ACES |
| Poses/mesh/points | All present and validated (forward convention proven vs photos) |

## Phase 2 — Baseline (fixed viewpoints)

Initial spawn (entity-anchored), ±200px drags, ceiling/floor looks, tour stops.
Stationary dense views: coherent and detailed. Off-path views: smear/floaters.
60 FPS idle (vsync), ~148 MB JS heap, 0 console errors across all sessions.

## Phase 3 — Alternatives evaluated

1. **Native-resolution training (IMPLEMENTED)**: stopped upscaling 478p→1600px.
   7k-iter benchmark: 73 s (vs ~9 min upscaled), PSNR 33.2 (vs ~35), 13 MB PLY.
   7× faster SfM+train for equivalent real detail. 30k native run in progress.
2. **Mesh-as-visuals (IMPLEMENTED as Splats|Mesh toggle)**: textured mesh renders
   perfectly stable (no sorting, no popping) with holes where unmeshed; splats
   stay photorealistic where dense. Same data, honest trade-off, user-switchable.
3. **OpenSplat (EVALUATED, not built)**: Mac build needs brew cmake/opencv/pytorch +
   Xcode Metal toolchain (GBs, slow build); MPS default, CPU fallback. Same
   splatfacto quality family as Spirula — would not fix thin-coverage smear, the
   dominant defect. High cost, no expected visual win. Not recommended now.
4. **Density reduction (TESTED, rejected)**: 973K→498K→243K + 10× minAlpha did not
   change in-motion streaking. Decisive same-viewpoint test proved the artifact is
   viewpoint content (thin angles), not motion or sort lag.
5. **KIRI hosted (OFFERED, awaiting approval)**: 1 free credit for a same-footage
   A/B. No spend without explicit approval.

## Recommendation

Ship native-resolution training (faster + honest pixels) and the Splats|Mesh toggle.
Treat remaining smear as capture-density deficit (existing capture guidance), not
a renderer defect. Next highest-impact improvement: denser capture (landscape,
two heights, loop closure) — no local pipeline change beats it.
