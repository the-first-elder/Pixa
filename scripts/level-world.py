#!/usr/bin/env python3
"""Estimate world-up correction from the COLMAP sparse point cloud (stdlib only).

RANSAC for the dominant near-horizontal plane; correction quaternion rotates
its normal to +Y. Writes index.<scene>.upCorrection = {"quaternion": [x,y,z,w]}.
A weak consensus (<10% inliers) yields null (no correction) rather than a guess.
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
    if best is None or best[1] < 0.10 * len(S):
        print("No confident floor plane (inliers %d/%d); no correction." %
              ((best[1] if best else 0), len(S)))
        return 0
    (nx, ny, nz), count = best
    # Quaternion rotating n -> +Y. Rotation axis = n x Y = (-nz, 0, nx),
    # angle = angle between n and +Y. (Sign matters: the opposite axis with
    # a positive angle doubles the tilt instead of removing it.)
    ax, ay, az = -nz, 0.0, nx
    axis_len = math.sqrt(ax * ax + ay * ay + az * az)
    ang = math.acos(max(-1.0, min(1.0, ny)))
    if axis_len < 1e-9:
        quat = [0.0, 0.0, 0.0, 1.0] if ny > 0 else [1.0, 0.0, 0.0, 0.0]
    else:
        ax, ay, az = ax / axis_len, ay / axis_len, az / axis_len
        s = math.sin(ang / 2)
        quat = [ax * s, ay * s, az * s, math.cos(ang / 2)]
    index_path = os.path.join(STORAGE, "index", "%s.json" % scene_id)
    index = json.load(open(index_path))
    index["upCorrection"] = {
        "quaternion": quat,
        "floorInliers": count,
        "floorTiltDeg": round(math.degrees(ang), 1),
        "method": "ransac-floor-plane-v1",
    }
    json.dump(index, open(index_path, "w"), indent=2)
    print("tilt %.1f deg, inliers %d/%d -> upCorrection written" %
          (math.degrees(ang), count, len(S)))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--scene":
        print("Usage: level-world.py --scene <id>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[2]))
