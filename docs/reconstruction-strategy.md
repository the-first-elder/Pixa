# 3D reconstruction strategy (verified 2026-10-27, updated with KIRI key + OSS review)

Constraint recap: M4 Pro, no CUDA, ~17 GB free disk, no GPU worker yet.
Rule: never fake reconstruction. Mesh only as honestly-labeled interim.

## KIRI account status

- Key secured in repo `.env` as `KIRI_API_KEY` (gitignored, never committed, never frontend).
- **Balance verified live: 10 credits. Spend so far: 0.**
- Pricing confirmed from live docs: 1 call = 1 credit = $1, min $500 recharge, 10 free credits.
- Endpoints implemented in `services/reconstruction/worker/backends/kiri.py` (verified against live docs):
  `GET /v1/open/balance` · `POST /v1/open/3dgs/video` (≤1920×1080, ≤3 min, `isMesh`/`isMask`/`fileFormat`)
  · `GET /v1/open/model/getStatus` (-1/0/3 running, 2 done, 1/4 failed)
  · `GET /v1/open/model/getModelZip` (link valid 60 min).
- **Credit guard:** `submit()` refuses without `--allow-spend`; pre-flight probe
  (resolution/duration) + balance check run before any spend; camera poses
  recorded as unavailable for KIRI jobs. Guard + error paths tested with zero spend.
- Async flow: `worker process --backend kiri --allow-spend` → `worker poll <jobId>`
  (repeat; transitions reconstructing → ready/failed, fetches + unzips asset on done).

## Open-source review (researched 2026-10-27, nothing installed, $0 spent)

| Option | What it is | Replaces KIRI reconstruction? |
|---|---|---|
| **OpenSplat** (`WebODM/OpenSplat`, AGPL-3.0, active) | 3DGS **trainer only** (needs COLMAP poses first); Metal/CPU build possible, CPU ~100× slower | Partially — as trainer in a COLMAP+trainer pipeline, not video-in one step |
| **Splat Studio** (`CodeByKeegan/splat-studio`) | GUI for `@playcanvas/splat-transform`: convert/inspect only | **No** — no training/SfM/video input. Useful as the local PLY→SPZ/SOG converter |
| **SplatStream** (`jaesung-cs/splatstream`) | Python Vulkan **renderer**, explicitly no training | **No**. Ignore (web uses Spark/Three) |
| **Spirula Studio** (`harry7557558/spirula-studio`, GPL-3.0) | Cross-vendor trainer, **macOS/Apple Silicon validated Aug 2026**, single binary, built-in SfM + frame extraction from video, 10M Gaussians in 8GB VRAM | **Candidate $0 local path — validate on Fixture A first** |
| Postshot | Desktop Windows + NVIDIA only | No (this machine) |
| HF Spaces / Colab trainers | Stale/broken or session-limited | No (unreliable as pipeline) |
| LichtFeld-Studio | Trains, but NVIDIA-only | No (this machine) |

This supersedes the old "do not train on Mac" line: Spirula (Aug 2026) postdates it.
Local-COLMAP-sparse + OpenSplat remains a disk-constrained fallback (needs ≥10 GB freed).

## Spirula status: INSTALLED + smoke-tested (2026-10-27, $0)

- Binary: `spirula` v2026.10.16 (macOS ARM64, 150 MB) at `~/.pixa/bin/spirula`
  (`WL_SPIRULA_BIN` overrides). Vulkan/MoltenVK device confirmed working.
- CLI contract verified live: `sfm auto IMAGES -o WORKSPACE` → COLMAP-format
  `sparse/0`; `train --data WORKSPACE --data-format colmap --num-iterations N` → `.ply`.
- Backend implemented: `services/reconstruction/worker/backends/spirula.py`
  (extract → sfm → train → newest `.ply`; `--iterations` configurable; 2 h SfM / 6 h
  train guardrails; missing-binary and low-frame-count failures are explicit).
- Failure path proven on synthetic footage: SfM correctly rejected footage with
  no multi-view geometry (`SPIRULA_FAILED`, transitions recorded, no fake success).
- Training quality on REAL footage is untested — needs Fixture A.

## Ranked plan (cheapest reliable first)

1. **$0 now: Spirula Studio macOS binary on a 30 s real clip** (frame extract + SfM + train in one binary). If quality holds → primary local path.
2. **$0 smoke: 1 KIRI free credit on the same 30 s clip** (`isMesh=1,fileFormat=glb`) → inspect ZIP (splat PLY? mesh? poses?). Keeps 9 credits in reserve.
3. **~$1–3 exit gate: RunPod RTX 3090 Secure** — `scripts/runpod_train.sh`
   (`ns-process-data` → `splatfacto` 30k → `ns-export`) → PLY + `transforms.json`
   → local convert (Splat Studio / `splat-transform`) → `.spz`/`.sog`. Poses + diagnostics included.
4. Converter role only: Splat Studio / `splat-transform` for PLY→SPZ/SOG + inspection.

## Next actions (owner)

1. Record Fixture A + Fixture B per `docs/capture-protocol.md`.
2. Approve the $0 Spirula trial + 1-credit KIRI smoke test on a 30 s cut of Fixture A.
3. RunPod account when the reproducible GPU artifact is needed (~$1–3).

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
