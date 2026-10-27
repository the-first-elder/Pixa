"""Local backend: real FFmpeg steps on this machine.

Honesty rule: if the `colmap` binary is absent, pose estimation is UNAVAILABLE
and the job fails with NO_LOCAL_POSES (pointing at KIRI/RunPod docs) instead of
inventing camera poses. Sparse-only; dense MVS will not fit small disks.
"""
from __future__ import annotations

import os
import shutil
from typing import Any

from .. import media, store


class LocalBackend:
    name = "local"

    def submit(self, job: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        video = ctx["video"]
        workdir = os.path.join(store.storage_dir(), "work", job["id"])
        os.makedirs(workdir, exist_ok=True)
        return {"workdir": workdir, "video": video}

    def status(self, handle: dict[str, Any]):
        return ("running", None, None)

    def run(self, job_id: str, handle: dict[str, Any]) -> dict[str, Any]:
        job = store.get_job(job_id)
        workdir = handle["workdir"]
        try:
            store.transition(job_id, "extracting_frames", progress=10)
            frames_b = media.extract_frames(
                handle["video"], os.path.join(workdir, "frames-B"), "B"
            )
            frames_a = media.extract_frames(
                handle["video"], os.path.join(workdir, "frames-A"), "A"
            )
            store.transition(job_id, "estimating_camera_poses", progress=35)
            if shutil.which("colmap") is None:
                raise RuntimeError(
                    "NO_LOCAL_POSES: `colmap` binary not found on this machine. "
                    "Use backend=kiri (hosted 3DGS API) or backend=runpod "
                    "(cloud GPU). See docs/reconstruction-strategy.md."
                )
            # COLMAP-sparse path is implemented when a poses/diagnostics trial
            # is attempted (Stage 1). Until then, fail loudly, never silently.
            raise RuntimeError(
                "NO_LOCAL_POSES: local COLMAP-sparse runner not yet implemented "
                "(Stage 1). Use backend=kiri or backend=runpod."
            )
        except RuntimeError as e:
            msg = str(e)
            code = msg.split(":")[0] if ":" in msg else "LOCAL_FAILED"
            return store.transition(
                job_id, "failed", progress=None, errorCode=code, errorMessage=msg
            )
        raise AssertionError("unreachable")

    def fetch_asset(self, handle: dict[str, Any], dest_dir: str) -> dict[str, Any]:
        raise RuntimeError("Local backend produces no downloadable asset yet (Stage 1).")
