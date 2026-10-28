/**
 * Shared collision-mesh raycasting (single source of truth). Used by
 * register-entities.mts (mesh-anchored positions) and verify-registration.mts
 * (occlusion-aware scoring). Poses live in the WORLD frame, the mesh in the
 * TRAIN frame; scene_transform.json bridges them (read from the job outputs).
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import type { Vec3 } from './colmap-utils.mts';

export interface MeshAnchor {
  /** First surface hit along the WORLD-frame ray, in WORLD coords. */
  raycast: (origin: Vec3, dir: Vec3) => Vec3 | null;
}

export async function loadMeshAnchor(storage: string, sceneId: string, sparseDir: string): Promise<MeshAnchor | null> {
  const meshPath = join(storage, 'assets', sceneId, 'mesh.glb');
  if (!existsSync(meshPath)) return null;
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(readFileSync(meshPath).buffer as ArrayBuffer, '');
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  if (meshes.length === 0) throw new Error('no mesh primitives');
  (THREE.Mesh.prototype as unknown as { raycast: unknown }).raycast = acceleratedRaycast;
  const bvhMeshes = meshes.map((m) => {
    const mesh = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial());
    mesh.geometry.boundsTree = new MeshBVH(m.geometry);
    mesh.updateMatrixWorld();
    return mesh;
  });
  let w2t = new THREE.Matrix4(), t2w = new THREE.Matrix4();
  const outRoot = join(sparseDir, '..', '..', '..', 'outputs');
  if (existsSync(outRoot)) {
    for (const d of readdirSync(outRoot)) {
      const tf = join(outRoot, d, 'scene_transform.json');
      if (existsSync(tf)) {
        const st = JSON.parse(readFileSync(tf, 'utf8')) as {
          train_from_world: { matrix_4x4_flat_row_major: number[] };
          world_from_train: { matrix_4x4_flat_row_major: number[] };
        };
        w2t = new THREE.Matrix4().fromArray(st.train_from_world.matrix_4x4_flat_row_major);
        t2w = new THREE.Matrix4().fromArray(st.world_from_train.matrix_4x4_flat_row_major);
        break;
      }
    }
  }
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  return {
    raycast: (origin: Vec3, dir: Vec3): Vec3 | null => {
      const o = new THREE.Vector3(...origin).applyMatrix4(w2t);
      const dd = new THREE.Vector3(...dir).transformDirection(w2t);
      raycaster.set(o, dd);
      raycaster.near = 0;
      raycaster.far = Infinity;
      let best: THREE.Vector3 | null = null;
      for (const m of bvhMeshes) {
        const hits = raycaster.intersectObject(m, false);
        if (hits.length > 0 && (!best || hits[0].distance < o.distanceTo(best))) {
          best = hits[0].point.clone();
        }
      }
      if (!best) return null;
      const w = best.applyMatrix4(t2w);
      return [w.x, w.y, w.z];
    },
  };
}
