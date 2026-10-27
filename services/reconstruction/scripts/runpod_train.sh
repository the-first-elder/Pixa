#!/usr/bin/env bash
# Run INSIDE a RunPod RTX 3090 pod (PyTorch/CUDA template, nerfstudio installed).
# Usage: ./runpod_train.sh /workspace/frames /workspace/out
# Input: frames-B dir (2 fps, ≤1600px). Output: splat.ply + transforms.json + diagnostics.
set -euo pipefail
FRAMES="${1:?frames dir required}"
OUT="${2:?output dir required}"
mkdir -p "$OUT"

echo "[1/3] COLMAP poses via ns-process-data..."
ns-process-data video --data "$OUT/ns-data" --input-path "$FRAMES" --output-dir "$OUT/ns-data" --matching-method exhaustive --num-frames-target 300 2>&1 | tee "$OUT/process.log" || \
ns-process-data images --data "$OUT/ns-data" --images-path "$FRAMES" --output-dir "$OUT/ns-data" 2>&1 | tee "$OUT/process.log"

echo "[2/3] train splatfacto (30k iters)..."
ns-train splatfacto --data "$OUT/ns-data" --output-dir "$OUT/ckpt" --max-num-iterations 30000 --viewer.quit-on-train-completion True 2>&1 | tee "$OUT/train.log"

CFG="$(ls -t "$OUT/ckpt"/*/splatfacto/*/config.yml | head -1)"
echo "[3/3] export gaussian-splat..."
ns-export gaussian-splat --load-config "$CFG" --output-dir "$OUT/export" 2>&1 | tee "$OUT/export.log"

cp "$OUT/export"/splat.ply "$OUT/splat.ply" 2>/dev/null || cp "$OUT/export"/*.ply "$OUT/splat.ply"
cp "$OUT/ns-data/transforms.json" "$OUT/transforms.json"
echo "DONE: $OUT/splat.ply + $OUT/transforms.json"
ls -la "$OUT"
