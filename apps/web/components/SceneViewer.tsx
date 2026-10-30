'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type * as THREE from 'three';
import AssetLoader from './AssetLoader';

export interface CameraCommand {
  type: 'tween';
  position: [number, number, number];
  target: [number, number, number];
  durationMs: number;
}

export interface ViewerHandle {
  flyTo: (cmd: CameraCommand) => void;
  highlight: (positions: [number, number, number][]) => number;
  setMode: (mode: ViewerMode) => void;
}

export type ViewerMode = 'orbit' | 'walk' | 'rooms';

export type ViewerStatus =
  | 'loading-manifest'
  | 'loading-asset'
  | 'ready'
  | 'empty'
  | 'error';

interface Manifest {
  asset: {
    location: string;
    assetType: string;
    format: string;
    meshLocation?: string | null;
    sizeBytes?: number | null;
  };
  upCorrection?: { quaternion: [number, number, number, number] } | null;
  viewpoints: Array<{
    id: string;
    position: [number, number, number] | null;
    target: [number, number, number] | null;
  }>;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Real 3D viewport: SparkRenderer + SplatMesh (Three.js), OrbitControls,
 * programmatic camera tweens. Manifest-driven; with no ready asset it shows
 * an honest empty state — never a substitute scene.
 */
const SceneViewer = forwardRef<ViewerHandle, { sceneId: string; initialViewpointId?: string; drift?: boolean }>(function SceneViewer(
  { sceneId, initialViewpointId, drift },
  ref,
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<(cmd: CameraCommand) => void>(() => {});
  const highlightRef = useRef<(positions: [number, number, number][]) => number>(() => 0);
  const eyeActionRef = useRef<(action: 'up' | 'down' | 'reset') => void>(() => {});
  const joyRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const [joyKnob, setJoyKnob] = useState({ x: 0, y: 0 });
  const [status, setStatus] = useState<ViewerStatus>('loading-manifest');
  const [detail, setDetail] = useState<string>('');
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [parsing, setParsing] = useState(false);
  const [mode, setModeState] = useState<ViewerMode>('orbit');
  const [meshReady, setMeshReady] = useState(false);
  const modeRef = useRef<ViewerMode>('orbit');
  const setModeRef = useRef<(m: ViewerMode) => void>(() => {});
  const meshReadyRef = useRef<(ready: boolean) => void>(() => {});
  const snapRef = useRef<() => void>(() => {});

  useImperativeHandle(ref, () => ({
    flyTo: (cmd: CameraCommand) => flyRef.current(cmd),
    highlight: (positions: [number, number, number][]) => highlightRef.current(positions),
    setMode: (m: ViewerMode) => setModeRef.current(m),
  }));

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    async function init() {
      const mount = mountRef.current;
      if (!mount) return;
      try {
        const res = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}`);
        if (!res.ok) throw new Error(`Scene lookup failed (${res.status})`);
        const data = (await res.json()) as { manifest: Manifest | null };
        const manifest = data.manifest;
        if (cancelled) return;
        if (!manifest) {
          setStatus('empty');
          return;
        }
        setStatus('loading-asset');

        const THREE = await import('three');
        const { OrbitControls } = await import(
          'three/examples/jsm/controls/OrbitControls.js'
        );
        const { SparkRenderer, SplatMesh, SplatFileType } = await import(
          '@sparkjsdev/spark',
        );        if (cancelled) return;

        const renderer = new THREE.WebGLRenderer({
          antialias: false,
          powerPreference: 'high-performance',
          stencil: false,
        });
        // Adaptive resolution: start at full quality (DPR<=2). Only step
        // down if rendered frames are genuinely expensive, and recover
        // when headroom returns — quality is the default, not a sacrifice.
        const maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        let pixelRatioCap = maxPixelRatio;
        renderer.setPixelRatio(pixelRatioCap);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
        const resize = () => {
          const w = mount.clientWidth || 1;
          const h = mount.clientHeight || 1;
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        mount.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000);
        const camera = new THREE.PerspectiveCamera(72, 1, 0.01, 1000);
        camera.position.set(3, 2, 3);
        resize();

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        // Showcase drift: slow auto-orbit for embeds. Disabled automatically
        // under prefers-reduced-motion.
        if (drift && typeof window !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          controls.autoRotate = true;
          controls.autoRotateSpeed = 0.5;
        }

        // Walk mode: drag-look + WASD free-fly, clamped to a bounding sphere
        // around the capture volume. No collision yet (splats are not
        // colliders) — the UI labels it free-fly, not walking.
        let boundCenter = new THREE.Vector3(0, 0, 0);
        let boundRadius = 5;
        let eyeOffsetBase = 0.3;
        {
          const pts = (manifest.viewpoints ?? [])
            .filter((v) => v.position && v.target)
            .map((v) => new THREE.Vector3(...(v.position as [number, number, number])));
          if (pts.length > 0) {
            const mean = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
            boundRadius = Math.max(1.5, ...pts.map((p) => p.distanceTo(mean))) * 2.2;
            // Bounds live in the levelled world frame (camera space).
            boundCenter = mean.applyQuaternion(
              manifest.upCorrection
                ? new THREE.Quaternion(...manifest.upCorrection.quaternion)
                : new THREE.Quaternion(),
            );
            eyeOffsetBase = Math.max(0.3, (boundRadius / 2.2) * 0.3);
          }
        }
        // Confined environment: orbiting can pull back to see the whole
        // captured volume, never beyond it into the black void.
        controls.minDistance = 0.05;
        controls.maxDistance = boundRadius;
        setModeRef.current = (m: ViewerMode) => {
          if (m === 'rooms' && colliders.length === 0) return; // no proxy, no rooms
          if (m === 'rooms' && modeRef.current !== 'rooms') snapRef.current();
          modeRef.current = m;
          setModeState(m);
          controls.enabled = m === 'orbit';
          renderer.domElement.style.cursor = m === 'orbit' ? '' : 'crosshair';
          needsRender = true;
        };
        meshReadyRef.current = (ready: boolean) => setMeshReady(ready);

        const keys = new Set<string>();
        const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyC'];
        const onKeyDown = (e: KeyboardEvent) => {
          // Never hijack typing: chat input, buttons, and text fields keep keys.
          const t = e.target as HTMLElement | null;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
          if (modeRef.current !== 'walk' && modeRef.current !== 'rooms') return;
          if (MOVE_KEYS.includes(e.code)) {
            keys.add(e.code);
            e.preventDefault();
          }
          if (modeRef.current === 'rooms' && (e.code === 'Equal' || e.code === 'Minus')) {
            eyeOffsetRef.current = Math.max(0.05, eyeOffsetRef.current + (e.code === 'Equal' ? 0.05 : -0.05));
            needsRender = true;
          }
        };
        const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        let needsRender = true;

        // Levelled world: splats, collision proxy, and markers live inside a
        // rotated group (COLMAP frame); the camera stays in the levelled root
        // frame. Backend positions are never rewritten — only the view is.
        const worldGroup = new THREE.Group();
        if (manifest.upCorrection) {
          const q = manifest.upCorrection.quaternion;
          worldGroup.quaternion.set(q[0], q[1], q[2], q[3]);
        }
        scene.add(worldGroup);
        const toWorld = (p: readonly [number, number, number]): THREE.Vector3 =>
          new THREE.Vector3(p[0], p[1], p[2]).applyQuaternion(worldGroup.quaternion);

        // Collision mesh (invisible proxy): raycast floor + walls for room walk.
        // Rendered with colorWrite off — never visible, always raycastable.
        const colliders: THREE.Object3D[] = [];
        let eyeOffset = eyeOffsetBase;
        const eyeOffsetRef = { current: eyeOffset };
        if (manifest.asset.meshLocation) {
          (async () => {
            try {
              const { GLTFLoader } = await import(
                'three/examples/jsm/loaders/GLTFLoader.js'
              );
              const gltf = await new GLTFLoader().loadAsync(manifest.asset.meshLocation as string);
              gltf.scene.traverse((o) => {
                const mesh = o as THREE.Mesh;
                if (mesh.isMesh) {
                  const mat = mesh.material as THREE.Material;
                  mesh.userData.origFlags = { colorWrite: mat.colorWrite, depthWrite: mat.depthWrite };
                  mat.colorWrite = false;
                  mat.depthWrite = false;
                  mesh.frustumCulled = false;
                  colliders.push(mesh);
                }
              });
              worldGroup.add(gltf.scene);
              meshReadyRef.current(true);              needsRender = true;
            } catch {
              // No collision mesh — rooms mode stays disabled, orbit/fly unaffected.
            }
          })();
        }

        // Large scenes get Spark's LOD tree (distance-appropriate detail,
        // full detail near the camera); small scenes render directly.
        const useLod = (manifest.asset.sizeBytes ?? 0) >= 16 * 1024 * 1024;
        const spark = new SparkRenderer({
          renderer,
          enableLod: useLod,
          lodSplatScale: 1.0,
          lodRenderScale: 1.0,
          onDirty: () => {
            needsRender = true;
          },
        });
        worldGroup.add(spark as unknown as THREE.Object3D);

        interface Tween {
          fromPos: THREE.Vector3;
          toPos: THREE.Vector3;
          fromTarget: THREE.Vector3;
          toTarget: THREE.Vector3;
          start: number;
          duration: number;
        }
        let tween: Tween | null = null;
        controls.addEventListener('start', () => {
          tween = null;
        });
        flyRef.current = (cmd: CameraCommand) => {
          if (modeRef.current !== 'orbit') setModeRef.current('orbit');
          tween = {
            fromPos: camera.position.clone(),
            toPos: toWorld(cmd.position),
            fromTarget: controls.target.clone(),
            toTarget: toWorld(cmd.target),
            start: performance.now(),
            duration: Math.max(1, cmd.durationMs),
          };
          needsRender = true;
        };

        // Drag-look for walk mode (OrbitControls is disabled there).
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        const euler = new THREE.Euler(0, 0, 0, 'YXZ');
        const onPointerDown = (e: PointerEvent) => {
          if (modeRef.current !== 'walk' && modeRef.current !== 'rooms') return;
          dragging = true;
          lastX = e.clientX;
          lastY = e.clientY;
        };
        const onPointerMove = (e: PointerEvent) => {
          if (!dragging || (modeRef.current !== 'walk' && modeRef.current !== 'rooms')) return;
          const dx = e.clientX - lastX;
          const dy = e.clientY - lastY;
          lastX = e.clientX;
          lastY = e.clientY;
          euler.setFromQuaternion(camera.quaternion);
          euler.y -= dx * 0.0032;
          euler.x = Math.max(-1.45, Math.min(1.45, euler.x - dy * 0.0032));
          camera.quaternion.setFromEuler(euler);
          needsRender = true;
        };
        const onPointerUp = () => {
          dragging = false;
        };
        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);

        // Pointer-lock look for walk/rooms on precise pointers: click the
        // canvas to capture the mouse (Esc releases). Drag-look above stays
        // as the touch fallback.
        const onCanvasClick = () => {
          if (
            (modeRef.current === 'walk' || modeRef.current === 'rooms') &&
            window.matchMedia('(pointer: fine)').matches
          ) {
            renderer.domElement.requestPointerLock?.();
          }
        };
        const onLockMove = (e: MouseEvent) => {
          if (document.pointerLockElement !== renderer.domElement) return;
          if (modeRef.current !== 'walk' && modeRef.current !== 'rooms') return;
          euler.setFromQuaternion(camera.quaternion);
          euler.y -= e.movementX * 0.0022;
          euler.x = Math.max(-1.45, Math.min(1.45, euler.x - e.movementY * 0.0022));
          camera.quaternion.setFromEuler(euler);
          needsRender = true;
        };
        renderer.domElement.addEventListener('click', onCanvasClick);
        document.addEventListener('mousemove', onLockMove);

        // Spark streams the asset itself (its loader reports byte progress):
        // no manual Blob copy, so peak memory stays near the decoded scene
        // instead of raw bytes + decoded splats. API URLs carry no file
        // extension — declare the format explicitly, never URL sniffing.
        if (!cancelled) {
          setLoadProgress({ loaded: 0, total: manifest.asset.sizeBytes ?? 0 });
        }
        const mesh = new SplatMesh({
          url: manifest.asset.location,
          withCredentials: true,
          fileType:
            manifest.asset.format === 'spz'
              ? SplatFileType.SPZ
              : SplatFileType.PLY,
          lod: useLod ? 'quality' : undefined,
          enableLod: useLod,
          onProgress: (event) => {
            if (cancelled) return;
            const total = event.total || manifest.asset.sizeBytes || 0;
            setLoadProgress({ loaded: event.loaded, total });
            if (total > 0 && event.loaded >= total) setParsing(true);
          },
          onLoad: () => {
            if (cancelled) return;
            // Shared-link starting viewpoint wins; else the first derived
            // viewpoint; else splat-bounds fallback, else default camera.
            const vps = manifest.viewpoints ?? [];
            const vp = (initialViewpointId
              ? vps.find((v) => v.id === initialViewpointId && v.position && v.target)
              : undefined) ?? vps.find((v) => v.position && v.target);
            if (vp?.position && vp?.target) {
              camera.position.copy(toWorld(vp.position));
              controls.target.copy(toWorld(vp.target));
            } else {
              try {
                const geo = (mesh as unknown as { geometry?: THREE.BufferGeometry })
                  .geometry;
              const sphere =
                geo?.boundingSphere ??
                (geo?.computeBoundingSphere?.(), geo?.boundingSphere);
              if (sphere && Number.isFinite(sphere.radius) && sphere.radius > 0) {
                const r = sphere.radius;
                camera.position.set(
                  sphere.center.x + r * 1.1,
                  sphere.center.y + r * 0.7,
                  sphere.center.z + r * 1.1,
                );
                controls.target.copy(sphere.center);
                // No captured viewpoints: confine to the splat bounds
                // themselves (world frame) instead of the default sphere.
                boundCenter.copy(sphere.center).applyQuaternion(worldGroup.quaternion);
                boundRadius = Math.max(1.2, r);
                controls.maxDistance = boundRadius;
                }
              } catch {
                // Keep the default camera; user can orbit freely.
              }
            }
            setStatus('ready');
            needsRender = true;
          },
        });
        mesh.frustumCulled = false;
        worldGroup.add(mesh as unknown as THREE.Object3D);

        // Highlight markers: small emissive spheres at triangulated object
        // positions. These mark approximate locations, not object outlines —
        // the confirm payload says so explicitly.
        const markers = new THREE.Group();
        worldGroup.add(markers);
        const markerGeo = new THREE.SphereGeometry(0.035, 16, 12);
        const markerMat = new THREE.MeshBasicMaterial({ color: 0x4da3ff });
        highlightRef.current = (positions) => {
          markers.clear(); // shared geo/mat — no per-marker disposal needed
          for (const p of positions) {
            if (!p.every(Number.isFinite)) continue;
            const m = new THREE.Mesh(markerGeo, markerMat);
            m.position.set(p[0], p[1], p[2]);
            markers.add(m);
          }
          if (markers.children.length > 0) {
            const first = (markers.children[0] as THREE.Mesh).position;
            flyRef.current({
              type: 'tween',
              position: [first.x + 0.8, first.y + 0.5, first.z + 0.8],
              target: [first.x, first.y, first.z],
              durationMs: 1600,
            });
          }
          needsRender = true;
          return markers.children.length;
        };

        let raf = 0;
        let lastT = performance.now();
        let renderFrames = 0;
        let renderMsTotal = 0;
        let lastRatioAdjust = performance.now();
        const walkDir = new THREE.Vector3();
        const walkRight = new THREE.Vector3();
        const walkMove = new THREE.Vector3();
        const walkVel = new THREE.Vector3();
        const confineTmp = new THREE.Vector3();
        let bobPhase = 0;
        const flatDir = new THREE.Vector3();
        const raycaster = new THREE.Raycaster();
        const downDir = new THREE.Vector3(0, -1, 0);
        const upDir = new THREE.Vector3(0, 1, 0);
        const snapEuler = new THREE.Euler(0, 0, 0, 'YXZ');
        // Entering rooms mode drops you into a body: floor-snap to eye
        // height and level the view to horizontal, so it reads as standing
        // in the room rather than flying above it.
        snapRef.current = () => {
          if (colliders.length === 0) return;
          // Enter the body at a real captured viewpoint when arriving from
          // far outside (orbit spawn): those are proven in-room positions.
          const vps = (manifest.viewpoints ?? [])
            .filter((v) => v.position)
            .map((v) => ({
              pos: toWorld(v.position as [number, number, number]),
              tgt: v.target ? toWorld(v.target) : null,
            }));
          if (vps.length > 0) {
            let best = vps[0];
            let bestDist = Infinity;
            for (const v of vps) {
              const d = v.pos.distanceTo(camera.position);
              if (d < bestDist) {
                bestDist = d;
                best = v;
              }
            }
            if (bestDist > boundRadius * 0.35) {
              camera.position.copy(best.pos);
              if (best.tgt) camera.lookAt(best.tgt);
            }
          }
          raycaster.set(camera.position, downDir);
          raycaster.far = Math.max(3, boundRadius);
          const hits = raycaster.intersectObjects(colliders, false);
          if (hits.length > 0) {
            camera.position.y = hits[0].point.y + eyeOffsetRef.current;
          }
          snapEuler.setFromQuaternion(camera.quaternion);
          snapEuler.x = 0;
          snapEuler.z = 0;
          camera.quaternion.setFromEuler(snapEuler);
        };
        eyeActionRef.current = (action) => {
          if (action === 'reset') eyeOffsetRef.current = eyeOffsetBase;
          else {
            const step = eyeOffsetBase * 0.15 * (action === 'up' ? 1 : -1);
            eyeOffsetRef.current = Math.min(
              eyeOffsetBase * 2.5,
              Math.max(0.05, eyeOffsetRef.current + step),
            );
          }
          needsRender = true;
        };
        const tryStep = (step: THREE.Vector3): boolean => {
          // Slide along walls: full step, else x-only, else z-only, else stop.
          // Stop distance scales with eye height (~half eye height ahead).
          const stopDist = Math.max(0.05, eyeOffsetRef.current * 0.5);
          raycaster.set(camera.position, step.clone().normalize());
          raycaster.far = stopDist;
          if (raycaster.intersectObjects(colliders, false).length === 0) {
            camera.position.add(step);
            return true;
          }
          const xOnly = new THREE.Vector3(step.x, 0, 0);
          if (xOnly.lengthSq() > 0) {
            raycaster.set(camera.position, xOnly.clone().normalize());
            if (raycaster.intersectObjects(colliders, false).length === 0) {
              camera.position.add(xOnly);
              return true;
            }
          }
          const zOnly = new THREE.Vector3(0, 0, step.z);
          if (zOnly.lengthSq() > 0) {
            raycaster.set(camera.position, zOnly.clone().normalize());
            if (raycaster.intersectObjects(colliders, false).length === 0) {
              camera.position.add(zOnly);
              return true;
            }
          }
          return false;
        };
        const loop = () => {
          if (cancelled) return;
          raf = requestAnimationFrame(loop);
          const now = performance.now();
          const dt = Math.min(0.1, (now - lastT) / 1000);
          lastT = now;
          if (modeRef.current === 'rooms' && colliders.length > 0) {
            // Eye-level walk: horizontal camera-relative motion, wall slide,
            // floor snap. Runs every frame (not only while keys are held) so
            // deceleration, floor snap, and head-bob stay alive. Speed scales
            // with the scene; Shift sprints; +/- adjusts eye height.
            camera.getWorldDirection(walkDir);
            flatDir.set(walkDir.x, 0, walkDir.z);
            if (flatDir.lengthSq() < 1e-6) flatDir.set(0, 0, -1);
            flatDir.normalize();
            walkRight.crossVectors(flatDir, camera.up).normalize();
            walkMove.set(0, 0, 0);
            if (keys.has('KeyW') || keys.has('ArrowUp')) walkMove.add(flatDir);
            if (keys.has('KeyS') || keys.has('ArrowDown')) walkMove.sub(flatDir);
            if (keys.has('KeyD') || keys.has('ArrowRight')) walkMove.add(walkRight);
            if (keys.has('KeyA') || keys.has('ArrowLeft')) walkMove.sub(walkRight);
            const joy = joyRef.current;
            if (joy.active && (Math.abs(joy.x) > 0.08 || Math.abs(joy.y) > 0.08)) {
              walkMove.addScaledVector(flatDir, -joy.y).addScaledVector(walkRight, joy.x);
            }
            const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1.9 : 1;
            if (walkMove.lengthSq() > 0) {
              walkMove.normalize().multiplyScalar(boundRadius * 0.45 * sprint);
              walkVel.lerp(walkMove, Math.min(1, dt * 7));
            } else {
              // Smooth deceleration instead of an abrupt stop.
              walkVel.multiplyScalar(Math.max(0, 1 - dt * 7));
            }
            if (walkVel.lengthSq() > 1e-8) {
              const step = walkVel.clone().multiplyScalar(dt);
              if (tryStep(step)) needsRender = true;
            }
            // Subtle head-bob while moving: presence without seasickness.
            const speedNow = walkVel.length();
            if (speedNow > 0.05) bobPhase += dt * (5 + speedNow * 1.5);
            const bobY = Math.sin(bobPhase) * eyeOffsetRef.current * 0.02 * Math.min(1, speedNow);
            // Floor snap: stay at eye height above the mesh floor when found;
            // keep altitude over unmeshed holes instead of falling through.
            raycaster.set(camera.position, downDir);
            raycaster.far = eyeOffsetRef.current + 1.5;
            const hits = raycaster.intersectObjects(colliders, false);
            if (hits.length > 0) {
              const targetY = hits[0].point.y + eyeOffsetRef.current + bobY;
              camera.position.y += (targetY - camera.position.y) * Math.min(1, dt * 6);
              needsRender = true;
            }
            // Ceiling clamp: never rise through the ceiling in first person.
            // Uses the collision mesh; unknown overhead stays passable rather
            // than inventing a barrier.
            raycaster.set(camera.position, upDir);
            raycaster.far = eyeOffsetRef.current + 0.6;
            const overhead = raycaster.intersectObjects(colliders, false);
            if (overhead.length > 0) {
              const capY = overhead[0].point.y - 0.18;
              if (camera.position.y > capY) {
                camera.position.y = capY;
                needsRender = true;
              }
            }
            // Stay inside the capture volume.
            const off = camera.position.clone().sub(boundCenter);
            if (off.length() > boundRadius) {
              camera.position.copy(boundCenter).addScaledVector(off.normalize(), boundRadius);
              needsRender = true;
            }
          } else if (modeRef.current === 'walk' && (keys.size > 0 || joyRef.current.active)) {
            camera.getWorldDirection(walkDir);
            walkRight.crossVectors(walkDir, camera.up).normalize();
            walkMove.set(0, 0, 0);
            if (keys.has('KeyW') || keys.has('ArrowUp')) walkMove.add(walkDir);
            if (keys.has('KeyS') || keys.has('ArrowDown')) walkMove.sub(walkDir);
            if (keys.has('KeyD') || keys.has('ArrowRight')) walkMove.add(walkRight);
            if (keys.has('KeyA') || keys.has('ArrowLeft')) walkMove.sub(walkRight);
            if (keys.has('Space')) walkMove.y += 1;
            if (keys.has('KeyC')) walkMove.y -= 1;
            const joy = joyRef.current;
            if (joy.active && (Math.abs(joy.x) > 0.08 || Math.abs(joy.y) > 0.08)) {
              walkMove.addScaledVector(walkDir, -joy.y).addScaledVector(walkRight, joy.x);
            }
            if (walkMove.lengthSq() > 0) {
              const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1.9 : 1;
              walkMove.normalize().multiplyScalar(boundRadius * 0.3 * sprint * dt);
              camera.position.add(walkMove);
              // Clamp to the capture volume: free-fly, not clip-through.
              const off = camera.position.clone().sub(boundCenter);
              if (off.length() > boundRadius) {
                camera.position.copy(boundCenter).addScaledVector(off.normalize(), boundRadius);
              }
              // Floor respect: flying may roam, but not sink through floors.
              if (colliders.length > 0) {
                raycaster.set(camera.position, downDir);
                raycaster.far = Math.max(3, boundRadius);
                const floorHits = raycaster.intersectObjects(colliders, false);
                if (floorHits.length > 0) {
                  const floorY = floorHits[0].point.y + 0.12;
                  if (camera.position.y < floorY) camera.position.y = floorY;
                }
              }
              needsRender = true;
            }
          }
          if (tween) {
            const t = Math.min(1, (performance.now() - tween.start) / tween.duration);
            const e = easeInOutCubic(t);
            camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
            controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
            if (t >= 1) tween = null;
            needsRender = true;
          }
          // OrbitControls.update() returns true when user input or damping
          // moved the camera — a frame must follow or input appears dead.
          if (controls.update()) needsRender = true;
          // CONFINED ENVIRONMENT (all modes, every frame): camera and
          // orbit target stay inside the capture volume. There is no
          // "outside the video" to fly to — no black void, ever.
          {
            const tOff = confineTmp.copy(controls.target).sub(boundCenter);
            const tMax = boundRadius * 0.55;
            if (tOff.length() > tMax) {
              controls.target.copy(boundCenter).addScaledVector(tOff.normalize(), tMax);
              needsRender = true;
            }
            const cOff = confineTmp.copy(camera.position).sub(boundCenter);
            const cMax = boundRadius * 0.98;
            if (cOff.length() > cMax) {
              camera.position.copy(boundCenter).addScaledVector(cOff.normalize(), cMax);
              needsRender = true;
            }
          }
          if (needsRender) {
            needsRender = false;
            const renderStart = performance.now();
            renderer.render(scene, camera);
            const renderMs = performance.now() - renderStart;
            renderFrames += 1;
            renderMsTotal += renderMs;
            if (renderFrames >= 45 && now - lastRatioAdjust > 1500) {
              const avg = renderMsTotal / Math.max(1, renderFrames);
              if (avg > 22 && pixelRatioCap > 1) {
                pixelRatioCap = Math.max(1, pixelRatioCap - 0.25);
                renderer.setPixelRatio(pixelRatioCap);
                resize();
                needsRender = true;
              } else if (avg < 7 && pixelRatioCap < maxPixelRatio) {
                pixelRatioCap = Math.min(maxPixelRatio, pixelRatioCap + 0.25);
                renderer.setPixelRatio(pixelRatioCap);
                resize();
                needsRender = true;
              }
              renderFrames = 0;
              renderMsTotal = 0;
              lastRatioAdjust = now;
            }
          }
        };
        loop();
        window.addEventListener('resize', resize);

        cleanup = () => {
          cancelAnimationFrame(raf);
          window.removeEventListener('resize', resize);
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('keyup', onKeyUp);
          renderer.domElement.removeEventListener('pointerdown', onPointerDown);
          window.removeEventListener('pointermove', onPointerMove);
          window.removeEventListener('pointerup', onPointerUp);
          renderer.domElement.removeEventListener('click', onCanvasClick);
          document.removeEventListener('mousemove', onLockMove);
          if (document.pointerLockElement === renderer.domElement) {
            document.exitPointerLock?.();
          }
          controls.dispose();
          markerGeo.dispose();
          markerMat.dispose();
          mesh.dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
      } catch (e) {
        if (!cancelled) {
          setStatus('error');
          setDetail(e instanceof Error ? e.message.slice(0, 200) : 'Load failed');
        }
      }
    }

    init();
    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, [sceneId]);

  return (
    <div ref={mountRef} className="relative h-full min-h-96 w-full bg-black">
      {status !== 'ready' && status !== 'loading-asset' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <p className="px-6 text-center text-sm text-neutral-500">
            {status === 'loading-manifest' && 'Loading scene…'}
            {status === 'empty' && 'Reconstruction in progress — follow the timer above.'}
            {status === 'error' && `Viewer error: ${detail}`}
          </p>
          {status === 'empty' && (
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-neutral-800">
              <div className="h-full w-1/3 animate-pulse bg-white/70" />
            </div>
          )}
        </div>
      )}
      {status === 'loading-asset' && (
        <div className="absolute inset-0">
          <AssetLoader
            loaded={loadProgress?.loaded ?? 0}
            total={loadProgress?.total ?? 0}
            parsing={parsing}
          />
        </div>
      )}
      {status === 'ready' && (
        <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-md bg-black/60 px-1 py-1 text-xs">
          <button
            type="button"
            onClick={() => setModeRef.current('orbit')}
            className={`rounded px-2 py-1 ${mode === 'orbit' ? 'bg-white text-black' : 'text-neutral-300'}`}
            title="Overview: inspect the reconstruction from outside or above"
          >
            Overview
          </button>
          <button
            type="button"
            onClick={() => setModeRef.current('walk')}
            className={`rounded px-2 py-1 ${mode === 'walk' ? 'bg-white text-black' : 'text-neutral-300'}`}
            title="Free-fly: drag to look, WASD to move"
          >
            Fly
          </button>
          <button
            type="button"
            onClick={() => meshReady && setModeRef.current('rooms')}
            disabled={!meshReady}
            className={`rounded px-2 py-1 ${mode === 'rooms' ? 'bg-white text-black' : 'text-neutral-300'} disabled:opacity-40`}
            title={meshReady ? 'Eye-level walk with walls and floor' : 'Collision mesh still building'}
          >
            Rooms
          </button>
          {mode === 'walk' && (
            <span className="px-2 text-neutral-500">click canvas for mouse-look · WASD + Space/C · Shift sprint · floors respected</span>
          )}
          {mode === 'rooms' && (
            <>
              <span className="px-2 text-neutral-500">click canvas for mouse-look · WASD walk · Shift sprint · walls + ceiling constrain</span>
              <span className="ml-1 flex items-center gap-0.5 border-l border-white/10 pl-2">
                <span className="px-1 text-neutral-500">eye</span>
                <button type="button" onClick={() => eyeActionRef.current('down')} className="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-white/10" title="Lower eye height">−</button>
                <button type="button" onClick={() => eyeActionRef.current('reset')} className="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-white/10" title="Reset eye height">⟲</button>
                <button type="button" onClick={() => eyeActionRef.current('up')} className="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-white/10" title="Raise eye height">+</button>
              </span>
            </>
          )}
        </div>
      )}
      {status === 'ready' && mode !== 'orbit' && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/60" />
      )}
      {status === 'ready' && mode !== 'orbit' && (
        <div
          className="absolute bottom-24 left-4 hidden h-28 w-28 touch-none select-none rounded-full border border-white/20 bg-black/40 [@media(pointer:coarse)]:block"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            joyRef.current.active = true;
          }}
          onPointerMove={(e) => {
            if (!joyRef.current.active) return;
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            let dx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
            let dy = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
            const len = Math.hypot(dx, dy);
            if (len > 1) {
              dx /= len;
              dy /= len;
            }
            joyRef.current.x = dx;
            joyRef.current.y = dy;
            setJoyKnob({ x: dx * 34, y: dy * 34 });
          }}
          onPointerUp={() => {
            joyRef.current = { x: 0, y: 0, active: false };
            setJoyKnob({ x: 0, y: 0 });
          }}
          onPointerCancel={() => {
            joyRef.current = { x: 0, y: 0, active: false };
            setJoyKnob({ x: 0, y: 0 });
          }}
        >
          <div
            className="absolute left-1/2 top-1/2 h-12 w-12 rounded-full bg-white/25"
            style={{ transform: `translate(calc(-50% + ${joyKnob.x}px), calc(-50% + ${joyKnob.y}px))` }}
          />
        </div>
      )}
    </div>
  );
});

export default SceneViewer;
