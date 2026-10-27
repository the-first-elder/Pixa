"""Spirula Studio local backend — $0 on-device reconstruction (M4 Pro, Vulkan/Metal).

Verified 2026-10-27: `spirula` v2026.10.16 runs on this machine, `sam devices`
lists a working Vulkan device (MoltenVK), CLI contract confirmed via --help:
  spirula sfm auto IMAGES -o WORKSPACE     -> WORKSPACE/{features,matches.bin,sparse/0}
  spirula train --data WORKSPACE --data-format colmap [--num-iterations N]
                                             -> outputs/<run>/*.ply

Pipeline: FFmpeg frames-B (overlap-preserving) -> sfm auto -> train ->
newest .ply under outputs/. Poses come from the COLMAP-format sparse model
(sparse/0) — recorded as posesPath for Stage 3 registration.

Honesty: if sfm finds no connected model or train produces no PLY, the job
fails with a named error. Never fabricate cameras or splats.

Binary location: $WL_SPIRULA_BIN, else ~/.worldlens/bin/spirula.
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
from typing import Any

from .. import media, store

DEFAULT_BIN = os.path.expanduser("~/.worldlens/bin/spirula")
SFM_TIMEOUT = 2 * 60 * 60
TRAIN_TIMEOUT = 6 * 60 * 60


class SpirulaError(RuntimeError):
    pass


def binary() -> str:
    path = os.environ.get("WL_SPIRULA_BIN", DEFAULT_BIN)
    if not (os.path.isfile(path) and os.access(path, os.X_OK)):
        raise SpirulaError(
            f"Spirula binary not found/executable at {path}. "
            "Install: download spirula-*-macos-vulkan-arm64.dmg from "
            "github.com/harry7557558/spirula-studio/releases and copy the "
            "`spirula` executable there (or set WL_SPIRULA_BIN)."
        )
    return path


def _run(cmd: list[str], timeout: int) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError as e:
        raise SpirulaError(f"Failed to launch {' '.join(cmd[:2])}: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise SpirulaError(f"Timed out after {timeout}s: {' '.join(cmd[:3])}...") from e
    if p.returncode != 0:
        tail = (p.stderr or p.stdout or "")[-800:]
        raise SpirulaError(f"{cmd[1]} {cmd[2]} failed (exit {p.returncode}): {tail}")
    return p.stdout or ""


class SpirulaBackend:
    name = "spirula"

    def submit(self, job: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        binary()  # fail fast with install instructions
        video = ctx["video"]
        if not os.path.exists(video):
            raise SpirulaError(f"Video not found: {video}")
        workdir = os.path.join(store.storage_dir(), "work", job["id"], "spirula")
        os.makedirs(workdir, exist_ok=True)
        return {"workdir": workdir, "video": video,
                "iterations": int(ctx.get("iterations", 30000))}

    def status(self, handle: dict[str, Any]):
        marker_done = os.path.join(handle["workdir"], "DONE")
        marker_failed = os.path.join(handle["workdir"], "FAILED")
        if os.path.exists(marker_done):
            return ("done", 1.0, None)
        if os.path.exists(marker_failed):
            return ("failed", None, None)
        return ("running", None, None)

    def run(self, job_id: str, handle: dict[str, Any]) -> dict[str, Any]:
        workdir = handle["workdir"]
        binpath = binary()
        images = os.path.join(workdir, "images")
        workspace = os.path.join(workdir, "workspace")

        def mark(name: str, text: str = "") -> None:
            with open(os.path.join(workdir, name), "w", encoding="utf-8") as f:
                f.write(text)

        try:
            store.transition(job_id, "extracting_frames", progress=10)
            frames_b = media.extract_frames(handle["video"], images, "B")
            if frames_b["count"] < 8:
                raise SpirulaError(
                    f"Only {frames_b['count']} reconstruction frames extracted; "
                    "need overlapping views of a real scene (see docs/capture-protocol.md)."
                )
            store.transition(job_id, "estimating_camera_poses", progress=30)
            _run([binpath, "sfm", "auto", images, "-o", workspace], SFM_TIMEOUT)
            sparse = os.path.join(workspace, "sparse", "0")
            if not (os.path.isdir(sparse) and os.listdir(sparse)):
                raise SpirulaError(
                    "SfM produced no connected sparse model (sparse/0 missing/empty). "
                    "The footage likely lacks overlapping views or stable features — "
                    "re-record per docs/capture-protocol.md. No poses invented."
                )
            store.transition(job_id, "reconstructing", progress=50)
            _run([binpath, "train", "--data", workspace, "--data-format", "colmap",
                  "--num-iterations", str(handle["iterations"]),
                  "--output-dir-prefix", os.path.join(workdir, "outputs")],
                 TRAIN_TIMEOUT)
            plys = sorted(
                glob.glob(os.path.join(workdir, "outputs", "**", "*.ply"), recursive=True),
                key=os.path.getmtime,
            )
            if not plys:
                raise SpirulaError(
                    "Training finished but produced no .ply asset. Treating as failure, not success."
                )
            asset_path = plys[-1]
            jobs = store._load("jobs.json")
            jobs[job_id]["asset"] = {
                "assetPath": asset_path,
                "format": "ply",
                "posesPath": sparse,
                "posesFormat": "colmap-sparse",
                "framesB": frames_b["count"],
            }
            jobs[job_id]["diagnostics"] = {
                "cameraPosesEstimated": True,
                "framesRegistered": None,
                "framesRejected": None,
                "coverageConcentratedInOneArea": None,
                "largeGapsOrUnstableRegions": None,
                "notes": [
                    "Poses from Spirula SfM (COLMAP-format sparse/0). "
                    "Per-frame registration counts not yet parsed (Stage 3).",
                ],
            }
            store._save("jobs.json", jobs)
            mark("DONE", asset_path)
            store.transition(job_id, "compressing", progress=90)
            return store.transition(job_id, "ready", progress=100)
        except (SpirulaError, media.MediaError, OSError) as e:
            msg = str(e)[:500]
            code = "SPIRULA_FAILED"
            for prefix in ("SPIRULA_", "NO_"):
                if msg.startswith(prefix):
                    code = msg.split(":")[0]
                    break
            mark("FAILED", msg)
            return store.transition(job_id, "failed", progress=None,
                                    errorCode=code, errorMessage=msg)

    def fetch_asset(self, handle: dict[str, Any], dest_dir: str) -> dict[str, Any]:
        jobs = store._load("jobs.json")
        asset = None
        for j in jobs.values():
            if isinstance(j.get("asset"), dict) and handle["workdir"] in j["asset"].get("assetPath", ""):
                asset = j["asset"]
                break
        if not asset:
            raise SpirulaError("No completed Spirula asset for this handle (job not ready).")
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, os.path.basename(asset["assetPath"]))
        if os.path.abspath(asset["assetPath"]) != os.path.abspath(dest):
            shutil.copy2(asset["assetPath"], dest)
        return {"assetPath": dest, "format": "ply",
                "posesPath": asset.get("posesPath"), "posesFormat": asset.get("posesFormat")}
