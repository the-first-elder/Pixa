"""File-backed job/scene store. Atomic writes. Zero dependencies."""
from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from typing import Any

STATES = [
    "uploaded",
    "queued",
    "extracting_frames",
    "estimating_camera_poses",
    "reconstructing",
    "compressing",
    "building_scene_index",
    "ready",
    "failed",
]


def storage_dir() -> str:
    d = os.environ.get("STORAGE_DIR", "./data")
    os.makedirs(d, exist_ok=True)
    return d


def _path(name: str) -> str:
    return os.path.join(storage_dir(), name)


def _load(name: str) -> dict[str, Any]:
    p = _path(name)
    if not os.path.exists(p):
        return {}
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(name: str, data: dict[str, Any]) -> None:
    p = _path(name)
    fd, tmp = tempfile.mkstemp(dir=storage_dir(), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def create_scene(name: str, source_video: dict[str, Any]) -> dict[str, Any]:
    scenes = _load("scenes.json")
    scene = {
        "id": new_id("scene"),
        "name": name,
        "status": "created",
        "createdAt": now(),
        "sourceVideo": source_video,
        "visualAssetId": None,
        "manifestId": None,
        "sceneGraphVersion": 0,
        "visibility": "private",
        "processingError": None,
    }
    scenes[scene["id"]] = scene
    _save("scenes.json", scenes)
    return scene


def create_job(scene_id: str, job_type: str) -> dict[str, Any]:
    jobs = _load("jobs.json")
    job = {
        "id": new_id("job"),
        "sceneId": scene_id,
        "jobType": job_type,
        "status": "queued",
        "progress": 0,
        "startedAt": now(),
        "completedAt": None,
        "errorCode": None,
        "errorMessage": None,
        "diagnostics": None,
        "transitions": [{"status": "queued", "at": now()}],
    }
    jobs[job["id"]] = job
    _save("jobs.json", jobs)
    return job


def transition(job_id: str, status: str, **fields: Any) -> dict[str, Any]:
    if status not in STATES:
        raise ValueError(f"Unknown job state: {status}")
    jobs = _load("jobs.json")
    job = jobs[job_id]
    job["status"] = status
    for k, v in fields.items():
        job[k] = v
    job.setdefault("transitions", []).append({"status": status, "at": now()})
    if status in ("ready", "failed"):
        job["completedAt"] = now()
    else:
        # A retry in progress supersedes the previous terminal state.
        job["completedAt"] = None
        job["errorCode"] = None
        job["errorMessage"] = None
    _save("jobs.json", jobs)
    return job


def get_job(job_id: str) -> dict[str, Any]:
    return _load("jobs.json")[job_id]


def list_jobs() -> list[dict[str, Any]]:
    return list(_load("jobs.json").values())


def create_recording(name: str, manifest: dict[str, Any]) -> dict[str, Any]:
    recs = _load("recordings.json")
    rec = {
        "id": new_id("rec"),
        "name": name,
        "status": "analyzed",
        "createdAt": now(),
        "manifest": manifest,
        "connections": [],
    }
    recs[rec["id"]] = rec
    _save("recordings.json", recs)
    return rec


def get_recording(rec_id: str) -> dict[str, Any]:
    return _load("recordings.json")[rec_id]


def save_recording(rec: dict[str, Any]) -> None:
    recs = _load("recordings.json")
    recs[rec["id"]] = rec
    _save("recordings.json", recs)


def list_recordings() -> list[dict[str, Any]]:
    return list(_load("recordings.json").values())
