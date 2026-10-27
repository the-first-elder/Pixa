'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type * as THREE from 'three';

export interface CameraCommand {
  type: 'tween';
  position: [number, number, number];
  target: [number, number, number];
  durationMs: number;
}

export interface ViewerHandle {
  flyTo: (cmd: CameraCommand) => void;
  highlight: (positions: [number, number, number][]) => number;
  setMode: (mode: 'orbit' | 'walk') => void;
}

export type ViewerMode = 'orbit' | 'walk' | 'rooms';

export type ViewerStatus =
  | 'loading-manifest'
  | 'loading-asset'
  | 'ready'
  | 'empty'
  | 'error';

interface Manifest {
  asset: { location: string; assetType: string; format: string; meshLocation?: string | null };
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
const SceneViewer = forwardRef<ViewerHandle, { sceneId: string }>(function SceneViewer(
  { sceneId },
  ref,
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<(cmd: CameraCommand) => void>(() => {});
  const highlightRef = useRef<(positions: [number, number, number][]) => number>(() => 0);
  const [status, setStatus] = useState<ViewerStatus>('loading-manifest');
  const [detail, setDetail] = useState<string>('');
  const [mode, setModeState] = useState<ViewerMode>('orbit');
  const [meshReady, setMeshReady] = useState(false);
  const modeRef = useRef<ViewerMode>('orbit');
  const setModeRef = useRef<(m: ViewerMode) => void>(() => {});
  const meshReadyRef = useRef<(ready: boolean) => void>(() => {});

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

        const renderer = new THREE.WebGLRenderer({ antialias: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
        const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
        camera.position.set(3, 2, 3);
        resize();

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;

        // Walk mode: drag-look + WASD free-fly, clamped to a bounding sphere
        // around the capture volume. No collision yet (splats are not
        // colliders) — the UI labels it free-fly, not walking.
        let boundCenter = new THREE.Vector3(0, 0, 0);
        let boundRadius = 5;
        {
          const pts = (manifest.viewpoints ?? [])
            .filter((v) => v.position && v.target)
            .map((v) => new THREE.Vector3(...(v.position as [number, number, number])));
          if (pts.length > 0) {
            boundCenter = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
            boundRadius = Math.max(1.5, ...pts.map((p) => p.distanceTo(boundCenter))) * 2.2;
          }
        }
        setModeRef.current = (m: ViewerMode) => {
          if (m === 'rooms' && colliders.length === 0) return; // no proxy, no rooms
          modeRef.current = m;
          setModeState(m);
          controls.enabled = m === 'orbit';
          renderer.domElement.style.cursor = m === 'orbit' ? '' : 'crosshair';
          needsRender = true;
        };
        meshReadyRef.current = (ready: boolean) => setMeshReady(ready);

        const keys = new Set<string>();
        const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
        const onKeyDown = (e: KeyboardEvent) => {
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

        // Collision mesh (invisible proxy): raycast floor + walls for room walk.
        // Rendered with colorWrite off — never visible, always raycastable.
        const colliders: THREE.Object3D[] = [];
        let eyeOffset = Math.max(0.3, boundRadius * 0.14);
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
                  (mesh.material as THREE.Material).colorWrite = false;
                  (mesh.material as THREE.Material).depthWrite = false;
                  mesh.frustumCulled = false;
                  colliders.push(mesh);
                }
              });
              scene.add(gltf.scene);
              meshReadyRef.current(true);
              needsRender = true;
            } catch {
              // No collision mesh — rooms mode stays disabled, orbit/fly unaffected.
            }
          })();
        }

        const spark = new SparkRenderer({
          renderer,
          onDirty: () => {
            needsRender = true;
          },
        });
        scene.add(spark as unknown as THREE.Object3D);

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
            toPos: new THREE.Vector3(...cmd.position),
            fromTarget: controls.target.clone(),
            toTarget: new THREE.Vector3(...cmd.target),
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

        const mesh = new SplatMesh({
          url: manifest.asset.location,
          // API URLs carry no file extension — declare the format explicitly
          // instead of relying on URL sniffing.
          fileType:
            manifest.asset.format === 'spz'
              ? SplatFileType.SPZ
              : SplatFileType.PLY,
          onLoad: () => {
            if (cancelled) return;
            // Prefer the derived overview viewpoint (real poses); fall back
            // to the splat bounds, then to the default camera.
            const vp = (manifest.viewpoints ?? []).find(
              (v) => v.position && v.target,
            );
            if (vp?.position && vp?.target) {
              camera.position.set(...vp.position);
              controls.target.set(...vp.target);
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
        scene.add(mesh as unknown as THREE.Object3D);

        // Highlight markers: small emissive spheres at triangulated object
        // positions. These mark approximate locations, not object outlines —
        // the confirm payload says so explicitly.
        const markers = new THREE.Group();
        scene.add(markers);
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
        const walkDir = new THREE.Vector3();
        const walkRight = new THREE.Vector3();
        const walkMove = new THREE.Vector3();
        const flatDir = new THREE.Vector3();
        const raycaster = new THREE.Raycaster();
        const downDir = new THREE.Vector3(0, -1, 0);
        const tryStep = (step: THREE.Vector3): boolean => {
          // Slide along walls: full step, else x-only, else z-only, else stop.
          raycaster.set(camera.position, step.clone().normalize());
          raycaster.far = 0.3;
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
          if (modeRef.current === 'rooms' && keys.size > 0 && colliders.length > 0) {
            // Eye-level walk: horizontal camera-relative motion, wall slide,
            // floor snap. Speed scales with the scene; +/- adjusts eye height.
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
            if (walkMove.lengthSq() > 0) {
              walkMove.normalize().multiplyScalar(boundRadius * 0.45 * dt);
              if (tryStep(walkMove)) needsRender = true;
            }
            // Floor snap: stay at eye height above the mesh floor when found;
            // keep altitude over unmeshed holes instead of falling through.
            raycaster.set(camera.position, downDir);
            raycaster.far = eyeOffsetRef.current + 1.5;
            const hits = raycaster.intersectObjects(colliders, false);
            if (hits.length > 0) {
              const targetY = hits[0].point.y + eyeOffsetRef.current;
              camera.position.y += (targetY - camera.position.y) * Math.min(1, dt * 6);
              needsRender = true;
            }
            // Stay inside the capture volume.
            const off = camera.position.clone().sub(boundCenter);
            if (off.length() > boundRadius) {
              camera.position.copy(boundCenter).addScaledVector(off.normalize(), boundRadius);
              needsRender = true;
            }
          } else if (modeRef.current === 'walk' && (keys.size > 0)) {
            camera.getWorldDirection(walkDir);
            walkRight.crossVectors(walkDir, camera.up).normalize();
            walkMove.set(0, 0, 0);
            if (keys.has('KeyW') || keys.has('ArrowUp')) walkMove.add(walkDir);
            if (keys.has('KeyS') || keys.has('ArrowDown')) walkMove.sub(walkDir);
            if (keys.has('KeyD') || keys.has('ArrowRight')) walkMove.add(walkRight);
            if (keys.has('KeyA') || keys.has('ArrowLeft')) walkMove.sub(walkRight);
            if (walkMove.lengthSq() > 0) {
              walkMove.normalize().multiplyScalar(boundRadius * 0.9 * dt);
              camera.position.add(walkMove);
              // Clamp to the capture volume: free-fly, not clip-through.
              const off = camera.position.clone().sub(boundCenter);
              if (off.length() > boundRadius) {
                camera.position.copy(boundCenter).addScaledVector(off.normalize(), boundRadius);
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
          if (needsRender) {
            needsRender = false;
            renderer.render(scene, camera);
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
      {status !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="px-6 text-center text-sm text-neutral-500">
            {status === 'loading-manifest' && 'Loading scene…'}
            {status === 'loading-asset' && 'Loading 3D asset…'}
            {status === 'empty' &&
              'No reconstructed scene yet. Upload a video and run reconstruction first.'}
            {status === 'error' && `Viewer error: ${detail}`}
          </p>
        </div>
      )}
      {status === 'ready' && (
        <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-md bg-black/60 px-1 py-1 text-xs">
          <button
            type="button"
            onClick={() => setModeRef.current('orbit')}
            className={`rounded px-2 py-1 ${mode === 'orbit' ? 'bg-white text-black' : 'text-neutral-300'}`}
          >
            Orbit
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
            <span className="px-2 text-neutral-500">drag to look · WASD to move · free-fly, no collision</span>
          )}
          {mode === 'rooms' && (
            <span className="px-2 text-neutral-500">drag to look · WASD to walk · +/− eye height · experimental proxy collision</span>
          )}
        </div>
      )}
    </div>
  );
});

export default SceneViewer;
