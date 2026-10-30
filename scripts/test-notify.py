#!/usr/bin/env python3
"""notify.py unit tests: stamp-before-send, fail-closed, skip paths, renders.

Offline, isolated STORAGE_DIR, no API calls, no sends (dry-run + missing-key
paths only). Run: STORAGE_DIR=/tmp/wl-ntest python3 scripts/test-notify.py
"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "reconstruction"))

STORE = tempfile.mkdtemp(prefix="wl-notify-py-")
os.environ["STORAGE_DIR"] = STORE
os.environ["APP_URL"] = "https://example.invalid"
os.environ.pop("BREVO_API_KEY", None)
os.environ.pop("EMAIL_FROM", None)

from worker import notify, store  # noqa: E402

PASS, FAIL = 0, []


def ok(name):
    global PASS
    PASS += 1
    print(f"PASS: {name}")


def bad(name, detail=""):
    FAIL.append(name)
    print(f"FAIL: {name} {detail}")


def seed():
    store._save("users.json", {"google:u1": {"id": "google:u1", "email": "u1@example.com", "name": "Test User"}})
    store._save("scenes.json", {"scene_mail": {"id": "scene_mail", "name": "Sunny Loft", "ownerId": "google:u1"}})
    store._save("jobs.json", {})
    jobs = store._load("jobs.json")
    jobs["job_mail1"] = {"id": "job_mail1", "sceneId": "scene_mail", "jobType": "reconstruction",
                         "status": "queued", "progress": 0, "startedAt": "x", "completedAt": None,
                         "errorCode": None, "errorMessage": None, "diagnostics": None,
                         "transitions": [], "ownerId": "google:u1"}
    store._save("jobs.json", jobs)


def main():
    os.environ["EMAIL_DRY_RUN"] = "1"
    seed()
    # 1. terminal transition: dry-run renders, stamps nothing, job intact
    store.transition("job_mail1", "ready", progress=100)
    j1 = store._load("jobs.json")["job_mail1"]
    if j1["status"] == "ready" and "emailNotified" not in j1:
        ok("dry-run renders, no stamp, job intact")
    else:
        bad("dry-run stamp/state", str(j1.get("emailNotified")))
    # 2. recipient skip paths
    skips = [
        ({"status": "reconstructing"}, "non-terminal"),
        ({"status": "ready", "emailNotified": {"ready": True}}, "already mailed"),
        ({"status": "ready", "ownerId": None}, "legacy/no owner"),
        ({"status": "ready", "ownerId": "google:ghost"}, "unknown owner"),
    ]
    if all(notify.recipient(j) == (None, None) for j, _ in skips):
        ok("skip paths (non-terminal/stamped/legacy/unknown)")
    else:
        bad("skip paths")
    # 3. renders carry link, brand, error code
    subj, html = notify.render({"status": "ready", "sceneId": "scene_mail", "id": "x"}, "t@e.com", "Test User")
    subj2, html2 = notify.render({"status": "failed", "sceneId": "scene_mail", "id": "x", "errorCode": "COVERAGE_GAP"}, "t@e.com", None)
    if (subj == "Your world is ready \u2014 Sunny Loft"
            and "https://example.invalid/scenes/scene_mail" in html
            and "#e2a63b" in html and "#0a0a0b" in html and "Pixa" in html
            and "Hi there" in html2 and "COVERAGE_GAP" in html2):
        ok("ready+failed renders carry link, brand, error code")
    else:
        bad("renders", subj)
    # 3b. failure mail must name the scene, state the error, and link to it
    if (subj2 == "We couldn't finish building Sunny Loft"
            and "Sunny Loft" in html2 and "COVERAGE_GAP" in html2
            and "https://example.invalid/scenes/scene_mail" in html2):
        ok("failed mail carries scene name + error + link")
    else:
        bad("failed mail content", subj2)
    # 4. missing creds: fail closed, stamp released for retry
    del os.environ["EMAIL_DRY_RUN"]
    if notify.send("t@e.com", "Test User", {"status": "ready", "sceneId": "scene_mail", "id": "x"}) is False:
        ok("missing creds fail closed, no raise")
    else:
        bad("missing creds did not fail closed")
    store.transition("job_mail1", "failed", progress=None, errorCode="X", errorMessage="y")
    j2 = store._load("jobs.json")["job_mail1"]
    if not (j2.get("emailNotified") or {}).get("failed"):
        ok("send failure releases stamp for retry")
    else:
        bad("stamp retained after failed send", str(j2.get("emailNotified")))
    print(f"RESULT: {PASS} passed, {len(FAIL)} failed")
    shutil.rmtree(STORE, ignore_errors=True)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
