"""Recording analysis + segment manifests (Phase 2).

Best-effort segmentation: scene cuts suggest boundaries, but a cut is NOT
proof of a room change (a turn toward a window looks like a cut; a doorway
pass may not). Boundaries carry confidence + origin (auto/user) and the UI
lets users merge/split before expensive reconstruction.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from typing import Any

from . import media


class AnalysisError(RuntimeError):
    pass


def detect_cuts(video: str, threshold: float = 0.35) -> list[float]:
    """Frame timestamps where ffmpeg's scene detector fires. Best-effort only."""
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", video,
         "-vf", f"select='gt(scene,{threshold})',showinfo",
         "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    cuts: list[float] = []
    for line in (p.stderr or "").splitlines():
        m = re.search(r"pts_time:([0-9.]+)", line)
        if m:
            cuts.append(float(m.group(1)))
    return sorted(set(cuts))


def brightness_summary(video: str) -> dict[str, Any]:
    """Mean/min/max luma via signalstats. Cheap global exposure signal."""
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", video,
         "-vf", "signalstats,metadata=print:file=-:direct=1",
         "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    vals = [float(m.group(1)) for m in re.finditer(r"YAVG=([0-9.]+)", p.stdout or "")]
    if not vals:
        return {"samples": 0}
    vals.sort()
    return {
        "samples": len(vals),
        "min": round(vals[0], 1),
        "p5": round(vals[int(len(vals) * 0.05)], 1),
        "mean": round(sum(vals) / len(vals), 1),
        "max": round(vals[-1], 1),
    }


def propose_segments(duration: float, cuts: list[float],
                      max_seg: float = 150.0, min_seg: float = 25.0,
                      overlap: float = 2.0) -> list[dict[str, Any]]:
    """Split on cuts; merge sub-min ranges; split super-max ranges at
    midpoints; clamp with boundary overlap. All heuristic — marked auto."""
    bounds = [0.0] + [c for c in cuts if 0 < c < duration] + [duration]
    raw = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1) if bounds[i + 1] - bounds[i] > 1.0]
    # Merge short ranges forward.
    merged: list[list[float]] = []
    for s, e in raw:
        if merged and (e - merged[-1][0]) < min_seg and (s - merged[-1][0]) < max_seg:
            merged[-1][1] = e
        elif e - s < min_seg and merged:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    # Split long ranges at midpoints.
    final: list[list[float]] = []
    for s, e in merged:
        while e - s > max_seg:
            final.append([s, s + max_seg])
            s += max_seg
        final.append([s, e])
    segs = []
    for i, (s, e) in enumerate(final):
        segs.append({
            "id": f"seg_{i + 1:02d}",
            "start": round(max(0.0, s - (overlap if i > 0 else 0.0)), 2),
            "end": round(min(duration, e + (overlap if i < len(final) - 1 else 0.0)), 2),
            "origin": "auto",
            "boundary_confidence": "medium" if any(abs(c - s) < 3.0 or abs(c - e) < 3.0 for c in cuts) else "low",
            "status": "proposed",
            "warnings": [],
        })
    return segs


def segment_thumbnail(video: str, start: float, end: float, dest: str) -> None:
    mid = (start + end) / 2
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    p = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-ss", str(mid), "-i", video,
         "-frames:v", "1", "-vf", "scale=320:-1", dest],
        capture_output=True, text=True, check=False,
    )
    if p.returncode != 0 or not os.path.exists(dest):
        raise AnalysisError(f"Thumbnail failed: {(p.stderr or '')[:200]}")


def analyze_recording(video: str, workdir: str, recording_id: str,
                      max_seg: float = 150.0, min_seg: float = 25.0) -> dict[str, Any]:
    meta = media.probe_video(video)
    cuts = detect_cuts(video)
    bright = brightness_summary(video)
    segments = propose_segments(meta["duration"], cuts, max_seg, min_seg)
    thumbs = os.path.join(workdir, "thumbs")
    for seg in segments:
        thumb = os.path.join(thumbs, f"{seg['id']}.jpg")
        try:
            segment_thumbnail(video, seg["start"], seg["end"], thumb)
            seg["thumbnail"] = thumb
        except AnalysisError as e:
            seg["thumbnail"] = None
            seg["warnings"].append(str(e))
        if meta["duration"] > 0 and (seg["end"] - seg["start"]) < min_seg:
            seg["warnings"].append("Short segment: may lack overlap for reconstruction.")
    if bright.get("mean") is not None and bright["mean"] < 45:
        for seg in segments:
            seg["warnings"].append("Dim footage overall: add light or expect weak features.")
    return {
        "recordingId": recording_id,
        "video": os.path.abspath(video),
        "sha256": media.checksum(video),
        "duration": meta["duration"],
        "width": meta["width"],
        "height": meta["height"],
        "fps": meta["fps"],
        "analysis": {
            "cuts": cuts,
            "cutCount": len(cuts),
            "brightness": bright,
            "method": "ffmpeg scene-detect (0.35) + signalstats; heuristic segmentation",
        },
        "segments": segments,
    }
