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


def probe_video(path: str) -> dict[str, Any]:
    """Read-only inspection. Writes nothing. Raises MediaError on invalid input."""
    if not os.path.exists(path):
        raise MediaError(f"File not found: {path}")
    ext = os.path.splitext(path)[1].lower()
    if ext not in (".mp4", ".mov"):
        raise MediaError(f"Unsupported format {ext or '(none)'}: MVP accepts .mp4/.mov")
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
    return {
        "path": os.path.abspath(path),
        "width": int(s["width"]),
        "height": int(s["height"]),
        "fps": round(fps, 2),
        "duration": round(duration, 2),
        "codec": s.get("codec_name"),
        "sizeBytes": size,
        "contentType": "video/mp4" if ext == ".mp4" else "video/quicktime",
    }


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


def extract_frames(video: str, out_dir: str, pipeline: str) -> dict[str, Any]:
    """Extract frames with ffmpeg. Returns a manifest of what was written."""
    if pipeline == "A":
        vf = "fps=1,scale=1280:-1"
        cap_note = "analysis frames (1 fps, capped at 120)"
    elif pipeline == "B":
        # Overlap-preserving: 2 fps, cap width 1600. Never sparse-sampled.
        vf = "fps=2,scale=1600:-2"
        cap_note = "reconstruction frames (2 fps, width ≤1600)"
    else:
        raise MediaError("pipeline must be 'A' or 'B'")
    os.makedirs(out_dir, exist_ok=True)
    pattern = os.path.join(out_dir, "%04d.jpg")
    p = _run(["ffmpeg", "-y", "-v", "error", "-i", video, "-vf", vf, pattern])
    if p.returncode != 0:
        raise MediaError(f"ffmpeg extraction failed: {p.stderr.strip()[:300]}")
    files = sorted(f for f in os.listdir(out_dir) if f.endswith(".jpg"))
    if pipeline == "A":
        files = files[:120]
    manifest = {
        "pipeline": pipeline,
        "policy": cap_note,
        "frames": files,
        "count": len(files),
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return manifest
