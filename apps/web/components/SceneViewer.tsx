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
}

export type ViewerStatus =
  | 'loading-manifest'
  | 'loading-asset'
  | 'ready'
  | 'empty'
  | 'error';

interface Manifest {
  asset: { location: string; assetType: string; format: string };
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

  useImperativeHandle(ref, () => ({
    flyTo: (cmd: CameraCommand) => flyRef.current(cmd),
    highlight: (positions: [number, number, number][]) => highlightRef.current(positions),
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

        let needsRender = true;
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
        const loop = () => {
          if (cancelled) return;
          raf = requestAnimationFrame(loop);
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
    </div>
  );
});

export default SceneViewer;
