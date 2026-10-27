"""KIRI Engine 3DGS Video API backend (hosted reconstruction).

Verified docs (https://docs.kiriengine.app):
  GET  /v1/open/balance                                   -> {"data": {"balance": N}}
  POST /v1/open/3dgs/video  {videoFile, isMesh, isMask[, fileFormat]}
       limits: <=1920x1080, <=3 min.                     -> {"data": {"serialize": ...}}
  GET  /v1/open/model/getStatus?serialize=...            -> {"data": {"status": -1|0|1|2|3|4}}
       -1 uploading, 0 processing, 1 failed, 2 successful, 3 queuing, 4 expired
  GET  /v1/open/model/getModelZip?serialize=...          -> {"data": {"modelUrl": ...}}
       link valid 60 minutes.

COST: each video submit = 1 credit ($1). Nothing else here spends credits.
CREDIT GUARD: submit() refuses unless ctx["allowSpend"] is True (CLI: --allow-spend).
Pre-flight checks (resolution/duration/balance) run BEFORE any spend.

Camera poses are NOT returned by KIRI: diagnostics record poses as
unavailable for KIRI jobs; the app derives viewpoints itself.
"""
from __future__ import annotations

import io
import json
import mimetypes
import os
import urllib.parse
import urllib.request
import uuid
import zipfile
from typing import Any

from .. import media

BASE = "https://api.kiriengine.app/api"
MAX_WIDTH = 1920
MAX_HEIGHT = 1080
MAX_DURATION = 180  # 3 minutes


class KiriError(RuntimeError):
    pass


def _key() -> str:
    key = os.environ.get("KIRI_API_KEY")
    if not key:
        raise KiriError(
            "KIRI_API_KEY not set. Export it from the project's .env "
            "(never commit it). See docs/reconstruction-strategy.md."
        )
    return key


def _request(method: str, path: str, body: bytes | None = None,
             content_type: str | None = None) -> dict[str, Any]:
    req = urllib.request.Request(
        BASE + path, data=body, method=method,
        headers={"Authorization": f"Bearer {_key()}"},
    )
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise KiriError(f"KIRI HTTP {e.code}: {detail}") from e
    if not isinstance(payload, dict) or not payload.get("ok") or payload.get("code") not in (0, 200):
        raise KiriError(f"KIRI error: {json.dumps(payload)[:300]}")
    return payload["data"]


def get_balance() -> int:
    """Free read-only credit check. Never spends."""
    return int(_request("GET", "/v1/open/balance")["balance"])


def _multipart(fields: dict[str, str], file_field: str,
               file_name: str, file_bytes: bytes) -> tuple[bytes, str]:
    boundary = f"----wl{uuid.uuid4().hex}"
    buf = io.BytesIO()
    for k, v in fields.items():
        buf.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    ctype = mimetypes.guess_type(file_name)[0] or "video/mp4"
    buf.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{file_name}\"\r\n"
              f"Content-Type: {ctype}\r\n\r\n".encode())
    buf.write(file_bytes)
    buf.write(f"\r\n--{boundary}--\r\n".encode())
    return buf.getvalue(), f"multipart/form-data; boundary={boundary}"


class KiriBackend:
    name = "kiri"

    def submit(self, job: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        if not ctx.get("allowSpend"):
            raise KiriError(
                "CREDIT GUARD: refusing to spend KIRI credits without explicit opt-in. "
                "Re-run with --allow-spend (CLI) after confirming the fixture clip is valid."
            )
        video = ctx["video"]
        try:
            meta = media.probe_video(video)
        except media.MediaError as e:
            raise KiriError(f"Pre-flight probe failed, no credits spent: {e}") from e
        if meta["width"] > MAX_WIDTH or meta["height"] > MAX_HEIGHT:
            raise KiriError(
                f"Pre-flight failed, no credits spent: resolution "
                f"{meta['width']}x{meta['height']} exceeds 1920x1080."
            )
        if meta["duration"] > MAX_DURATION:
            raise KiriError(
                f"Pre-flight failed, no credits spent: duration {meta['duration']}s exceeds 3 minutes."
            )
        if get_balance() < 1:
            raise KiriError("Pre-flight failed, no credits spent: KIRI balance is 0.")
        with open(video, "rb") as f:
            blob = f.read()
        is_mesh = str(ctx.get("isMesh", 1))  # default ON: splat PLY + mesh fallback in one call
        fields: dict[str, str] = {"isMesh": is_mesh, "isMask": str(ctx.get("isMask", 0))}
        if is_mesh == "1":
            fields["fileFormat"] = ctx.get("fileFormat", "glb")
        body, ctype = _multipart(fields, "videoFile", os.path.basename(video), blob)
        data = _request("POST", "/v1/open/3dgs/video", body, ctype)
        serialize = data.get("serialize")
        if not serialize:
            raise KiriError(f"KIRI submit returned no serialize id: {data!r}"[:200])
        return {"serialize": serialize}

    def status(self, handle: dict[str, Any]) -> tuple[str, float | None, dict[str, Any] | None]:
        data = _request(
            "GET", "/v1/open/model/getStatus?serialize=" + urllib.parse.quote(str(handle["serialize"]))
        )
        code = int(data.get("status", -1))
        diagnostics: dict[str, Any] = {
            "cameraPosesEstimated": False,
            "framesRegistered": None,
            "framesRejected": None,
            "coverageConcentratedInOneArea": None,
            "largeGapsOrUnstableRegions": None,
            "notes": ["KIRI does not return camera poses; poses unavailable for this job."],
        }
        if code == 2:
            return ("done", 1.0, diagnostics)
        if code in (1, 4):
            return ("failed", None, diagnostics)
        return ("running", None, diagnostics)  # -1 uploading, 0 processing, 3 queuing

    def fetch_asset(self, handle: dict[str, Any], dest_dir: str) -> dict[str, Any]:
        data = _request(
            "GET", "/v1/open/model/getModelZip?serialize=" + urllib.parse.quote(str(handle["serialize"]))
        )
        url = data.get("modelUrl")
        if not url:
            raise KiriError("KIRI returned no modelUrl (link may have expired after 60 min).")
        os.makedirs(dest_dir, exist_ok=True)
        zip_path = os.path.join(dest_dir, "kiri-model.zip")
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {_key()}"})
        with urllib.request.urlopen(req, timeout=600) as res, open(zip_path, "wb") as f:
            while True:
                chunk = res.read(4 * 1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(dest_dir)
            names = z.namelist()
        splats = [n for n in names if n.lower().endswith((".ply", ".splat", ".spz", ".ksplat"))]
        meshes = [n for n in names if n.lower().endswith((".glb", ".gltf", ".obj", ".fbx", ".stl", ".usdz"))]
        out: dict[str, Any] = {"zipPath": zip_path, "contents": names, "posesPath": None}
        if splats:
            out.update({"assetPath": os.path.join(dest_dir, splats[0]), "format": "ply"})
        if meshes:
            out["meshPath"] = os.path.join(dest_dir, meshes[0])
        if "assetPath" not in out and "meshPath" not in out:
            raise KiriError(f"KIRI zip contained no usable asset: {names[:20]!r}"[:300])
        return out
