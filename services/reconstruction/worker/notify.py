"""Completion emails for reconstruction jobs (Brevo API, stdlib only).

Called once per terminal transition (ready/failed) from store.transition.
Design constraints, all deliberate:
- Idempotent: job["emailNotified"][status] is stamped BEFORE sending, so a
  retry/crash never double-mails. At-most-once by construction.
- Never fails a job: every error path logs to stderr and returns False.
- No new dependencies: urllib to api.brevo.com, nothing to pip-install.
- Disabled by default: without BREVO_API_KEY it logs once and returns.
- Legacy-safe: jobs without ownerId, owners without email, and the dry-run
  flag (EMAIL_DRY_RUN=1 renders + validates without sending) all skip cleanly.

Env:
  BREVO_API_KEY  xkeysib-... key (required to send)
  EMAIL_FROM     sender address, e.g. worlds@yourdomain.com — must be a
                 verified sender in Brevo (required to send)
  EMAIL_FROM_NAME display name, default "Pixa"
  APP_URL        public base for scene links (default http://localhost:3000)
  EMAIL_DRY_RUN=1 render only, mark nothing, always return True
"""
import json
import os
import sys
import urllib.request
from typing import Any

ACCENT = "#e2a63b"
BG = "#0a0a0b"
CARD = "#111113"
TEXT = "#f5f1e8"
MUTED = "#a3a3a3"
GREEN = "#34d399"
RED = "#fbbf24"


def _load(name: str) -> dict[str, Any]:
    try:
        with open(os.path.join(_storage(), name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _storage() -> str:
    return os.environ.get("STORAGE_DIR", "./data")


def _owner_email(owner_id: str | None) -> tuple[str | None, str | None]:
    """(email, display name) for a google:<sub> uid, else (None, None)."""
    if not owner_id:
        return None, None
    user = _load("users.json").get(owner_id) or {}
    email = user.get("email") or None
    name = user.get("name") or None
    return email, name


def _scene_name(scene_id: str) -> str:
    scene = _load("scenes.json").get(scene_id) or {}
    return scene.get("name") or "Your scene"


def render(job: dict[str, Any], email: str, name: str | None) -> tuple[str, str]:
    """(subject, html) for a terminal job. Pure — safe to unit-test."""
    status = job.get("status")
    scene_id = job.get("sceneId", "")
    scene_name = _scene_name(scene_id)
    app = os.environ.get("APP_URL", "http://localhost:3000").rstrip("/")
    link = f"{app}/scenes/{scene_id}"
    first = (name or "there").split(" ")[0]
    if status == "ready":
        subject = f"Your world is ready — {scene_name}"
        headline = "Your world is ready."
        color = GREEN
        body = (f"Your 3D scene <strong>{scene_name}</strong> has finished "
                f"processing. Step inside, walk the rooms, and ask it questions.")
        cta = "Explore your world"
    else:
        subject = f"We couldn't finish building {scene_name}"
        headline = "We couldn't finish building your world."
        color = RED
        code = job.get("errorCode") or "unknown error"
        body = (f"The reconstruction for <strong>{scene_name}</strong> ran into "
                f"a problem (<span style=\"color:{MUTED}\">{code}</span>). "
                f"Your project is saved — open it for details and next steps.")
        cta = "View details"
    logo = f"{app}/email-logo.png"
    html = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:{BG};color:{TEXT};font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;">
<div><img src="{logo}" width="40" height="40" alt="Pixa" style="display:inline-block;vertical-align:middle;border-radius:9px;"/><span style="font-size:22px;letter-spacing:-0.5px;vertical-align:middle;">&nbsp;Pixa</span></div>
<div style="margin-top:24px;border:1px solid #262626;border-radius:12px;background:{CARD};padding:28px;">
<div style="font-size:11px;letter-spacing:3px;color:{ACCENT};">PIXA &middot; YOUR WORLD</div>
<h1 style="font-size:28px;margin:12px 0 8px;font-weight:normal;">Hi {first},<br/>{headline}</h1>
<p style="font-size:15px;line-height:1.6;color:{TEXT};">{body}</p>
<a href="{link}" style="display:inline-block;margin-top:16px;background:{ACCENT};color:#000;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:12px 24px;border-radius:6px;">{cta} &rarr;</a>
<p style="font-family:Arial,sans-serif;font-size:12px;color:{MUTED};margin-top:20px;">Or paste this link:<br/><a href="{link}" style="color:{ACCENT};">{link}</a></p>
</div>
<p style="font-family:Arial,sans-serif;font-size:11px;color:{MUTED};margin-top:16px;">Pixa stores only your account ID, email, and display name. <a href="{app}/worlds" style="color:{ACCENT};">Manage your worlds</a></p>
</div>
</body></html>"""
    return subject, html


def _send(to: str, subject: str, html: str, name: str | None = None) -> bool:
    api_key = os.environ.get("BREVO_API_KEY")
    sender = os.environ.get("EMAIL_FROM")
    if not api_key or not sender:
        print("[notify] email disabled (set BREVO_API_KEY + EMAIL_FROM)", file=sys.stderr)
        return False
    payload: dict[str, Any] = {
        "sender": {"name": os.environ.get("EMAIL_FROM_NAME", "Pixa"), "email": sender},
        "to": [{"email": to, **({"name": name} if name else {})}],
        "subject": subject,
        "htmlContent": html,
    }
    req = urllib.request.Request(
        "https://api.brevo.com/v3/smtp/email",
        data=json.dumps(payload).encode(),
        headers={"api-key": api_key, "Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            ok = res.status in (200, 201, 202)
            if not ok:
                print(f"[notify] brevo HTTP {res.status}", file=sys.stderr)
            return ok
    except Exception as e:  # noqa: BLE001 — email must never fail a job
        detail = ""
        read = getattr(e, "read", None)
        if callable(read):
            try:
                detail = f" {read().decode()[:150]}"
            except Exception:  # noqa: BLE001
                pass
        print(f"[notify] send failed: {type(e).__name__}: {str(e)[:100]}{detail}", file=sys.stderr)
        return False


def recipient(job: dict[str, Any]) -> tuple[str | None, str | None]:
    """(email, name) the terminal mail is due to, or (None, None) to skip.

    Skips: non-terminal states, already-mailed outcomes, legacy jobs without
    an owner, owners without an email. Pure read — no writes, no sends.
    """
    status = job.get("status")
    if status not in ("ready", "failed"):
        return None, None
    if job.get("emailNotified", {}).get(status):
        return None, None  # already mailed for this outcome
    return _owner_email(job.get("ownerId"))


def send(email: str, name: str | None, job: dict[str, Any]) -> bool:
    """Render + send the terminal mail. False on any failure (never raises).

    EMAIL_DRY_RUN=1 renders and validates without sending (always True).
    """
    if os.environ.get("EMAIL_DRY_RUN") == "1":
        subject, _ = render(job, email, name)
        print(f"[notify] dry-run: would mail {email} re: {subject}")
        return True
    subject, html = render(job, email, name)
    ok = _send(email, subject, html, name)
    if ok:
        print(f"[notify] mailed {email} ({job.get('status')} {job.get('id')})")
    return ok
