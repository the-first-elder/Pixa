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

Binary location: $WL_SPIRULA_BIN, else ~/.pixa/bin/spirula.
"""
from __future__ import annotations

import contextlib
import fcntl
import glob
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
from typing import Any

from .. import media, store

DEFAULT_BIN = os.path.expanduser("~/.pixa/bin/spirula")
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


def _tier(iterations: int) -> str:
    if iterations >= 30000:
        return "full"
    if iterations >= 15000:
        return "balanced"
    return "fast"


def _sfm_args(iterations: int) -> list[str]:
    """SfM profile by tier. Full spends more of the compute budget on the
    geometry everything else depends on; fast keeps SfM deliberately cheap."""
    tier = _tier(iterations)
    quality = {"fast": "medium", "balanced": "high", "full": "extreme"}[tier]
    overlap = {"fast": "8", "balanced": "12", "full": "14"}[tier]
    return ["--data-type", "video", "--pairs", "sequential", "--sequence", ".",
            "--quality", quality, "--overlap", overlap]


def _adaptive_fps(video: str, requested: float | None,
                  iterations: int) -> float | None:
    """Duration-aware frame sampling when the caller did not choose a rate.

    Short captures benefit from denser views (better registration and detail);
    long captures are bounded so SfM/training time stays sane. Explicit fps
    always wins. Probe failure falls back to the historical 2 fps policy.
    """
    if requested is not None:
        return requested
    try:
        duration = float(media.probe_video(video).get("duration") or 0)
    except Exception:
        return 2.0
    if duration <= 0:
        return 2.0
    if duration <= 75:
        return 3.0
    if duration <= 240:
        return 2.0
    if duration <= 900:
        return 1.5
    return 1.0


def _train_timeout(iterations: int) -> int:
    """Tiered wall-clock ceilings so a preview cannot monopolize the queue."""
    return {"fast": 45 * 60, "balanced": 2 * 60 * 60, "full": TRAIN_TIMEOUT}[
        _tier(iterations)]


def _quality_flags(iterations: int) -> list[str]:
    """Training quality flags by tier (mapped from iterations, the tier knob).
    Defaults (medium, 1M cap, no floater suppression) visibly underperform on
    indoor rooms; ultra+2M+mild suppression is measured-safe on 24GB M4.
    Progressive resolution settles coarse geometry before full-res detail;
    mild distraction robustness ignores people moving through the capture.
    The viewer is disabled: it added a fixed-port bottleneck and no value in
    a headless pipeline. The exact command is logged for reproducibility.

    A/B (2000 iters, same workspace, 2026-10-30): mild floater PSNR 29.62 /
    SSIM 0.9392 vs strong floater 28.17 / 0.9233 vs strong + depth/normal
    distortion regs (0.1/0.05) 20.59 / 0.9033. Solidity regs HURT at these
    weights — do not re-add without a full-length A/B proving otherwise."""
    tier = _tier(iterations)
    common = ["--floater-suppression", "mild",
              "--progressive-resolution", "1",
              "--disable-viewer", "1", "--keep-viewer-alive", "0"]
    if tier == "full":
        return ["--quality", "ultra", "--cap-max", "2000000",
                "--distraction-robustness", "mild", *common]
    if tier == "balanced":
        return ["--quality", "high", "--cap-max", "1500000",
                "--distraction-robustness", "mild", *common]
    return ["--quality", "high", "--cap-max", "1000000",
            "--train-resolution-divisor", "2", *common]


def _train_slot_count() -> int:
    try:
        return max(1, min(4, int(os.environ.get("WL_TRAIN_SLOTS", "1"))))
    except ValueError:
        return 1


def _acquire_train_slot(job_id: str, timeout: int):
    """Acquire one cross-process GPU training slot (FIFO among waiting jobs).

    Returns an open lock fd to hold for the whole train, or None when the job
    was cancelled while queued. flock is released by the OS if the worker dies,
    so a crash can never wedge the queue. WL_TRAIN_SLOTS may raise concurrency
    on larger GPUs; the M4 Pro default stays 1 (unified-memory bound)."""
    slots = _train_slot_count()
    lock_dir = os.path.join(store.storage_dir(), "train-slots")
    os.makedirs(lock_dir, exist_ok=True)
    fds = []
    try:
        for i in range(slots):
            fds.append(open(os.path.join(lock_dir, f"slot-{i}.lock"), "a+"))
        deadline = time.time() + timeout
        announced = False
        while True:
            try:
                current = store.get_job(job_id)
                if current["status"] == "failed":
                    return None
            except KeyError as e:
                raise SpirulaError(
                    "Job record disappeared while queued for the trainer.") from e
            jobs = store._load("jobs.json")
            candidates = [
                j for j in jobs.values()
                if j.get("id") == job_id or j.get("waitingForTrainer")
            ]
            candidates.sort(key=lambda j: (str(j.get("startedAt") or ""),
                                           str(j.get("id") or "")))
            eligible = {str(j.get("id")) for j in candidates[:slots]}
            if job_id in eligible:
                for fd in fds:
                    try:
                        fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except OSError:
                        continue
                    # Won a slot: detach it from the close-all cleanup below.
                    fds.remove(fd)
                    if job_id in jobs:
                        jobs[job_id].pop("waitingForTrainer", None)
                        jobs[job_id].pop("waitingSince", None)
                        store._save("jobs.json", jobs)
                    return fd
            if job_id in jobs and not jobs[job_id].get("waitingForTrainer"):
                jobs[job_id]["waitingForTrainer"] = True
                jobs[job_id]["waitingSince"] = store.now()
                store._save("jobs.json", jobs)
            if not announced:
                announced = True
            if time.time() > deadline:
                raise SpirulaError(
                    "TRAINING_BUSY: waited over the limit and no trainer slot "
                    "freed up. Retry later, or cancel a blocking job.")
            time.sleep(5)
    finally:
        for fd in fds:
            try:
                fd.close()
            except OSError:
                pass


def _train_and_watch(binpath: str, workspace: str, iterations: int,
                     workdir: str, timeout: int, job_id: str) -> str:
    """Train to completion, then STOP the process.

    `spirula train` intentionally stays alive after training ("Viewer still
    running -- press Ctrl-C to exit"). So: stream to train.log, watch for the
    "Training complete" marker, then terminate the whole process group.
    Returns the train.log path. Raises SpirulaError on timeout/failure text.

    GPU training slots are flock-guarded (WL_TRAIN_SLOTS, default 1): instead
    of failing when busy, WAIT in FIFO order — the job record carries
    waitingForTrainer so the UI can show queue position instead of an error.
    Extraction/SfM of other jobs proceed concurrently; only this section is
    slot-bound. The viewer is disabled, so the historical fixed-port
    collision no longer limits concurrency at all.
    """
    slot_fd = _acquire_train_slot(job_id, timeout)
    if slot_fd is None:
        return None
    log_path = os.path.join(workdir, "train.log")
    cmd = [binpath, "train", "--data", workspace, "--data-format", "colmap",
           "--num-iterations", str(iterations),
           *_quality_flags(iterations),
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
    # Stall detection: a healthy trainer writes progress to the log constantly.
    # Silence longer than STALL_TIMEOUT means hung (not slow) — kill it so the
    # queue never blocks behind a dead process. Tunable via WL_STALL_MINUTES.
    stall_limit = float(os.environ.get("WL_STALL_MINUTES", "20")) * 60
    last_size = -1
    last_growth = time.time()
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
            try:
                size = os.path.getsize(log_path)
            except OSError:
                size = last_size
            if size != last_size:
                last_size = size
                last_growth = time.time()
                # Trainer progress → job record (drives the live % + ETA in
                # the UI). Parsed from the trainer's own step/ETA lines; the
                # UI labels the ETA as a trainer estimate, not a promise.
                m = re.search(r"step\s+(\d+)/(\d+).*?ETA\s+(\d+):(\d+):(\d+)",
                              tail)
                if m:
                    step, total = int(m.group(1)), int(m.group(2))
                    eta_s = (int(m.group(3)) * 3600 + int(m.group(4)) * 60
                             + int(m.group(5)))
                    pct = 50 + round(40 * step / max(total, 1))
                    try:
                        store.update_progress(
                            job_id, pct,
                            {"step": step, "total": total,
                             "etaSeconds": eta_s, "source": "trainer-log"})
                    except OSError:
                        pass
            elif time.time() - last_growth > stall_limit:
                raise SpirulaError(
                    f"STALLED: trainer log silent for {int(stall_limit / 60)} min "
                    f"(hung, not slow) — stopped so queued jobs can proceed. See {log_path}."
                )
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
        try:
            slot_fd.close()
        except OSError:
            pass


def _repo_root() -> str:
    # spirula.py lives at <root>/services/reconstruction/worker/backends/ —
    # five dirnames up is the repo root (verified: scripts/ must exist there).
    root = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
    assert os.path.isdir(os.path.join(root, "scripts")), \
        f"repo root resolution broken: {root}"
    return root


def _convert_to_spz(asset_path: str, scene_id: str,
                    repo_root: str) -> str | None:
    """Convert the trained PLY to SPZ for delivery (measured 452MB -> 39MB).

    The PLY stays in the workdir as the archival/master artifact; the job
    record points at the SPZ the viewer actually downloads. Any failure
    keeps the PLY as the deliverable — conversion never fails a good train.
    """
    storage = store.storage_dir()
    dest_dir = os.path.join(storage, "assets", scene_id)
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "splat.spz")
    local_cli = os.path.join(repo_root, "node_modules", ".bin", "splat-transform")
    cmd = ([local_cli] if os.path.exists(local_cli)
           else ["npx", "-y", "@playcanvas/splat-transform"])
    try:
        p = subprocess.run(
            [*cmd, asset_path, "-N", "-w", dest],
            capture_output=True, text=True, timeout=900,
            cwd=repo_root, check=False)
        if p.returncode != 0 or not os.path.exists(dest):
            return None
        # Format check, not a size guess: SPZ files carry the NGSP magic.
        with open(dest, "rb") as f:
            if f.read(4) != b"NGSP":
                return None
        return dest
    except (subprocess.TimeoutExpired, OSError):
        return None


def _auto_finish(job_id: str, workdir: str, asset_path: str, sparse: str) -> list[str]:
    """Best-effort post-training finish: collision mesh + viewpoints + world
    leveling + coverage. These used to be manual operator steps; scenes
    without them render as a blob in a void with no navigation. Failures here
    only add warning notes — they never fail an otherwise good training."""
    notes: list[str] = []
    try:
        jobs = store._load("jobs.json")
        scene_id = (jobs.get(job_id) or {}).get("sceneId")
    except OSError:
        return ["finish skipped: job record unreadable"]
    if not scene_id:
        return ["finish skipped: no scene linked"]
    repo_root = _repo_root()
    storage = store.storage_dir()
    env = {**os.environ, "STORAGE_DIR": storage}

    def run_step(label: str, cmd: list[str], timeout: int) -> bool:
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                               cwd=repo_root, env=env, check=False)
            if p.returncode == 0:
                notes.append(f"{label}: ok")
                return True
            notes.append(f"{label}: failed ({(p.stderr or p.stdout or '')[:120]})")
            return False
        except subprocess.TimeoutExpired:
            notes.append(f"{label}: timed out")
            return False
        except OSError as e:
            notes.append(f"{label}: could not run ({e})")
            return False

    # Collision mesh for rooms-mode walking (viewer auto-discovers it).
    mesh_base = os.path.join(storage, "assets", scene_id, "mesh")
    os.makedirs(os.path.dirname(mesh_base), exist_ok=True)
    try:
        mesh_cmd = [binary(), "mesh", asset_path,
                    "--data", os.path.join(workdir, "workspace"),
                    "--data-format", "colmap",
                    "--format", "glb", "--output", mesh_base]
    except SpirulaError as e:
        # A missing binary must degrade the finish, never flip a trained
        # job to failed (binary() raises before run_step can catch it).
        notes.append(f"mesh: skipped ({e})")
        mesh_cmd = None
    if mesh_cmd is not None:
        run_step("mesh", mesh_cmd, 900)
    # Collision meshes come out at 15-50MB — too heavy for an invisible
    # walk proxy the viewer downloads. Simplify to ~8% in place; on any
    # failure the full mesh stands (rooms mode still works, just slower).
    mesh_glb = mesh_base + ".glb"
    if os.path.exists(mesh_glb):
        gt_local = os.path.join(repo_root, "node_modules", ".bin",
                                "gltf-transform")
        gt_cmd = ([gt_local] if os.path.exists(gt_local)
                  else ["npx", "-y", "@gltf-transform/cli"])
        slim = mesh_base + ".slim.glb"
        before = os.path.getsize(mesh_glb)
        slim_ok = False
        try:
            p = subprocess.run(
                [*gt_cmd, "simplify", "--ratio", "0.08", "--error", "0.02",
                 mesh_glb, slim], capture_output=True, text=True, timeout=600,
                cwd=repo_root, env=env, check=False)
            slim_ok = (p.returncode == 0 and os.path.exists(slim)
                       and os.path.getsize(slim) > 1024)
            detail = "" if slim_ok else f" ({(p.stderr or p.stdout or '')[:100]})"
        except (subprocess.TimeoutExpired, OSError) as e:
            detail = f" ({e})"
        if slim_ok:
            os.replace(slim, mesh_glb)
            after = os.path.getsize(mesh_glb)
            notes.append(f"mesh-simplify: ok ({before // 1024}KB -> "
                         f"{after // 1024}KB)")
        else:
            notes.append(f"mesh-simplify: failed, kept full mesh{detail}")
            if os.path.exists(slim):
                os.remove(slim)
    # Spatial indexing: SAM video tracks -> per-instance entities ->
    # registration/viewpoints/level/coverage (track-scene runs those steps
    # itself). Without it the assistant is blind on a rendered scene.
    # Requires META_API_KEY (spend is ~$0.04/scene, accounted in the sidecar);
    # absent key -> navigation-only finish below, never a hard failure.
    indexed = False
    if os.environ.get("META_API_KEY"):
        indexed = run_step(
            "index", ["npx", "-y", "tsx", "scripts/track-scene.mts",
                      "--scene", scene_id, "--yes"], 1800)
    else:
        notes.append("index: skipped (META_API_KEY not configured)")
    if not indexed:
        # Navigation + leveling + coverage (repo scripts).
        run_step("viewpoints", ["npx", "-y", "tsx", "scripts/derive-viewpoints.mts",
                                 "--scene", scene_id], 300)
        run_step("level-world", [sys.executable, "scripts/level-world.py",
                                 "--scene", scene_id], 300)
        run_step("coverage", ["npx", "-y", "tsx", "scripts/coverage.mts",
                               "--scene", scene_id], 300)
    return notes


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
    scene_id = (jobs.get(job_id) or {}).get("sceneId")
    # Deliver SPZ by default (measured 452MB PLY -> 39MB SPZ, seconds to
    # convert); the PLY remains the master in the workdir. Fall back to PLY
    # on any conversion failure — a downloadable scene beats a perfect one.
    deliver_path, deliver_format = asset_path, "ply"
    if scene_id:
        converted = _convert_to_spz(asset_path, scene_id, _repo_root())
        if converted:
            deliver_path, deliver_format = converted, "spz"
    jobs[job_id]["asset"] = {
        "assetPath": deliver_path,
        "format": deliver_format,
        "posesPath": sparse if os.path.isdir(sparse) else None,
        "posesFormat": "colmap-sparse",
    }
    jobs[job_id].pop("detail", None)  # live ETA is meaningless once ready
    frames_b = len([f for f in os.listdir(images_dir) if f.endswith(".jpg")]) if os.path.isdir(images_dir) else None
    reg = registered_count(os.path.join(sparse, "images.bin")) \
        if os.path.isdir(sparse) else -1
    jobs[job_id]["diagnostics"] = {
        "cameraPosesEstimated": True,
        "framesRegistered": reg if reg >= 0 else None,
        "framesRejected": (max(frames_b - reg, 0)
                           if reg >= 0 and frames_b is not None else None),
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
    # Mark ready BEFORE the finish steps: the scene is viewable the moment
    # the asset verifies. level-world/coverage/viewpoints resolve the *ready*
    # job — running them first guaranteed "No ready job" failures on every
    # run (measured on scene_0f8f6775). Mesh/viewpoints land minutes later;
    # the viewer degrades gracefully until they exist.
    store.transition(job_id, "ready", progress=100)
    finish_notes = _auto_finish(job_id, workdir, asset_path, sparse)
    jobs = store._load("jobs.json")
    if job_id in jobs:
        notes = (jobs[job_id].get("diagnostics") or {}).get("notes", [])
        notes.extend(finish_notes)
        jobs[job_id]["diagnostics"] = {
            **(jobs[job_id].get("diagnostics") or {}),
            "notes": notes,
        }
        store._save("jobs.json", jobs)
        return jobs[job_id]
    return store.get_job(job_id)


class SpirulaBackend:
    name = "spirula"

    def submit(self, job: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        binary()  # fail fast with install instructions
        video = ctx["video"]
        if not os.path.exists(video):
            raise SpirulaError(f"Video not found: {video}")
        workdir = os.path.join(store.storage_dir(), "work", job["id"], "spirula")
        os.makedirs(workdir, exist_ok=True)
        iterations = int(ctx.get("iterations", 30000))
        # Video frames need sequential matching (neighbours + loop closure),
        # not the default individual-photo/exhaustive strategy. Tier profiles
        # spend the SfM budget where it matters; override via ctx["sfmArgs"].
        sfm_args = ctx.get("sfmArgs") or _sfm_args(iterations)
        fps = ctx.get("fps")
        if fps is not None:
            fps = float(fps)
            if not (0.25 <= fps <= 10):
                raise SpirulaError(f"extract fps {fps} out of sane range 0.25..10")
        else:
            fps = _adaptive_fps(video, None, iterations)
        return {"workdir": workdir, "video": video,
                "iterations": iterations,
                "allowPartial": bool(ctx.get("allowPartial", False)),
                "fps": fps,
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
            frames_b = media.extract_frames(handle["video"], images, "B",
                                            handle.get("fps"))
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
                                       workdir, _train_timeout(handle["iterations"]), job_id)
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
            for prefix in ("SPIRULA_", "NO_", "COVERAGE_", "TRAINING_", "STALL_"):
                if msg.startswith(prefix):
                    code = store.error_code(msg, "SPIRULA_FAILED")
                    break
            mark("FAILED", msg)
            try:
                _jobs = store._load("jobs.json")
                if job_id in _jobs:
                    _jobs[job_id].pop("detail", None)
                    store._save("jobs.json", _jobs)
            except OSError:
                pass
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
