# 3D reconstruction strategy (verified 2026-10-27)

Constraint recap: M4 Pro, no CUDA, ~17 GB free disk, no GPU worker yet.
Rule: never fake reconstruction. Mesh only as honestly-labeled interim.

## Decision

Two-track, pluggable worker (`services/reconstruction/backends/`):

| Track | What | Cost | When |
|---|---|---|---|
| **A. KIRI Engine 3DGS Video API** (fastest real 3D) | Phone video → real 3DGS PLY + optional mesh (`isMesh=1` → glb/obj) | 10 free credits, then $1/credit, min $500 preload | Smoke test on 30 s clip immediately; demo asset if quality holds |
| **B. RunPod RTX 3090 Secure** (reproducible + poses) | `ns-process-data` (COLMAP) → `ns-train splatfacto` 30k iters → `ns-export gaussian-splat` → `splat.ply` + `transforms.json` | ~$0.50/hr → ~$1–3/scene, 1–2.5 h wall | Stage 1 exit-gate artifact + diagnostics source |

KIRI docs: REST `https://api.kiriengine.app/api/`, `POST /v1/open/3dgs/video`
(`videoFile`, `isMesh`, `fileFormat`; ≤1920×1080, ≤3 min), async poll + webhooks,
zipped download (link valid 60 min). **Camera poses NOT returned** — derive viewer
viewpoints ourselves; run COLMAP-sparse in parallel for diagnostics if needed.

RunPod recipe: 3090 Secure, PyTorch/CUDA template, 50 GB volume,
`ffmpeg -i in.mp4 -vf fps=2,scale=1600:-1 frames/%04d.jpg` (~150–250 frames),
COLMAP 10–40 min, train 20–45 min, export PLY, convert PLY→SPZ/SOG locally
(SuperSplat / `splat-transform`), terminate pod.

## Apple Silicon verdict

- `brew install colmap` (CPU-only) works; sparse-only SfM on ~150 frames ≤1600px
  MAY fit disk if ≥10 GB is freed first; dense MVS will not fit. Poses/diagnostics
  trial only. **Do not train on Mac: no maintained CPU/Metal 3DGS trainer exists**
  (graphdeco 3DGS, Nerfstudio, gsplat all require CUDA).
- Mac role: FFmpeg extraction, manifest/viewer dev, optional COLMAP-sparse experiment.

## Browser viewer: `@sparkjsdev/spark`

Three-native (`SplatMesh` is a `THREE.Object3D`), npm-available, loads
PLY/SPZ/SPLAT/KSPLAT/SOG, full programmatic camera control (required for
`navigateToLocation` etc.), per-splat highlight hooks. (mkkellogg lib is
unmaintained by author statement; antimatter15/splat has no Three integration;
PlayCanvas is not Three.js — but use SuperSplat as the PLY→SOG/SPZ converter.)

Convert every training PLY → `.spz`/`.sog` before deploy (~15–20× smaller).

## Honest mesh fallback

KIRI `isMesh=1` → `glb` via three `GLTFLoader`, labeled in UI
"Textured mesh preview — splat pending", manifest `assetType: mesh-preview`
(distinct from `splat`). Never present mesh renders as splat proof.

## Next actions (owner)

1. Create KIRI dev account → burn 1 free credit on 30 s clip → inspect zip
   (PLY? mesh? any pose file?).
2. Spin RunPod 3090 → `ns-process-data + ns-train splatfacto` on same clip.
3. Record Fixture A + Fixture B per `docs/capture-protocol.md`.
