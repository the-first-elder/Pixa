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


_CODE_RE = None


def error_code(raw: str, fallback: str = "BACKEND_FAILED") -> str:
    """Sanitize an error code: short SCREAMING token only, never a sentence.

    User-facing surfaces (worlds cards, notifications) render errorCode, so it
    must never contain paths or prose. Anything that fails the shape check
    becomes the fallback; the full message stays in errorMessage (dev-only).
    """
    global _CODE_RE
    if _CODE_RE is None:
        import re as _re
        _CODE_RE = _re.compile(r"^[A-Z][A-Z0-9_]{1,31}$")
    candidate = (raw or "").split(":")[0].strip()
    return candidate if _CODE_RE.match(candidate) else fallback


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
    if status in ("ready", "failed"):
        _maybe_email(job_id, job)
    return job


def _maybe_email(job_id: str, job: dict[str, Any]) -> None:
    """Fire-and-forget completion mail. At-most-once, never fails the job.

    Stamp-before-send: the notified flag persists BEFORE sending, so a crash
    between the two can't double-mail (worst case one mail is lost, never
    duplicated). A failed send releases the stamp for a later retry.
    """
    try:
        from . import notify as _notify
        email, name = _notify.recipient(job)
        if not email:
            return
        import os as _os
        if _os.environ.get("EMAIL_DRY_RUN") == "1":
            _notify.send(email, name, job)  # render-only, stamps nothing
            return
        jobs = _load("jobs.json")
        if job_id not in jobs:
            return
        jobs[job_id].setdefault("emailNotified", {})[job["status"]] = True
        _save("jobs.json", jobs)
        if not _notify.send(email, name, job):
            jobs = _load("jobs.json")
            if job_id in jobs:
                jobs[job_id].get("emailNotified", {}).pop(job["status"], None)
                _save("jobs.json", jobs)
    except Exception as e:  # noqa: BLE001 — email must never fail a job
        print(f"[notify] skipped: {type(e).__name__}: {str(e)[:120]}",
              file=sys.stderr)


def update_progress(job_id: str, progress: int | None,
                    detail: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Update progress/detail without appending a transition (for frequent
    polling loops — transitions are stage changes only, not heartbeats)."""
    jobs = _load("jobs.json")
    job = jobs.get(job_id)
    if job is None:
        return None
    job["progress"] = progress
    if detail is not None:
        job["detail"] = detail
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
