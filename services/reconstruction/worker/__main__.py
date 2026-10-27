"""Worker CLI: probe | extract | process | jobs."""
from __future__ import annotations

import argparse
import json
import os
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
        meta = media.probe_video(args.video)
    except media.MediaError as e:
        print(f"INVALID: {e}", file=sys.stderr)
        return 2
    meta["sha256"] = media.checksum(args.video)
    meta["frameEstimates"] = media.estimate_frames(meta["duration"])
    print(json.dumps(meta, indent=2))
    return 0


def cmd_extract(args: argparse.Namespace) -> int:
    try:
        manifest = media.extract_frames(args.video, args.out, args.pipeline)
    except media.MediaError as e:
        print(f"FAILED: {e}", file=sys.stderr)
        return 2
    print(json.dumps(manifest, indent=2))
    return 0


def execute_job(job_id: str, video: str, backend_name: str,
                asset: str | None = None, poses: str | None = None,
                allow_spend: bool = False, iterations: int = 30000) -> dict[str, Any]:
    """Run the pipeline for an EXISTING job record. Shared by `process` and `run-job`."""
    backend_cls = BACKENDS.get(backend_name)
    if backend_cls is None:
        return store.transition(job_id, "failed", progress=None,
                                errorCode="UNKNOWN_BACKEND",
                                errorMessage=f"Unknown backend: {backend_name}")
    backend = backend_cls()
    job = store.get_job(job_id)
    ctx = {"video": video, "asset": asset, "poses": poses, "job": job,
           "allowSpend": allow_spend, "iterations": iterations}
    try:
        handle = backend.submit(job, ctx)
    except RuntimeError as e:
        msg, code = str(e), str(e).split(":")[0]
        return store.transition(job_id, "failed", progress=None,
                                errorCode=code, errorMessage=msg)
    if hasattr(backend, "run"):
        return backend.run(job_id, handle)  # type: ignore[attr-defined]
    # Async backends (kiri/runpod): handle persisted for polling.
    jobs = store._load("jobs.json")
    jobs[job_id]["backendHandle"] = {**handle, "backend": backend_name}
    store._save("jobs.json", jobs)
    return store.get_job(job_id)


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
                      allow_spend=args.allow_spend, iterations=args.iterations)
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
                      allow_spend=args.allow_spend, iterations=args.iterations)
    print(json.dumps({"jobId": job["id"], "status": job["status"]}))
    return 0 if job["status"] == "ready" else 1


def cmd_import_asset(args: argparse.Namespace) -> int:
    """Import a REAL externally-produced asset (runpod/kiri/manual) with verification.

    Validates the PLY header, copies it under STORAGE_DIR, and records a ready
    reconstruction job. Never marks ready without a verified artifact.
    """
    if not os.path.exists(args.asset):
        print(f"ASSET NOT FOUND: {args.asset}", file=sys.stderr)
        return 2
    with open(args.asset, "rb") as f:
        header = f.read(1500).decode("ascii", "replace")
    if not header.startswith("ply\n") or "element vertex" not in header:
        print(f"NOT A VALID SPLAT PLY: {args.asset}", file=sys.stderr)
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
        "format": "ply",
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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="worker", description="WorldLens reconstruction worker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe", help="Validate + inspect a video (read-only)")
    p.add_argument("video")
    p.set_defaults(fn=cmd_probe)
    e = sub.add_parser("extract", help="Extract frames (pipeline A|B)")
    e.add_argument("video")
    e.add_argument("--out", required=True)
    e.add_argument("--pipeline", choices=["A", "B"], required=True)
    e.set_defaults(fn=cmd_extract)
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
    u.set_defaults(fn=cmd_run_job)
    w = sub.add_parser("poll", help="Poll an async backend job; fetch asset when done")
    w.add_argument("job_id")
    w.set_defaults(fn=cmd_poll)
    i = sub.add_parser("import-asset", help="Import a verified external asset as a ready job")
    i.add_argument("--scene", default=None, help="existing scene id (default: create)")
    i.add_argument("--name", default="Imported scene")
    i.add_argument("--asset", required=True, help="path to real .ply splat asset")
    i.add_argument("--poses", default=None, help="path to COLMAP sparse model or transforms.json")
    i.add_argument("--poses-format", default=None)
    i.set_defaults(fn=cmd_import_asset)
    j = sub.add_parser("jobs", help="List jobs + transitions")
    j.set_defaults(fn=cmd_jobs)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
