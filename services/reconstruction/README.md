# Reconstruction worker

`python -m worker <command>` — see `python -m worker --help`.

## Commands

| Command | What it does |
|---|---|
| `probe <video>` | Validates + reports metadata, checksums, frame estimates (no writes except stdout) |
| `extract <video> --out <dir> --pipeline A\|B` | Extracts frames. A = analysis (1 fps, cap 120). B = reconstruction (2 fps, ≤1600px, overlap-preserving) |
| `process <video> --backend local\|kiri\|runpod` | Full job: scene + job records, pipeline steps, manifest, diagnostics |
| `jobs` | Lists recorded job transitions |

## Backends (`worker/backends/`)

One interface (`submit/status/fetch-asset/fetch-poses/fetch-diagnostics`).
The web app never knows which backend ran a job — only the manifest.

- `local` — real FFmpeg steps on this machine; COLMAP-sparse only if the
  `colmap` binary exists, else the job fails HONESTLY with `NO_LOCAL_POSES`
  pointing at the KIRI/RunPod docs. Never fake poses.
- `kiri` — KIRI Engine 3DGS Video API client (needs `KIRI_API_KEY`).
- `runpod` — recipe + scripts for a manual launches an RTX 3090 pod run
  (`scripts/runpod_train.sh` runs inside the pod); the poller tracks the run.

Job/store state lives under `$STORAGE_DIR` (default `./data`), JSON files with
atomic writes. Every state transition is appended to the job record.
