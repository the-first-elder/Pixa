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
import signal
import struct
import subprocess
import time
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


def _run(cmd: list[str], timeout: int, log_path: str) -> str:
    """Run a long child process, STREAMING output to a log file.

    Never use captured pipes here: a verbose trainer fills the pipe buffer
    while the parent waits -> classic deadlock (observed live: train idled at
    0% CPU with 16 KB stuck in the pipe after writing its final checkpoint).
    """
    with open(log_path, "w", encoding="utf-8") as log:
        log.write(f"$ {' '.join(cmd)}\n")
        log.flush()
        try:
            p = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT,
                               timeout=timeout, check=False)
        except FileNotFoundError as e:
            raise SpirulaError(f"Failed to launch {' '.join(cmd[:2])}: {e}") from e
        except subprocess.TimeoutExpired as e:
            raise SpirulaError(f"Timed out after {timeout}s: {' '.join(cmd[:3])}...") from e
    if p.returncode != 0:
        with open(log_path, encoding="utf-8", errors="replace") as log:
            log.seek(0, os.SEEK_END)
            size = log.tell()
            log.seek(max(0, size - 4000))
            tail = log.read()[-800:]
        raise SpirulaError(f"{cmd[1]} {cmd[2]} failed (exit {p.returncode}): {tail}")
    return log_path


def registered_count(images_bin: str) -> int:
    """Images registered in a COLMAP sparse model. First uint64 of images.bin.
    Returns -1 when the file cannot be parsed (unknown, never guessed)."""
    try:
        with open(images_bin, "rb") as f:
            raw = f.read(8)
        if len(raw) < 8:
            return -1
        (n,) = struct.unpack("<Q", raw)
        return int(n) if 0 <= n < 1000000 else -1
    except OSError:
        return -1


def _train_and_watch(binpath: str, workspace: str, iterations: int,
                     workdir: str, timeout: int) -> str:
    """Train to completion, then STOP the process.

    `spirula train` intentionally stays alive after training ("Viewer still
    running -- press Ctrl-C to exit"). So: stream to train.log, watch for the
    "Training complete" marker, then terminate the whole process group.
    Returns the train.log path. Raises SpirulaError on timeout/failure text.
    """
    log_path = os.path.join(workdir, "train.log")
    cmd = [binpath, "train", "--data", workspace, "--data-format", "colmap",
           "--num-iterations", str(iterations),
           "--output-dir-prefix", os.path.join(workdir, "outputs")]
    with open(log_path, "w", encoding="utf-8") as log:
        log.write(f"$ {' '.join(cmd)}\n")
        log.flush()
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True)
    deadline = time.time() + timeout
    try:
        while True:
            if time.time() > deadline:
                raise SpirulaError(
                    f"Training timed out after {timeout}s without completing "
                    f"{iterations} iterations. See {log_path}.")
            with open(log_path, encoding="utf-8", errors="replace") as log:
                tail = log.read()[-2000:]
            if "Training complete" in tail:
                return log_path
            for marker in ("error:", "Error:", "Traceback", "VkResult"):
                if marker in tail:
                    raise SpirulaError(
                        f"Training reported failure ({marker}). See {log_path}.")
            if proc.poll() is not None and "Training complete" not in tail:
                raise SpirulaError(
                    f"Train exited (code {proc.returncode}) before completing. "
                    f"See {log_path}.")
            time.sleep(10)
    finally:
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass


def finalize_job(job_id: str, workdir: str) -> dict[str, Any]:
    """Verify the training artifact and mark the job ready.

    Shared by run() and by the operator for jobs whose trainer finished but
    whose process outlived the run (e.g. killed viewer). The PLY header is
    inspected — a non-splat or empty file never marks a job ready.
    """
    outputs = os.path.join(workdir, "outputs")
    plys = sorted(
        glob.glob(os.path.join(outputs, "**", "*.ply"), recursive=True),
        key=os.path.getmtime,
    )
    if not plys:
        raise SpirulaError("Training finished but produced no .ply asset.")
    asset_path = plys[-1]
    with open(asset_path, "rb") as f:
        header = f.read(1500).decode("ascii", "replace")
    if not header.startswith("ply\n") or "element vertex" not in header:
        raise SpirulaError(f"Asset is not a valid PLY splat file: {asset_path}")
    if os.path.getsize(asset_path) < 1024:
        raise SpirulaError(f"Asset suspiciously small: {asset_path}")
    sparse = os.path.join(workdir, "workspace", "sparse", "0")
    images_dir = os.path.join(workdir, "workspace", "images")
    jobs = store._load("jobs.json")
    jobs[job_id]["asset"] = {
        "assetPath": asset_path,
        "format": "ply",
        "posesPath": sparse if os.path.isdir(sparse) else None,
        "posesFormat": "colmap-sparse",
    }
    frames_b = len([f for f in os.listdir(images_dir) if f.endswith(".jpg")]) if os.path.isdir(images_dir) else None
    jobs[job_id]["diagnostics"] = {
        "cameraPosesEstimated": True,
        "framesRegistered": None,
        "framesRejected": None,
        "framesB": frames_b,
        "coverageConcentratedInOneArea": None,
        "largeGapsOrUnstableRegions": None,
        "notes": [
            "Poses from Spirula SfM (COLMAP-format sparse/0). "
            "Per-frame registration counts not yet parsed (Stage 3).",
        ],
    }
    store._save("jobs.json", jobs)
    with open(os.path.join(workdir, "DONE"), "w", encoding="utf-8") as f:
        f.write(asset_path)
    store.transition(job_id, "compressing", progress=90)
    return store.transition(job_id, "ready", progress=100)


class SpirulaBackend:
    name = "spirula"

    def submit(self, job: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        binary()  # fail fast with install instructions
        video = ctx["video"]
        if not os.path.exists(video):
            raise SpirulaError(f"Video not found: {video}")
        workdir = os.path.join(store.storage_dir(), "work", job["id"], "spirula")
        os.makedirs(workdir, exist_ok=True)
        # Video frames need sequential matching (neighbours + loop closure),
        # not the default individual-photo/exhaustive strategy. Override via
        # ctx["sfmArgs"] when experimenting.
        sfm_args = ctx.get("sfmArgs") or [
            "--data-type", "video", "--pairs", "sequential", "--sequence", ".",
        ]
        return {"workdir": workdir, "video": video,
                "iterations": int(ctx.get("iterations", 30000)),
                "sfmArgs": list(sfm_args)}

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
        # Layout follows the tool's own convention: sfm auto accepts a dataset
        # dir containing images/ and writes features/matches/sparse beside it,
        # so train --data-format colmap finds everything in one place.
        workspace = os.path.join(workdir, "workspace")
        images = os.path.join(workspace, "images")

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
            _run([binpath, "sfm", "auto", images, "-o", workspace,
                  *handle["sfmArgs"]], SFM_TIMEOUT,
                 os.path.join(workdir, "sfm.log"))
            sparse = os.path.join(workspace, "sparse", "0")
            if not (os.path.isdir(sparse) and os.listdir(sparse)):
                raise SpirulaError(
                    "SfM produced no connected sparse model (sparse/0 missing/empty). "
                    "The footage likely lacks overlapping views or stable features — "
                    "re-record per docs/capture-protocol.md. No poses invented."
                )
            # Coverage gate: refuse to train a fragment. The primary model must
            # explain at least half the extracted frames, else this is a capture
            # problem (dark/blank stretches, too-fast motion), not a training one.
            reg = registered_count(os.path.join(sparse, "images.bin"))
            floor = max(8, frames_b["count"] // 2)
            if reg >= 0 and reg < floor:
                raise SpirulaError(
                    f"COVERAGE_GAP: SfM registered only {reg}/{frames_b['count']} frames "
                    f"in the primary model (need {floor}). Likely causes: dark or blank "
                    "stretches, too-fast motion, or weak overlap. See the contact sheet "
                    "and docs/capture-protocol.md, then re-record the weak sections."
                )
            store.transition(job_id, "reconstructing", progress=50)
            _train_and_watch(binpath, workspace, handle["iterations"],
                             workdir, TRAIN_TIMEOUT)
            return finalize_job(job_id, workdir)
        except (SpirulaError, media.MediaError, OSError) as e:
            msg = str(e)[:500]
            code = "SPIRULA_FAILED"
            for prefix in ("SPIRULA_", "NO_", "COVERAGE_"):
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
