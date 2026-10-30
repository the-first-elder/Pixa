"""Media probing + frame extraction. Real FFmpeg. Two separate pipelines (PRD §6.5)."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from typing import Any


class MediaError(RuntimeError):
    pass


def _run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError as e:
        raise MediaError(f"Required binary missing: {cmd[0]}. Install FFmpeg.") from e


def _has_audio(path: str) -> bool:
    """True when the file carries at least one audio stream (best effort)."""
    p = _run(["ffprobe", "-v", "error", "-select_streams", "a",
              "-show_entries", "stream=index", "-of", "csv", path])
    return p.returncode == 0 and bool(p.stdout.strip())


def join_videos(inputs: list[str], out_path: str) -> dict[str, Any]:
    """Concatenate capture passes into one video, in order. Stream-copy when
    the passes share codecs (same recorder: no generation loss, seconds);
    otherwise ONE normalized re-encode: all passes scaled/padded to the
    first pass's dimensions and fps (mixed orientations/resolutions merge
    instead of failing), audio kept only when some pass actually has it
    (browser captures often ship video-only — `-c:a aac` with no audio
    stream aborts the encode). Raises MediaError on failure. The joined
    file is probed before return."""
    if len(inputs) < 2:
        raise MediaError("Join needs at least 2 passes")
    probed = []
    for p in inputs:
        if not os.path.exists(p):
            raise MediaError(f"Pass file missing: {p}")
        probed.append(probe_video(p))  # validate each pass first
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    list_path = out_path + ".concat.txt"
    with open(list_path, "w", encoding="utf-8") as f:
        for p in inputs:
            # Concat demuxer: single-quoted paths, escape embedded quotes.
            f.write(f"file '{os.path.abspath(p).replace(chr(39), chr(39) + chr(92) + chr(39))}'\n")
    # Stream-copy only when every pass matches (codec, size, fps) — a
    # "successful" copy of mismatched passes yields mid-stream resolution
    # switches that poison downstream frame extraction. Anything else goes
    # straight to the normalized re-encode.
    first = (probed[0].get("codec"), probed[0]["width"], probed[0]["height"],
             probed[0]["fps"])
    uniform = all((q.get("codec"), q["width"], q["height"], q["fps"]) == first
                   for q in probed)
    try:
        p = _run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                  "-i", list_path, "-c", "copy", out_path]) if uniform else None
        reencoded = False
        if not uniform or (p is not None and p.returncode != 0):
            base = probed[0]
            w, h, fps = base["width"], base["height"], base["fps"] or 30.0
            vf = (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                  f"scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,"
                  f"fps={fps}")
            audio_args: list[str] = ["-c:a", "aac"] if any(
                _has_audio(i) for i in inputs) else ["-an"]
            p = _run(["ffmpeg", "-y", "-v", "error", "-f", "concat",
                      "-safe", "0", "-i", list_path, "-vf", vf,
                      "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
                      *audio_args, out_path])
            reencoded = True
        if p.returncode != 0:
            raise MediaError(f"ffmpeg join failed: {p.stderr.strip()[:300]}")
        meta = probe_video(out_path)
        meta["passes"] = len(inputs)
        meta["reencoded"] = reencoded
        return meta
    finally:
        try:
            os.remove(list_path)
        except OSError:
            pass


def probe_video(path: str, ext_hint: str | None = None) -> dict[str, Any]:
    """Read-only inspection. Writes nothing. Raises MediaError on invalid input."""
    if not os.path.exists(path):
        raise MediaError(f"File not found: {path}")
    ext = (ext_hint or os.path.splitext(path)[1]).lower()
    if ext not in (".mp4", ".mov", ".webm"):
        raise MediaError(f"Unsupported format {ext or '(none)'}: accepts .mp4/.mov/.webm")
    size = os.path.getsize(path)
    max_bytes = int(os.environ.get("MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))
    if size > max_bytes:
        raise MediaError(f"File too large: {size} bytes (limit {max_bytes})")

    p = _run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate,codec_name,duration",
        "-show_entries", "format=duration",
        "-of", "json", path,
    ])
    if p.returncode != 0:
        raise MediaError(f"ffprobe failed: {p.stderr.strip()[:300]}")
    info = json.loads(p.stdout or "{}")
    streams = info.get("streams", [])
    if not streams:
        raise MediaError("No video stream found")
    s = streams[0]
    # avg_frame_rate is "num/den"
    parts = s.get("avg_frame_rate", "30/1").split("/")
    fps = float(parts[0]) / float(parts[1]) if len(parts) == 2 and float(parts[1]) else 0.0
    duration = float(info.get("format", {}).get("duration") or s.get("duration") or 0.0)
    width, height = int(s["width"]), int(s["height"])
    # Resolution honesty: sub-HD sources cap reconstruction sharpness no
    # matter the settings (measured: all current footage is 478p). Warn, don't
    # block — the pipeline squeezes the most from what's there.
    quality_warning = None
    if max(width, height) < 720:
        quality_warning = (
            f"Low source resolution ({width}x{height}): fine detail cannot be "
            "reconstructed beyond what these pixels hold. For sharper results, "
            "upload the original camera recording (1080p+) instead of a "
            "compressed share."
        )
    elif max(width, height) < 1080:
        quality_warning = (
            f"Sub-HD source ({width}x{height}): usable, but original 1080p+ "
            "footage would reconstruct visibly sharper."
        )
    return {
        "path": os.path.abspath(path),
        "width": width,
        "height": height,
        "fps": round(fps, 2),
        "duration": round(duration, 2),
        "codec": s.get("codec_name"),
        "sizeBytes": size,
        "qualityWarning": quality_warning,
        "contentType": {"mp4": "video/mp4", ".mov": "video/quicktime"}.get(ext, "video/webm"),
    }


def _laplacian_variance(path: str) -> float:
    """Sharpness score via variance of Laplacian (higher = sharper)."""
    from PIL import Image
    import numpy as np
    with Image.open(path) as img:
        g = img.convert("L")
        g.thumbnail((320, 320))
        a = np.asarray(g, dtype=np.float32)
    lap = (4 * a[1:-1, 1:-1] - a[:-2, 1:-1] - a[2:, 1:-1]
           - a[1:-1, :-2] - a[1:-1, 2:])
    return float(lap.var())


def _filter_blurry(out_dir: str, files: list[str]) -> list[str]:
    """Delete severely blurred frames. Returns dropped filenames."""
    import statistics
    if len(files) < 12:
        return []
    scores = [(f, _laplacian_variance(os.path.join(out_dir, f))) for f in files]
    median = statistics.median(s for _, s in scores)
    threshold = median * 0.35
    dropped: list[str] = []
    prev_dropped = False
    for i, (f, s) in enumerate(scores):
        if i == 0 or i == len(scores) - 1:
            prev_dropped = False
            continue  # keep anchors
        if s < threshold and not prev_dropped and (len(files) - len(dropped) > 8):
            os.remove(os.path.join(out_dir, f))
            dropped.append(f)
            prev_dropped = True
        else:
            prev_dropped = False
    return dropped


def checksum(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def estimate_frames(duration: float) -> dict[str, Any]:
    """Frame-count estimates for both pipelines. Overlap warning, not a verdict."""
    a = min(int(duration * 1), 120)  # Pipeline A: 1 fps, cap 120
    b = int(duration * 2)  # Pipeline B: 2 fps, overlap-preserving
    return {
        "pipelineA_analysis": a,
        "pipelineB_reconstruction": b,
        "overlapWarning": (
            "Short and/or still recording: reconstruction needs overlapping "
            "views from a moving camera. See docs/capture-protocol.md."
            if duration < 15
            else None
        ),
    }


def extract_frames(video: str, out_dir: str, pipeline: str, fps_override: float | None = None) -> dict[str, Any]:
    """Extract frames with ffmpeg. Returns a manifest of what was written."""
    if pipeline == "A":
        vf = "fps=1,scale=w='if(gt(iw,1280),1280,iw)':h='-2'"
        cap_note = "analysis frames (1 fps, width ≤1280, never upscaled, capped at 120)"
    elif pipeline == "B":
        fps = fps_override or 2.0
        # Bound BOTH dimensions. A width-only cap turns 2160x3840 portrait
        # into 2048x3640 — gigabytes of interpolated-era pixels that slow
        # SfM/training without adding capture information. Downscale-only:
        # smaller sources stay at native resolution (measured best quality).
        vf = (
            f"fps={fps},"
            "scale=w='min(iw,2048)':h='min(ih,2048)'"
            ":force_original_aspect_ratio=decrease:force_divisible_by=2"
        )
        cap_note = f"reconstruction frames ({fps} fps, max dimension ≤2048, never upscaled)"
    else:
        raise MediaError("pipeline must be 'A' or 'B'")
    os.makedirs(out_dir, exist_ok=True)
    pattern = os.path.join(out_dir, "%04d.jpg")
    # -q:v 2: high-quality JPEG. The ffmpeg default (~q5) discards ~40% of
    # detail (measured 25KB vs 42KB on identical 478p frames) — detail the
    # reconstruction can never recover. Verified 2026-10-28.
    p = _run(["ffmpeg", "-y", "-v", "error", "-i", video, "-vf", vf, "-q:v", "2", pattern])
    if p.returncode != 0:
        raise MediaError(f"ffmpeg extraction failed: {p.stderr.strip()[:300]}")
    files = sorted(f for f in os.listdir(out_dir) if f.endswith(".jpg"))
    dropped: list[str] = []
    if pipeline == "B" and os.environ.get("WL_NO_SHARPNESS_FILTER") != "1":
        # Drop severely blurred frames (motion smear poisons both SfM matching
        # and splat sharpness). Conservative: below 35% of median sharpness,
        # never two adjacent (preserve sequence continuity), never first/last
        # (loop-closure anchors), never below 8 frames. Original numbering is
        # kept (gaps OK — COLMAP + our 2N-1 mapping tolerate missing files).
        try:
            dropped = _filter_blurry(out_dir, files)
            files = [f for f in files if f not in set(dropped)]
        except Exception as e:
            # Filtering must never break extraction; log and keep everything.
            dropped = [f"filter-skipped: {e}"]
    if pipeline == "A":
        files = files[:120]
    manifest = {
        "pipeline": pipeline,
        "policy": cap_note,
        "frames": files,
        "count": len(files),
        "droppedBlurry": dropped,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return manifest
