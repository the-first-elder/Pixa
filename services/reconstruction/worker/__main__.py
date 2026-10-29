"""Worker CLI: probe | extract | process | jobs."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys

from . import media, store
from .backends.local import LocalBackend
from .backends.kiri import KiriBackend
from .backends.runpod import RunpodBackend
from .backends.spirula import SpirulaBackend

BACKENDS = {"local": LocalBackend, "kiri": KiriBackend, "runpod": RunpodBackend,
            "spirula": SpirulaBackend}


def cmd_probe(args: argparse.Namespace) -> int:
    try:
        meta = media.probe_video(args.video, getattr(args, 'ext', None))
    except media.MediaError as e:
        print(f"INVALID: {e}", file=sys.stderr)
        return 2
    meta["sha256"] = media.checksum(args.video)
    meta["frameEstimates"] = media.estimate_frames(meta["duration"])
    print(json.dumps(meta, indent=2))
    return 0


def cmd_extract(args: argparse.Namespace) -> int:
    try:
        manifest = media.extract_frames(args.video, args.out, args.pipeline, args.fps)
    except media.MediaError as e:
        print(f"FAILED: {e}", file=sys.stderr)
        return 2
    print(json.dumps(manifest, indent=2))
    return 0


def cmd_join(args: argparse.Namespace) -> int:
    try:
        meta = media.join_videos(args.inputs, args.out)
    except media.MediaError as e:
        print(f"FAILED: {e}", file=sys.stderr)
        return 2
    print(json.dumps(meta, indent=2))
    return 0


def execute_job(job_id: str, video: str, backend_name: str,
                asset: str | None = None, poses: str | None = None,
                allow_spend: bool = False, iterations: int = 30000,
                sfm_args: list[str] | None = None,
                allow_partial: bool = False,
                fps: float | None = None) -> dict[str, Any]:
    """Run the pipeline for an EXISTING job record. Shared by `process` and `run-job`."""
    backend_cls = BACKENDS.get(backend_name)
    if backend_cls is None:
        return store.transition(job_id, "failed", progress=None,
                                errorCode="UNKNOWN_BACKEND",
                                errorMessage=f"Unknown backend: {backend_name}")
    backend = backend_cls()
    job = store.get_job(job_id)
    ctx = {"video": video, "asset": asset, "poses": poses, "job": job,
           "allowSpend": allow_spend, "iterations": iterations,
           "sfmArgs": sfm_args, "allowPartial": allow_partial, "fps": fps}
    try:
        handle = backend.submit(job, ctx)
    except RuntimeError as e:
        msg = str(e)
        return store.transition(job_id, "failed", progress=None,
                                errorCode=store.error_code(msg, "SUBMIT_FAILED"),
                                errorMessage=msg[:500])
    if hasattr(backend, "run"):
        return backend.run(job_id, handle)  # type: ignore[attr-defined]
    # Async backends (kiri/runpod): handle persisted for polling.
    jobs = store._load("jobs.json")
    jobs[job_id]["backendHandle"] = {**handle, "backend": backend_name}
    store._save("jobs.json", jobs)
    return store.get_job(job_id)


def cmd_cancel(args: argparse.Namespace) -> int:
    """Cancel a running job: SIGTERM its trainer process group, mark failed/CANCELLED."""
    import os as _os
    import signal as _signal
    try:
        job = store.get_job(args.job_id)
    except KeyError:
        print(f"UNKNOWN JOB: {args.job_id}", file=sys.stderr)
        return 2
    if job["status"] in ("ready", "failed"):
        print(json.dumps({"jobId": job["id"], "status": job["status"], "note": "already terminal"}))
        return 0
    pgid = job.get("trainPgid") or job.get("trainPid")
    if pgid is not None:
        try:
            _os.killpg(int(pgid), _signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                _os.kill(int(pgid), _signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                pass
    jobs = store._load("jobs.json")
    if job["id"] in jobs:
        for k in ("trainPid", "trainPgid", "waitingForTrainer", "waitingSince", "backendHandle"):
            jobs[job["id"]].pop(k, None)
        store._save("jobs.json", jobs)
    job = store.transition(job["id"], "failed", progress=None,
                           errorCode="CANCELLED",
                           errorMessage="Cancelled by operator. Partial outputs (if any) were not promoted to an asset.")
    print(json.dumps({"jobId": job["id"], "status": job["status"]}))
    return 0


def cmd_poll(args: argparse.Namespace) -> int:
    """Poll an async backend job (kiri/runpod): update state, fetch asset when done."""
    try:
        job = store.get_job(args.job_id)
    except KeyError:
        print(f"UNKNOWN JOB: {args.job_id}", file=sys.stderr)
        return 2
    handle = job.get("backendHandle") or {}
    backend_name = handle.get("backend")
    backend_cls = BACKENDS.get(backend_name or "")
    if backend_cls is None:
        print(f"NO ASYNC BACKEND on job {args.job_id} (backend={backend_name!r})", file=sys.stderr)
        return 2
    backend = backend_cls()
    try:
        state, _progress, diagnostics = backend.status(handle)
    except RuntimeError as e:
        print(f"POLL ERROR: {e}", file=sys.stderr)
        return 1
    if diagnostics:
        jobs = store._load("jobs.json")
        jobs[job["id"]]["diagnostics"] = diagnostics
        store._save("jobs.json", jobs)
    if state == "done":
        try:
            asset = backend.fetch_asset(handle, os.path.join(store.storage_dir(), "assets", job["id"]))
        except RuntimeError as e:
            store.transition(job["id"], "failed", progress=None,
                             errorCode="ASSET_FETCH_FAILED", errorMessage=str(e)[:300])
            print(f"JOB {job['id']} FAILED [ASSET_FETCH_FAILED]", file=sys.stderr)
            return 1
        jobs = store._load("jobs.json")
        jobs[job["id"]]["asset"] = asset
        store._save("jobs.json", jobs)
        store.transition(job["id"], "compressing", progress=90)
        job = store.transition(job["id"], "ready", progress=100)
    elif state == "failed":
        job = store.transition(job["id"], "failed", progress=None,
                               errorCode="BACKEND_FAILED",
                               errorMessage=f"{backend_name} job reported failure.")
    else:
        job = store.transition(job["id"], "reconstructing", progress=None)
    print(json.dumps({"jobId": job["id"], "status": job["status"]}))
    return 0 if job["status"] == "ready" else 1


def cmd_process(args: argparse.Namespace) -> int:
    try:
        meta = media.probe_video(args.video)
    except media.MediaError as e:
        print(f"INVALID: {e}", file=sys.stderr)
        return 2
    scene = store.create_scene(args.name, {**meta, "sha256": media.checksum(args.video)})
    job = store.create_job(scene["id"], "reconstruction")
    store.transition(job["id"], "uploaded", progress=5)
    print(json.dumps({"sceneId": scene["id"], "jobId": job["id"], "status": "queued"}))

    job = execute_job(job["id"], args.video, args.backend, args.asset, args.poses,
                      allow_spend=args.allow_spend, iterations=args.iterations,
                      sfm_args=shlex.split(args.sfm_args) if args.sfm_args else None,
                      allow_partial=args.allow_partial, fps=args.fps)
    if args.backend in ("kiri", "runpod") and job["status"] == "queued":
        print(json.dumps({"jobId": job["id"], "status": "submitted, poll for completion"}))
        return 0
    print(json.dumps({"jobId": job["id"], "status": job["status"]}))
    return 0 if job["status"] == "ready" else 1


def cmd_run_job(args: argparse.Namespace) -> int:
    """Execute the pipeline for a job created elsewhere (e.g., the web API)."""
    try:
        job = store.get_job(args.job_id)
    except KeyError:
        print(f"UNKNOWN JOB: {args.job_id}", file=sys.stderr)
        return 2
    job = execute_job(job["id"], args.video, args.backend, args.asset, args.poses,
                      allow_spend=args.allow_spend, iterations=args.iterations,
                      sfm_args=shlex.split(args.sfm_args) if args.sfm_args else None,
                      allow_partial=args.allow_partial, fps=args.fps)
    print(json.dumps({"jobId": job["id"], "status": job["status"]}))
    return 0 if job["status"] == "ready" else 1


def cmd_import_asset(args: argparse.Namespace) -> int:
    """Import a REAL externally-produced asset (runpod/kiri/manual) with verification.

    Validates the artifact (PLY magic header; size sanity for all formats),
    copies it under STORAGE_DIR, and records a ready reconstruction job.
    Never marks ready without a verified artifact.
    """
    if not os.path.exists(args.asset):
        print(f"ASSET NOT FOUND: {args.asset}", file=sys.stderr)
        return 2
    ext = os.path.splitext(args.asset)[1].lower()
    if ext == ".ply":
        with open(args.asset, "rb") as f:
            header = f.read(1500).decode("ascii", "replace")
        if not header.startswith("ply\n") or "element vertex" not in header:
            print(f"NOT A VALID SPLAT PLY: {args.asset}", file=sys.stderr)
            return 2
    elif ext not in (".spz", ".sog", ".ksplat", ".splat", ".glb"):
        print(f"UNSUPPORTED ASSET FORMAT {ext or '(none)'}: {args.asset}", file=sys.stderr)
        return 2
    if os.path.getsize(args.asset) < 1024:
        print(f"ASSET SUSPICIOUSLY SMALL: {args.asset}", file=sys.stderr)
        return 2
    if args.scene:
        try:
            scene = store._load("scenes.json")[args.scene]
        except KeyError:
            print(f"UNKNOWN SCENE: {args.scene}", file=sys.stderr)
            return 2
    else:
        scene = store.create_scene(args.name, {"importedFrom": os.path.abspath(args.asset)})
    dest_dir = os.path.join(store.storage_dir(), "assets", scene["id"])
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, os.path.basename(args.asset))
    if os.path.abspath(args.asset) != os.path.abspath(dest):
        import shutil
        shutil.copy2(args.asset, dest)
    job = store.create_job(scene["id"], "reconstruction")
    store.transition(job["id"], "uploaded", progress=5)
    jobs = store._load("jobs.json")
    jobs[job["id"]]["asset"] = {
        "assetPath": dest,
        "format": ext.lstrip(".") or "ply",
        "posesPath": args.poses,
        "posesFormat": args.poses_format,
    }
    jobs[job["id"]]["diagnostics"] = {
        "cameraPosesEstimated": bool(args.poses),
        "framesRegistered": None,
        "framesRejected": None,
        "coverageConcentratedInOneArea": None,
        "largeGapsOrUnstableRegions": None,
        "notes": [f"Artifact imported from {os.path.abspath(args.asset)}."],
    }
    store._save("jobs.json", jobs)
    store.transition(job["id"], "compressing", progress=90)
    job = store.transition(job["id"], "ready", progress=100)
    print(json.dumps({"sceneId": scene["id"], "jobId": job["id"], "status": "ready"}))
    return 0


def cmd_jobs(_args: argparse.Namespace) -> int:
    print(json.dumps(store.list_jobs(), indent=2))
    return 0


def cmd_analyze(args: argparse.Namespace) -> int:
    """Analyze a recording and write a segment manifest (no reconstruction)."""
    from . import analysis
    workdir = os.path.join(store.storage_dir(), "work",
                           args.recording_id or "analysis", "analysis")
    try:
        manifest = analysis.analyze_recording(
            args.video,
            workdir,
            args.recording_id or "pending",
            max_seg=args.max_segment,
            min_seg=args.min_segment,
        )
    except (media.MediaError, analysis.AnalysisError) as e:
        print(f"ANALYSIS FAILED: {e}", file=sys.stderr)
        return 2
    if args.recording_id:
        try:
            rec = store.get_recording(args.recording_id)
            rec["manifest"] = manifest
            rec["status"] = "analyzed"
            store.save_recording(rec)
        except KeyError:
            pass
    print(json.dumps(manifest, indent=2))
    return 0


def cmd_process_segment(args: argparse.Namespace) -> int:
    """Reconstruct ONE segment: trim clip (boundary overlap) → normal pipeline.
    Creates a scene linked to the recording+segment. Reuses execute_job fully
    (gates, backends, diagnostics included)."""
    from . import analysis  # noqa (keeps heavy imports local)
    try:
        rec = store.get_recording(args.recording)
    except KeyError:
        print(f"UNKNOWN RECORDING: {args.recording}", file=sys.stderr)
        return 2
    segs = rec.get("manifest", {}).get("segments", [])
    seg = next((s for s in segs if s["id"] == args.segment), None)
    if seg is None:
        print(f"UNKNOWN SEGMENT: {args.segment}", file=sys.stderr)
        return 2
    video = rec["manifest"]["video"]
    clip_dir = os.path.join(store.storage_dir(), "work", args.recording)
    os.makedirs(clip_dir, exist_ok=True)
    clip = os.path.join(clip_dir, f"{args.segment}.mp4")
    if not os.path.exists(clip):
        # Stream-copy trim is fast; overlap makes cut precision non-critical.
        p = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", str(seg["start"]),
             "-to", str(seg["end"]), "-i", video, "-c", "copy", clip],
            capture_output=True, text=True, check=False,
        )
        if p.returncode != 0 or not os.path.exists(clip):
            print(f"SEGMENT TRIM FAILED", file=sys.stderr)
            return 2
    try:
        meta = media.probe_video(clip)
    except media.MediaError as e:
        print(f"INVALID SEGMENT CLIP: {e}", file=sys.stderr)
        return 2
    scene = store.create_scene(f"{rec['name']} — {args.segment}",
                               {**meta, "sha256": media.checksum(clip)})
    # Link scene → recording + segment (building-ready model).
    scenes = store._load("scenes.json")
    scenes[scene["id"]]["parentRecordingId"] = args.recording
    scenes[scene["id"]]["segmentId"] = args.segment
    store._save("scenes.json", scenes)
    job = store.create_job(scene["id"], "reconstruction")
    store.transition(job["id"], "uploaded", progress=5)
    print(json.dumps({"sceneId": scene["id"], "jobId": job["id"], "status": "queued"}))
    job = execute_job(job["id"], clip, args.backend, args.asset, args.poses,
                      allow_spend=args.allow_spend, iterations=args.iterations,
                      sfm_args=shlex.split(args.sfm_args) if args.sfm_args else None,
                      allow_partial=args.allow_partial)
    for s in segs:
        if s["id"] == args.segment:
            s["status"] = "ready" if job["status"] == "ready" else job["status"]
            s["jobId"] = job["id"]
            s["sceneId"] = scene["id"]
    store.save_recording(rec)
    print(json.dumps({"jobId": job["id"], "status": job["status"]}))
    return 0 if job["status"] == "ready" else 1


def cmd_recover(_args: argparse.Namespace) -> int:
    """Mark non-terminal jobs failed/INTERRUPTED (process died mid-run).
    Also terminates orphaned trainer processes (by recorded pgid/pid) so the
    trainer slot frees up. Never claims resume — retry explicitly."""
    import signal as _signal
    jobs = store._load("jobs.json")
    marked = []
    for jid, job in jobs.items():
        if job["status"] not in ("ready", "failed"):
            pgid = job.get("trainPgid") or job.get("trainPid")
            if pgid is not None:
                try:
                    os.killpg(int(pgid), _signal.SIGTERM)
                except (ProcessLookupError, PermissionError, OSError):
                    try:
                        os.kill(int(pgid), _signal.SIGTERM)
                    except (ProcessLookupError, PermissionError, OSError):
                        pass
            job["status"] = "failed"
            job["errorCode"] = "INTERRUPTED"
            job["errorMessage"] = ("Process ended while this job was active. "
                                   "Nothing was resumed; retry explicitly.")
            job["completedAt"] = store.now()
            job.setdefault("transitions", []).append({"status": "failed", "at": store.now()})
            for k in ("trainPid", "trainPgid", "waitingForTrainer", "waitingSince"):
                job.pop(k, None)
            marked.append(jid)
    store._save("jobs.json", jobs)
    print(json.dumps({"markedInterrupted": marked}))
    return 0


def cmd_split_segment(args: argparse.Namespace) -> int:
    """Split a segment at a timestamp (user correction)."""
    try:
        rec = store.get_recording(args.recording)
    except KeyError:
        print(f"UNKNOWN RECORDING: {args.recording}", file=sys.stderr)
        return 2
    segs = rec.get("manifest", {}).get("segments", [])
    for i, s in enumerate(segs):
        if s["id"] == args.segment and s["start"] < args.at < s["end"]:
            a = {**s, "id": f"{s['id']}a", "end": args.at, "origin": "user-split",
                 "status": "proposed", "thumbnail": s.get("thumbnail")}
            b = {**s, "id": f"{s['id']}b", "start": args.at, "origin": "user-split",
                 "status": "proposed", "thumbnail": s.get("thumbnail")}
            segs[i:i + 1] = [a, b]
            store.save_recording(rec)
            print(json.dumps({"split": [a["id"], b["id"]]}))
            return 0
    print("SPLIT NOT APPLICABLE (unknown segment or timestamp outside it)", file=sys.stderr)
    return 2


def cmd_merge_segments(args: argparse.Namespace) -> int:
    """Merge two segments into one spanning both (user correction)."""
    try:
        rec = store.get_recording(args.recording)
    except KeyError:
        print(f"UNKNOWN RECORDING: {args.recording}", file=sys.stderr)
        return 2
    segs = rec.get("manifest", {}).get("segments", [])
    pick = [s for s in segs if s["id"] in (args.seg_a, args.seg_b)]
    if len(pick) != 2:
        print("MERGE NEEDS TWO KNOWN SEGMENTS", file=sys.stderr)
        return 2
    a, b = sorted(pick, key=lambda s: s["start"])
    merged = {**a, "id": f"{a['id']}+{b['id']}", "end": b["end"],
              "origin": "user-merge", "status": "proposed"}
    segs[:] = [s for s in segs if s["id"] not in (args.seg_a, args.seg_b)] + [merged]
    segs.sort(key=lambda s: s["start"])
    store.save_recording(rec)
    print(json.dumps({"merged": merged["id"]}))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="worker", description="Pixa reconstruction worker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe", help="Validate + inspect a video (read-only)")
    p.add_argument("video")
    p.add_argument("--ext", default=None, help="Format hint when the path has no usable extension")
    p.set_defaults(fn=cmd_probe)
    e = sub.add_parser("extract", help="Extract frames (pipeline A|B)")
    e.add_argument("video")
    e.add_argument("--out", required=True)
    e.add_argument("--pipeline", choices=["A", "B"], required=True)
    e.add_argument("--fps", type=float, default=None, help="Override pipeline B fps (adaptive per-segment sampling)")
    e.set_defaults(fn=cmd_extract)
    jn = sub.add_parser("join", help="Concatenate capture passes into one video, in order")
    jn.add_argument("inputs", nargs="+", help="Pass videos in order (validated first)")
    jn.add_argument("--out", required=True)
    jn.set_defaults(fn=cmd_join)
    r = sub.add_parser("process", help="Run a full reconstruction job")
    r.add_argument("video")
    r.add_argument("--name", default="Untitled scene")
    r.add_argument("--backend", choices=sorted(BACKENDS), default="local")
    r.add_argument("--asset", default=None, help="runpod: path to real splat.ply")
    r.add_argument("--poses", default=None, help="runpod: path to transforms.json")
    r.add_argument("--allow-spend", action="store_true",
                   help="Opt in to spending KIRI credits (kiri backend only)")
    r.add_argument("--iterations", type=int, default=30000,
                   help="Training iterations (spirula backend)")
    r.add_argument("--sfm-args", default=None,
                   help="Extra/override args for 'spirula sfm auto', quoted string")
    r.add_argument("--allow-partial", action="store_true",
                   help="Train the largest connected component when coverage is incomplete (labeled partial)")
    r.add_argument("--fps", type=float, default=None,
                   help="Override reconstruction frame rate (default 2)")
    r.set_defaults(fn=cmd_process)
    u = sub.add_parser("run-job", help="Run pipeline for an existing job record")
    u.add_argument("job_id")
    u.add_argument("--video", required=True)
    u.add_argument("--backend", choices=sorted(BACKENDS), default="local")
    u.add_argument("--asset", default=None)
    u.add_argument("--poses", default=None)
    u.add_argument("--allow-spend", action="store_true",
                   help="Opt in to spending KIRI credits (kiri backend only)")
    u.add_argument("--iterations", type=int, default=30000,
                   help="Training iterations (spirula backend)")
    u.add_argument("--sfm-args", default=None,
                   help="Extra/override args for 'spirula sfm auto', quoted string")
    u.add_argument("--allow-partial", action="store_true",
                   help="Train the largest connected component when coverage is incomplete (labeled partial)")
    u.add_argument("--fps", type=float, default=None,
                   help="Override reconstruction frame rate (default 2)")
    u.set_defaults(fn=cmd_run_job)
    w = sub.add_parser("poll", help="Poll an async backend job; fetch asset when done")
    w.add_argument("job_id")
    w.set_defaults(fn=cmd_poll)
    c = sub.add_parser("cancel", help="Cancel a running job (stops its trainer)")
    c.add_argument("job_id")
    c.set_defaults(fn=cmd_cancel)
    i = sub.add_parser("import-asset", help="Import a verified external asset as a ready job")
    i.add_argument("--scene", default=None, help="existing scene id (default: create)")
    i.add_argument("--name", default="Imported scene")
    i.add_argument("--asset", required=True, help="path to real .ply splat asset")
    i.add_argument("--poses", default=None, help="path to COLMAP sparse model or transforms.json")
    i.add_argument("--poses-format", default=None)
    i.set_defaults(fn=cmd_import_asset)
    j = sub.add_parser("jobs", help="List jobs + transitions")
    j.set_defaults(fn=cmd_jobs)
    a = sub.add_parser("analyze", help="Analyze a recording into a segment manifest")
    a.add_argument("video")
    a.add_argument("--recording-id", default=None)
    a.add_argument("--max-segment", type=float, default=150.0)
    a.add_argument("--min-segment", type=float, default=25.0)
    a.set_defaults(fn=cmd_analyze)
    g = sub.add_parser("process-segment", help="Reconstruct one recording segment")
    g.add_argument("--recording", required=True)
    g.add_argument("--segment", required=True)
    g.add_argument("--backend", choices=sorted(BACKENDS), default="spirula")
    g.add_argument("--asset", default=None)
    g.add_argument("--poses", default=None)
    g.add_argument("--allow-spend", action="store_true")
    g.add_argument("--iterations", type=int, default=30000)
    g.add_argument("--sfm-args", default=None)
    g.add_argument("--allow-partial", action="store_true")
    g.set_defaults(fn=cmd_process_segment)
    r = sub.add_parser("recover", help="Mark interrupted non-terminal jobs failed")
    r.set_defaults(fn=cmd_recover)
    sp = sub.add_parser("split-segment", help="Split a segment at a timestamp")
    sp.add_argument("--recording", required=True)
    sp.add_argument("--segment", required=True)
    sp.add_argument("--at", type=float, required=True)
    sp.set_defaults(fn=cmd_split_segment)
    mg = sub.add_parser("merge-segments", help="Merge two segments")
    mg.add_argument("--recording", required=True)
    mg.add_argument("--seg-a", required=True)
    mg.add_argument("--seg-b", required=True)
    mg.set_defaults(fn=cmd_merge_segments)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
