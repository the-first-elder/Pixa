"""Pluggable reconstruction backends. One interface; the app never knows which ran."""
from __future__ import annotations

from typing import Any, Protocol


class Backend(Protocol):
    name: str

    def submit(self, job: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        """Start reconstruction. Returns backend handle, e.g. {"remoteId": ...}."""
        ...

    def status(self, handle: dict[str, Any]) -> tuple[str, float | None, dict[str, Any] | None]:
        """Poll. Returns (state, progress0-1|None, diagnostics|None).
        state in: running | done | failed."""
        ...

    def fetch_asset(self, handle: dict[str, Any], dest_dir: str) -> dict[str, Any]:
        """Download artifacts. Returns {"assetPath":..., "format":..., "posesPath"|None...}."""
        ...
