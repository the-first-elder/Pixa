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
import socket
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


def component_frames(workspace: str) -> dict[int, list[int]]:
    """Registered B-frame numbers per sparse model. {} when unparseable."""
    import glob as _glob
    import re as _re
    import struct as _struct
    out: dict[int, list[int]] = {}
    for d in sorted(_glob.glob(os.path.join(workspace, "sparse", "*"))):
        try:
            idx = int(os.path.basename(d))
        except ValueError:
            continue
        p = os.path.join(d, "images.bin")
        if not os.path.exists(p):
            continue
        try:
            data = open(p, "rb").read()
            off = 8
            n = struct.unpack("<Q", data[:8])[0]
            frames: list[int] = []
            for _ in range(n):
                off += 4 + 32 + 24 + 4
                s = b""
                while data[off:off + 1] != b"\x00":
                    s += data[off:off + 1]
                    off += 1
                off += 1
                m = _re.match(rb"(\d+)\.jpg$", s)
                if m:
                    frames.append(int(m.group(1)))
                npts = struct.unpack("<Q", data[off:off + 8])[0]
                off += 8 + npts * 24
            out[idx] = sorted(frames)
        except (OSError, struct.error, IndexError):
            continue
    return out


def ranges_of(nums: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    s = p = -1
    for v in sorted(nums):
        if v != p + 1:
            if s >= 0:
                out.append((s, p))
            s = v
        p = v
    if s >= 0:
        out.append((s, p))
    return out


def coverage_report(workspace: str, total_frames: int, fps: float = 2.0) -> str:
    """Human-readable coverage diagnosis from sparse models (for re-record guidance)."""
    comps = component_frames(workspace)
    if not comps:
        return "SfM registered no frames. The footage likely has no overlapping views."
    covered = sorted({f for fs in comps.values() for f in fs})
    gaps = [f for f in range(1, total_frames + 1) if f not in set(covered)]
    def fmt(rs: list[tuple[int, int]]) -> str:
        return ", ".join(f"{a / fps:.0f}-{b / fps:.0f}s" for a, b in rs) or "none"
    best = max(comps.items(), key=lambda kv: len(kv[1]))
    lines = [
        f"SfM connected {len(best[1])}/{total_frames} frames in the largest model ({len(comps)} components).",
        f"Registered stretches: {fmt(ranges_of(covered))}.",
        f"Missing stretches to re-record: {fmt(ranges_of(gaps))}.",
    ]
    return " ".join(lines)


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


SPIRULA_VIEWER_PORT = 7007


def _viewer_port_busy() -> bool:
    """Spirula train binds one fixed viewer port — concurrent trainings collide.
    Ground truth is the port itself, so externally started trainers count too."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(2)
        return s.connect_ex(("127.0.0.1", SPIRULA_VIEWER_PORT)) == 0


def _train_and_watch(binpath: str, workspace: str, iterations: int,
                     workdir: str, timeout: int, job_id: str) -> str:
    """Train to completion, then STOP the process.

    `spirula train` intentionally stays alive after training ("Viewer still
    running -- press Ctrl-C to exit"). So: stream to train.log, watch for the
    "Training complete" marker, then terminate the whole process group.
    Returns the train.log path. Raises SpirulaError on timeout/failure text.

    One trainer per machine (fixed viewer port): instead of failing when the
    slot is busy, WAIT in line — the job record carries waitingForTrainer so
    the UI can show queue position instead of an error.
    """
    waited = 0
    wait_logged = False
    while _viewer_port_busy():
        # A cancel while queued must stop the wait — not train a dead job.
        try:
            current = store.get_job(job_id)
            if current["status"] == "failed":
                return None
        except KeyError:
            raise SpirulaError("Job record disappeared while queued for the trainer.")
        if waited == 0 or waited % 10 == 0:
        if waited == 0 or waited % 10 == 0:
            jobs = store._load("jobs.json")
            if job_id in jobs:
                jobs[job_id]["waitingForTrainer"] = True
                jobs[job_id]["waitingSince"] = store.now()
                store._save("jobs.json", jobs)
        if not wait_logged:
            with open(os.path.join(workdir, "train.log"), "w", encoding="utf-8") as log:
                log.write("Waiting for the trainer slot (another job is training)...\n")
            wait_logged = True
        time.sleep(20)
        waited += 1
        if waited * 20 > timeout:
            raise SpirulaError(
                "TRAINING_BUSY: waited over the limit and the trainer slot never "
                "freed up. Retry later, or cancel the blocking job."
            )
    jobs = store._load("jobs.json")
    if job_id in jobs:
        jobs[job_id].pop("waitingForTrainer", None)
        jobs[job_id].pop("waitingSince", None)
        store._save("jobs.json", jobs)
    log_path = os.path.join(workdir, "train.log")
    cmd = [binpath, "train", "--data", workspace, "--data-format", "colmap",
           "--num-iterations", str(iterations),
           "--output-dir-prefix", os.path.join(workdir, "outputs")]
    with open(log_path, "w", encoding="utf-8") as log:
        log.write(f"$ {' '.join(cmd)}\n")
        log.flush()
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True)
    # Record the trainer so the operator can cancel it (cancel = SIGTERM the group).
    try:
        jobs = store._load("jobs.json")
        if job_id in jobs:
            jobs[job_id]["trainPid"] = proc.pid
            try:
                jobs[job_id]["trainPgid"] = os.getpgid(proc.pid)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            store._save("jobs.json", jobs)
    except OSError:
        pass
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
        try:
            jobs = store._load("jobs.json")
            if job_id in jobs:
                jobs[job_id].pop("trainPid", None)
                jobs[job_id].pop("trainPgid", None)
                jobs[job_id].pop("waitingForTrainer", None)
                jobs[job_id].pop("waitingSince", None)
                store._save("jobs.json", jobs)
        except OSError:
            pass


def finalize_job(job_id: str, workdir: str, sparse_root: str | None = None,
                 partial: bool = False) -> dict[str, Any]:
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
    sparse = (os.path.join(sparse_root, "sparse", "0") if sparse_root
              else os.path.join(workdir, "workspace", "sparse", "0"))
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
            ("PARTIAL PREVIEW: trained on the largest connected component only. "
             if partial else "") +
            "Poses from Spirula SfM (COLMAP-format sparse). "
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
                "allowPartial": bool(ctx.get("allowPartial", False)),
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
            try:
                _run([binpath, "sfm", "auto", images, "-o", workspace,
                      *handle["sfmArgs"]], SFM_TIMEOUT,
                     os.path.join(workdir, "sfm.log"))
            except SpirulaError as e:
                if "exit 3" not in str(e):
                    raise
                # Exit 3 = PARTIAL: SfM mapped what it could. Diagnose coverage
                # precisely instead of dumping raw log tail.
                raise SpirulaError(
                    "COVERAGE_GAP: " + coverage_report(workspace, frames_b["count"])
                    + " Re-record the missing stretches (docs/capture-protocol.md), "
                    "or re-run with --allow-partial for a labeled partial preview."
                ) from e
            train_workspace = workspace
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
                if not handle.get("allowPartial"):
                    raise SpirulaError(
                        "COVERAGE_GAP: " + coverage_report(workspace, frames_b["count"])
                        + " Re-record the missing stretches (docs/capture-protocol.md), "
                        "or re-run with --allow-partial for a labeled partial preview."
                    )
                # Opt-in partial: train the largest component, honestly labeled.
                comps = component_frames(workspace)
                best_idx = max(comps.items(), key=lambda kv: len(kv[1]))[0]
                partial = os.path.join(workdir, "partial")
                os.makedirs(os.path.join(partial, "images"), exist_ok=True)
                for f in os.listdir(images):
                    src, dst = os.path.join(images, f), os.path.join(partial, "images", f)
                    if not os.path.exists(dst):
                        os.symlink(src, dst)
                shutil.copytree(os.path.join(workspace, "sparse", str(best_idx)),
                                  os.path.join(partial, "sparse", "0"))
                train_workspace = partial
            store.transition(job_id, "reconstructing", progress=50)
            watched = _train_and_watch(binpath, train_workspace, handle["iterations"],
                                       workdir, TRAIN_TIMEOUT, job_id)
            if watched is None:
                return store.get_job(job_id)  # cancelled while queued
            return finalize_job(job_id, workdir, train_workspace if train_workspace != workspace else None,
                                partial=train_workspace != workspace)
        except (SpirulaError, media.MediaError, OSError) as e:
            # A cancel that landed mid-flight already set the terminal state —
            # never overwrite CANCELLED with a derivative error.
            try:
                if store.get_job(job_id)["status"] == "failed":
                    return store.get_job(job_id)
            except KeyError:
                pass
            msg = str(e)[:500]
            code = "SPIRULA_FAILED"
            for prefix in ("SPIRULA_", "NO_", "COVERAGE_", "TRAINING_"):
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
