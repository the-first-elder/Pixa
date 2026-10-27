"""KIRI Engine 3DGS Video API backend (hosted reconstruction).

Verified docs (2026-10-27): REST https://api.kiriengine.app/api/
  POST /v1/open/3dgs/video  { videoFile, isMesh=[0|1], fileFormat }
  limits: ≤1920x1080, ≤3 min. Async poll + webhooks. Zipped download (60-min link).
Output: 3DGS project as special PLY (+ mesh in obj/fbx/stl/ply/glb/gltf/usdz/xyz
when isMesh=1). Camera poses are NOT documented as returned — viewpoints are
derived by the app; diagnostics record poses as unavailable for KIRI jobs.

Needs KIRI_API_KEY env. Untested until the owner creates a KIRI account —
every method raises a clear error naming the missing piece, never fake output.
"""
from __future__ import annotations

import os
from typing import Any


class KiriBackend:
    name = "kiri"
    BASE = "https://api.kiriengine.app/api"

    def _key(self) -> str:
        key = os.environ.get("KIRI_API_KEY")
        if not key:
            raise RuntimeError(
                "KIRI_API_KEY not set. Create a KIRI dev account "
                "(10 free credits) and export KIRI_API_KEY. "
                "See docs/reconstruction-strategy.md."
            )
        return key

    def submit(self, job: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        self._key()
        raise RuntimeError(
            "KIRI submit not yet wired to a test credit (Stage 1). "
            "Next: POST /v1/open/3dgs/video with the fixture clip, isMesh=1."
        )

    def status(self, handle: dict[str, Any]):
        raise RuntimeError("KIRI status poll not yet implemented (Stage 1).")

    def fetch_asset(self, handle: dict[str, Any], dest_dir: str) -> dict[str, Any]:
        raise RuntimeError("KIRI asset download not yet implemented (Stage 1).")
