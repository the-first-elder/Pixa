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

BACKENDS = {"local": LocalBackend, "kiri": KiriBackend, "runpod": RunpodBackend}


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

    backend_cls = BACKENDS.get(args.backend)
    if backend_cls is None:
        store.transition(job["id"], "failed", progress=None,
                         errorCode="UNKNOWN_BACKEND",
                         errorMessage=f"Unknown backend: {args.backend}")
        return 2
    backend = backend_cls()
    ctx = {"video": args.video, "asset": args.asset, "poses": args.poses,
           "scene": scene, "job": job}
    try:
        handle = backend.submit(job, ctx)
    except RuntimeError as e:
        msg, code = str(e), str(e).split(":")[0]
        store.transition(job["id"], "failed", progress=None,
                         errorCode=code, errorMessage=msg)
        print(f"JOB {job['id']} FAILED [{code}]: {msg}", file=sys.stderr)
        return 1
    if args.backend == "local" and hasattr(backend, "run"):
        job = backend.run(job["id"], handle)  # type: ignore[attr-defined]
        print(json.dumps({"jobId": job["id"], "status": job["status"]}))
        return 0 if job["status"] == "ready" else 1
    # Async backends (kiri/runpod): handle persisted for polling (Stage 1/2 wiring).
    jobs = store._load("jobs.json")
    jobs[job["id"]]["backendHandle"] = handle
    store._save("jobs.json", jobs)
    print(json.dumps({"jobId": job["id"], "status": "submitted, poll for completion"}))
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
    r.set_defaults(fn=cmd_process)
    j = sub.add_parser("jobs", help="List jobs + transitions")
    j.set_defaults(fn=cmd_jobs)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
