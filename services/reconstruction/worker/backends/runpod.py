"""RunPod cloud-GPU backend (reproducible COLMAP + splatfacto + poses).

No RunPod account exists yet, so this backend tracks a MANUALLY launched pod run:
  1. Owner launches RTX 3090 Secure pod (PyTorch/CUDA template, 50 GB volume).
  2. Owner uploads frames (produced by `worker extract --pipeline B`).
  3. Inside the pod, owner runs scripts/runpod_train.sh (ns-process-data video
     → ns-train splatfacto 30k → ns-export gaussian-splat → splat.ply).
  4. Owner downloads splat.ply + transforms.json, then runs
     `worker process ... --backend runpod --asset <splat.ply> --poses <transforms.json>`
     to complete the job honestly with real artifacts + diagnostics.

Stage 1 may add RunPod HTTP API automation; the manual recipe stays as fallback.
"""
from __future__ import annotations

import os
import shutil
from typing import Any

from .. import store


class RunpodBackend:
    name = "runpod"

    def submit(self, job: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        asset = ctx.get("asset")
        if not asset or not os.path.exists(asset):
            raise RuntimeError(
                "RunPod backend needs a real training artifact: launch the pod per "
                "docs/reconstruction-strategy.md, run scripts/runpod_train.sh, "
                "then re-run with --asset <splat.ply> [--poses <transforms.json>]."
            )
        return {"asset": os.path.abspath(asset), "poses": ctx.get("poses")}

    def status(self, handle: dict[str, Any]):
        return ("done", 1.0, None)

    def fetch_asset(self, handle: dict[str, Any], dest_dir: str) -> dict[str, Any]:
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, os.path.basename(handle["asset"]))
        if os.path.abspath(handle["asset"]) != os.path.abspath(dest):
            shutil.copy2(handle["asset"], dest)
        out: dict[str, Any] = {"assetPath": dest, "format": "ply", "posesPath": None}
        if handle.get("poses") and os.path.exists(handle["poses"]):
            pdest = os.path.join(dest_dir, os.path.basename(handle["poses"]))
            shutil.copy2(handle["poses"], pdest)
            out["posesPath"] = pdest
        return out
