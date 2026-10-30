#!/usr/bin/env python3
"""Regression tests for the 3D generation/perf layer (offline, no GPU train).

Covers: tier profiles, adaptive fps, portrait frame bounds, train-slot
locking, SPZ conversion + finalize delivery, missing-binary resilience.
Run: python3 scripts/test-worker-perf.py   (needs ffmpeg + npm ci for SPZ)
"""
import glob
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "services", "reconstruction"))

STORE = tempfile.mkdtemp(prefix="wl-worker-perf-")
os.environ["STORAGE_DIR"] = STORE
os.environ["WL_TRAIN_SLOTS"] = "1"

from worker import media, store  # noqa: E402
from worker.backends import spirula  # noqa: E402

PASS, FAIL = 0, []


def ok(name):
    global PASS
    PASS += 1
    print(f"PASS: {name}")


def bad(name, detail=""):
    FAIL.append(name)
    print(f"FAIL: {name} {detail}")


def make_video(path, size, seconds=1, fps=10):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", f"testsrc=size={size}:rate={fps}:duration={seconds}",
         "-pix_fmt", "yuv420p", "-c:v", "libx264", path],
        check=True)


def make_ply(path, n=64):
    """Minimal valid Gaussian PLY (PlayCanvas column layout)."""
    props = ["x", "y", "z", "scale_0", "scale_1", "scale_2",
             "rot_0", "rot_1", "rot_2", "rot_3", "opacity",
             "f_dc_0", "f_dc_1", "f_dc_2"]
    header = "ply\nformat binary_little_endian 1.0\n"
    header += f"element vertex {n}\n"
    header += "".join(f"property float {p}\n" for p in props)
    header += "end_header\n"
    with open(path, "wb") as f:
        f.write(header.encode())
        for i in range(n):
            vals = [i * 0.01, 0.0, 0.0, -2.0, -2.0, -2.0,
                    1.0, 0.0, 0.0, 0.0, 0.9, 0.1, 0.2, 0.3]
            f.write(struct.pack("<14f", *vals))


def main():
    # 1. tier profiles
    try:
        assert spirula._tier(7000) == "fast"
        assert spirula._tier(15000) == "balanced"
        assert spirula._tier(30000) == "full"
        assert "extreme" in spirula._sfm_args(30000)
        assert "medium" in spirula._sfm_args(7000)
        for it in (7000, 15000, 30000):
            flags = spirula._quality_flags(it)
            assert "--disable-viewer" in flags and "--progressive-resolution" in flags
            # A/B-proven harmful at 0.1/0.05 (PSNR 20.6 vs 29.6): keep out.
            assert "--depth-distortion-reg" not in flags
            assert "--normal-distortion-reg" not in flags
            assert "strong" not in flags  # floater stays mild (28.2 vs 29.6)
        assert spirula._train_timeout(7000) < spirula._train_timeout(15000) < spirula._train_timeout(30000)
        ok("tier profiles (sfm/train/timeout/viewer-off)")
    except AssertionError as e:
        bad("tier profiles", str(e))

    # 2. adaptive fps + explicit override wins
    try:
        vid = os.path.join(STORE, "clip.mp4")
        make_video(vid, "320x240", seconds=2)
        assert spirula._adaptive_fps(vid, None, 30000) == 3.0  # short clip
        assert spirula._adaptive_fps(vid, 2.0, 30000) == 2.0   # explicit
        assert spirula._adaptive_fps("/nonexistent.mp4", None, 30000) == 2.0
        ok("adaptive fps (short=3, explicit wins, fallback=2)")
    except AssertionError as e:
        bad("adaptive fps", str(e))

    # 3. portrait frames bound BOTH dimensions
    try:
        pv = os.path.join(STORE, "portrait.mp4")
        make_video(pv, "2160x3840", seconds=1)
        out = os.path.join(STORE, "frames")
        m = media.extract_frames(pv, out, "B")
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "json",
             os.path.join(out, m["frames"][0])],
            capture_output=True, text=True, check=True)
        wh = json.loads(probe.stdout)["streams"][0]
        assert max(wh["width"], wh["height"]) <= 2048, wh
        ok(f"portrait frame bounded ({wh['width']}x{wh['height']})")
    except AssertionError as e:
        bad("portrait bounds", str(e))

    # 4. train slot lock: acquire, blocked second, release, re-acquire
    try:
        import fcntl
        store._save("jobs.json", {})
        scene = store.create_scene("slot", {})
        job = store.create_job(scene["id"], "reconstruction")
        store.transition(job["id"], "reconstructing", progress=50)
        fd = spirula._acquire_train_slot(job["id"], 5)
        assert fd is not None
        other = open(os.path.join(STORE, "train-slots", "slot-0.lock"), "a+")
        try:
            fcntl.flock(other.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            raise AssertionError("second lock acquired while held")
        except OSError:
            pass
        fd.close()
        other.close()
        fd2 = spirula._acquire_train_slot(job["id"], 5)
        assert fd2 is not None
        fd2.close()
        ok("train slot lock (hold/block/release/re-acquire)")
    except AssertionError as e:
        bad("train slot lock", str(e))

    # 5. finalize delivers SPZ + real diagnostics; missing binary cannot
    #    flip the finished job to failed (mesh step must degrade, not raise)
    try:
        store._save("jobs.json", {})
        scene = store.create_scene("fin", {})
        job = store.create_job(scene["id"], "reconstruction")
        store.transition(job["id"], "reconstructing", progress=50)
        workdir = os.path.join(STORE, "work", job["id"], "spirula")
        outputs = os.path.join(workdir, "outputs", "run1")
        os.makedirs(outputs, exist_ok=True)
        os.makedirs(os.path.join(workdir, "workspace", "images"), exist_ok=True)
        make_ply(os.path.join(outputs, "splat.ply"))
        done = spirula.finalize_job(job["id"], workdir)
        assert done["status"] == "ready", done["status"]
        assert done["asset"]["format"] == "spz", done["asset"]
        assert os.path.getsize(done["asset"]["assetPath"]) > 0
        notes = " ".join(done["diagnostics"]["notes"])
        assert "mesh" in notes  # attempted or explicitly skipped, never fatal
        ok("finalize -> SPZ delivery, ready survives finish steps")
    except AssertionError as e:
        bad("finalize SPZ", str(e))
    except Exception as e:  # noqa: BLE001
        bad("finalize SPZ", f"{type(e).__name__}: {str(e)[:150]}")

    print(f"RESULT: {PASS} passed, {len(FAIL)} failed")
    shutil.rmtree(STORE, ignore_errors=True)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
