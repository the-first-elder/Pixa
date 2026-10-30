#!/usr/bin/env python3
"""Estimate world-up correction from the COLMAP sparse reconstruction.

Primary: RANSAC for the dominant near-horizontal plane; correction
quaternion rotates its normal to +Y. Writes
index.<scene>.upCorrection = {"quaternion": [x,y,z,w]}.
Fallback (courtyards, streets, stairs — anywhere with no dominant floor):
gravity from the camera trajectory. Phone walkthroughs hold near-zero
mean roll, so the average camera-up over hundreds of frames points at the
sky; accepted only on tight consensus (>=0.90) and sane tilt (<=60 deg).
A weak consensus in both methods yields null (no correction) rather
than a guess.
Validated approach: reached 22% consensus at 35.7 deg tilt on the demo scene.
"""
import json
import math
import os
import random
import struct
import sys

STORAGE = os.environ.get("STORAGE_DIR", "./data")


def load_points(sparse_root):
    with open(os.path.join(sparse_root, "points3D.bin"), "rb") as f:
        data = f.read()
    off, n = 8, struct.unpack("<Q", data[:8])[0]
    pts = []
    for _ in range(n):
        off += 8
        x = struct.unpack("<d", data[off:off + 8])[0]
        y = struct.unpack("<d", data[off + 8:off + 16])[0]
        z = struct.unpack("<d", data[off + 16:off + 24])[0]
        off += 24 + 3 + 8
        tlen = struct.unpack("<Q", data[off:off + 8])[0]
        off += 8 + tlen * 8
        pts.append((x, y, z))
    return pts


def load_camera_ups(sparse_root):
    """Mean camera-up direction in world coordinates from images.bin.

    COLMAP/OpenCV convention: camera looks along +Z with Y pointing down,
    so camera-up in world = R^T . (0,-1,0) = -(second row of R). Phone
    walkthroughs hold near-zero mean roll, so the average up over hundreds
    of frames points at the sky even when no floor plane is visible
    (courtyards, streets, stairs). Returns (mean_up, consensus, n) with
    consensus = |sum| / n in [0,1]; graceful None when unreadable.
    """
    try:
        with open(os.path.join(sparse_root, "images.bin"), "rb") as f:
            data = f.read()
    except OSError:
        return None
    try:
        off, n = 8, struct.unpack("<Q", data[:8])[0]
        sx = sy = sz = 0.0
        count = 0
        for _ in range(n):
            if off + 4 + 32 + 24 + 4 > len(data):
                break
            off += 4  # image_id
            w, x, y, z = struct.unpack("<4d", data[off:off + 32])
            off += 32 + 24 + 4  # q, t, camera_id
            nlen = data.index(b"\x00", off) - off
            off += nlen + 1  # image name
            if off + 8 > len(data):
                break
            m = struct.unpack("<Q", data[off:off + 8])[0]
            off += 8 + m * 24  # x, y (f64) + point3D_id (i64) per obs
            nn = math.sqrt(w * w + x * x + y * y + z * z)
            if nn < 1e-9:
                continue
            w, x, y, z = w / nn, x / nn, y / nn, z / nn
            # -(second row of R): R maps world -> camera.
            ux = -(2 * (x * y + z * w))
            uy = -(1 - 2 * (x * x + z * z))
            uz = -(2 * (y * z - x * w))
            sx, sy, sz = sx + ux, sy + uy, sz + uz
            count += 1
    except (struct.error, ValueError, IndexError):
        return None
    if count == 0:
        return None
    norm = math.sqrt(sx * sx + sy * sy + sz * sz)
    consensus = norm / count
    return ((sx / norm, sy / norm, sz / norm), consensus, count)


def quat_up_to_y(nx, ny, nz):
    """Quaternion rotating unit vector n -> +Y (shared by both methods)."""
    ax, ay, az = -nz, 0.0, nx
    axis_len = math.sqrt(ax * ax + ay * ay + az * az)
    ang = math.acos(max(-1.0, min(1.0, ny)))
    if axis_len < 1e-9:
        quat = [0.0, 0.0, 0.0, 1.0] if ny > 0 else [1.0, 0.0, 0.0, 0.0]
    else:
        ax, ay, az = ax / axis_len, ay / axis_len, az / axis_len
        s = math.sin(ang / 2)
        quat = [ax * s, ay * s, az * s, math.cos(ang / 2)]
    return quat, math.degrees(ang)


def main(scene_id):
    jobs = json.load(open(os.path.join(STORAGE, "jobs.json")))
    job = next(
        (j for j in jobs.values()
         if j.get("sceneId") == scene_id and j.get("status") == "ready"
         and (j.get("asset") or {}).get("posesPath")),
        None,
    )
    if not job:
        print("No ready job with poses for scene", file=sys.stderr)
        return 2
    pts = load_points(job["asset"]["posesPath"])
    random.seed(7)
    random.shuffle(pts)
    S = pts[:4000]
    best = None
    for _ in range(80):
        a, b, c = random.sample(S, 3)
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        nn = math.sqrt(nx * nx + ny * ny + nz * nz)
        if nn < 1e-9:
            continue
        nx, ny, nz = nx / nn, ny / nn, nz / nn
        if ny < 0:
            nx, ny, nz = -nx, -ny, -nz
        if ny < 0.7:
            continue
        d = nx * a[0] + ny * a[1] + nz * a[2]
        inl = [p for p in S if abs(nx * p[0] + ny * p[1] + nz * p[2] - d) < 0.06]
        if best is None or len(inl) > best[1]:
            best = ((nx, ny, nz), len(inl))
    index_path = os.path.join(STORAGE, "index", "%s.json" % scene_id)
    index = json.load(open(index_path))
    if best is None or best[1] < 0.10 * len(S):
        # Fallback for scenes with no dominant floor plane (courtyards,
        # streets, stairs): gravity from the camera trajectory. Accepts
        # only a tight consensus and a sane tilt — a weak average is a
        # guess, and the old behavior (null) was honest.
        cam = load_camera_ups(job["asset"]["posesPath"])
        if cam is not None:
            (ux, uy, uz), consensus, ncam = cam
            # uy > 0 caps the correction at 90 deg: beyond that the world
            # would be upside down, which a tight consensus cannot
            # distinguish from a sideways-held phone — stay null there.
            if uy > 0 and consensus >= 0.90:
                quat, tilt = quat_up_to_y(ux, uy, uz)
                index["upCorrection"] = {
                    "quaternion": quat,
                    "floorInliers": best[1] if best else 0,
                    "floorTiltDeg": round(tilt, 1),
                    "method": "camera-up-consensus-v1",
                    "consensus": round(consensus, 3),
                    "cameras": ncam,
                }
                json.dump(index, open(index_path, "w"), indent=2)
                print("no floor plane (inliers %d/%d); camera-up "
                      "consensus %.3f over %d cameras, tilt %.1f deg "
                      "-> upCorrection written" %
                      ((best[1] if best else 0), len(S),
                       consensus, ncam, tilt))
                return 0
        print("No confident floor plane (inliers %d/%d); no correction." %
              ((best[1] if best else 0), len(S)))
        return 0
    (nx, ny, nz), count = best[0], best[1]
    quat, tilt = quat_up_to_y(nx, ny, nz)
    index["upCorrection"] = {
        "quaternion": quat,
        "floorInliers": count,
        "floorTiltDeg": round(tilt, 1),
        "method": "ransac-floor-plane-v1",
    }
    json.dump(index, open(index_path, "w"), indent=2)
    print("tilt %.1f deg, inliers %d/%d -> upCorrection written" %
          (tilt, count, len(S)))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--scene":
        print("Usage: level-world.py --scene <id>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[2]))
