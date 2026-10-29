'use client';

import { useRouter } from 'next/navigation';
import { stashFile, unstashFile } from '@/lib/file-stash';
import { useEffect, useRef, useState } from 'react';
import { blurScore, brightness, frameDiff, GuideEngine, type CaptureAdvice } from '@/lib/capture-analysis';
import { buildReport, type CaptureReport, type MetricSample, type WeakMoment } from '@/lib/capture-report';
import { CompassDial, useCoverageCompass, useDeviceTilt } from './CoverageCompass';
import CaptureReportView from './CaptureReportView';
import DirectorOverlay from './DirectorOverlay';
import SignInModal from './SignInModal';

type Phase = 'idle' | 'preview' | 'recording' | 'review' | 'uploading' | 'error';

/**
 * Guided in-browser recorder: live camera + on-device meters (pace, blur,
 * light) + orientation coverage compass + review + upload into the standard
 * pipeline. The preview uses the rear camera where available.
 */
export default function CaptureRecorder() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const guideRef = useRef(new GuideEngine());
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<{ id: string; label: string }[]>([]);
  const [cameraId, setCameraId] = useState<string>('');
  const [cameraLabel, setCameraLabel] = useState<string>('');
  const [advice, setAdvice] = useState<CaptureAdvice[]>([]);
  const [meters, setMeters] = useState({ speed: 0, blur: 0, light: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pass, setPass] = useState(1);
  const [scout, setScout] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [sceneName, setSceneName] = useState('');
  const [backend, setBackend] = useState('spirula');
  const [quality, setQuality] = useState('fast');
  const [allowPartial, setAllowPartial] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  // Passes kept for a joined upload ("Keep & record another pass").
  const [passFiles, setPassFiles] = useState<File[]>([]);
  const [restoredPasses, setRestoredPasses] = useState(false);
  const [report, setReport] = useState<CaptureReport | null>(null);
  const [resolution, setResolution] = useState<{ w: number; h: number } | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const statsRef = useRef<MetricSample[]>([]);
  const eventsRef = useRef<WeakMoment[]>([]);
  const orientRef = useRef({ roll: 0, pitch: 0, sudden: 0, lastYaw: null as number | null });
  const elapsedRef = useRef(0);
  const compassRef = useRef({ supported: false, covered: [] as boolean[], lookedUp: false, lookedDown: false, uncoveredHint: null as string | null });
  const qualityOkRef = useRef(true);
  const { state: compass, requestPermission, reset: resetCompass } = useCoverageCompass(
    phase === 'recording',
    qualityOkRef.current,
  );
  const tilt = useDeviceTilt(phase === 'preview' || phase === 'recording');

  // Mirror hook/state values needed inside recorder callbacks.
  useEffect(() => {
    compassRef.current = {
      supported: compass.supported,
      covered: compass.covered,
      lookedUp: compass.lookedUp,
      lookedDown: compass.lookedDown,
      uncoveredHint: compass.uncoveredHint,
    };
  }, [compass]);

  useEffect(() => () => stopStream(), []);

  // After a sign-in redirect, restore stashed passes (one-shot). Keys are
  // capture-pending-0..N (dense); stops at the first miss, capped at 10.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const files: File[] = [];
      for (let i = 0; i < 10; i++) {
        const f = await unstashFile(i === 0 ? 'capture-pending' : `capture-pending-${i}`).catch(() => null);
        if (!f) break;
        files.push(f);
      }
      if (!cancelled && files.length > 0) {
        setPassFiles(files);
        setPass(files.length + 1);
        setRestoredPasses(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Unsaved-recording protection: recording in progress or unreviewed blob.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (phase === 'recording' || (phase === 'review' && blobRef.current)) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [phase]);

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function listCameras(): Promise<{ id: string; label: string }[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    } catch {
      return [];
    }
  }

  async function startPreview(deviceId?: string) {
    setError(null);
    // Fail fast with the true cause: no mediaDevices usually means an
    // insecure context (e.g. opened via http://<lan-ip>:3000 from a phone).
    // Cameras require localhost or HTTPS — permission alone is not enough.
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        'This page cannot access any camera (camera API unavailable). ' +
          'Most likely cause: you opened the app over plain HTTP from another device. ' +
          'Use http://localhost:3000 on this machine, or serve over HTTPS. ' +
          'Otherwise upload a file instead.',
      );
      setPhase('error');
      return;
    }
    try {
      // Labels are empty until permission is granted once; list before/after.
      let cams = await listCameras();
      if (cams.length === 0) {
        // Trigger permission to reveal labels, then re-list.
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tmp.getTracks().forEach((t) => t.stop());
        cams = await listCameras();
      }
      setCameras(cams);
      const explicit = deviceId ?? cameraId;
      const preferred =
        explicit ||
        cams.find((c) => /back|rear|environment/i.test(c.label))?.id ||
        '';
      const picked = preferred !== '' ? preferred : (cams[0]?.id ?? '');
      if (picked) setCameraId(picked);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: picked
          ? { deviceId: { exact: picked }, width: { ideal: 1280 } }
          : { facingMode: 'environment', width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      setCameraLabel(track?.label || 'camera');
      // Honest resolution readout: sub-HD sources cap reconstruction detail.
      try {
        const s = track?.getSettings();
        if (s?.width && s?.height) setResolution({ w: s.width, h: s.height });
      } catch {
        setResolution(null);
      }
      const video = videoRef.current;
      if (!video) throw new Error('Preview element missing');
      video.srcObject = stream;
      // Handshake: wait for real frames, not just a resolved play() promise.
      await new Promise<void>((resolve, reject) => {
        const to = window.setTimeout(() => reject(new Error('timeout')), 8000);
        video.onloadedmetadata = () => {
          video.play().then(() => {
            // Confirm frames actually flow.
            const check = window.setInterval(() => {
              if (video.videoWidth > 0 && video.readyState >= 2) {
                window.clearInterval(check);
                window.clearTimeout(to);
                resolve();
              }
            }, 200);
          }).catch((e: unknown) => {
            window.clearTimeout(to);
            reject(e instanceof Error ? e : new Error('play failed'));
          });
        };
      });
      setPhase('preview');
      // Starter guidance so the panel is never empty.
      setAdvice([{ level: 'good', kind: 'good', message: 'Camera live. Tap Record, then walk slowly around one room.' }]);
    } catch (e) {
      stopStream();
      setError(cameraErrorMessage(e));
      setPhase('error');
    }
  }

  /** Map getUserMedia failures to actionable messages (names, not guesses). */
  function cameraErrorMessage(e: unknown): string {
    const name = e instanceof DOMException ? e.name : e instanceof Error ? e.message : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Camera permission was denied for this page. Allow it in the browser site settings, then try again — or upload a file instead.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No camera device was found. If one exists, another app may hold it — or upload a file instead.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The camera is busy or failed to start (often another app or tab holds it). Close other camera apps and retry — or upload a file.';
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return 'The requested camera mode is not supported by this device. Try another camera below, or upload a file.';
    }
    if (name === 'SecurityError') {
      return 'Blocked for security: camera needs localhost or HTTPS. Reopen via http://localhost:3000 or HTTPS — or upload a file.';
    }
    if (name === 'timeout') {
      return 'Camera opened but delivered no frames. Try another camera below, another browser, or HTTPS/localhost.';
    }
    return 'Camera unavailable. Check browser permissions, or upload a file instead.';
  }

  /** Log a weak moment (merges with the previous event if same kind + close). */
  function logEvent(kind: WeakMoment['kind'], label: string, at: number, span = 1.5) {
    const evts = eventsRef.current;
    const last = evts[evts.length - 1];
    if (last && last.kind === kind && at - last.end < 3) {
      last.end = at + span;
    } else {
      evts.push({ start: at, end: at + span, kind, label });
      if (evts.length > 40) evts.shift();
    }
  }

  function analyzeLoop() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const W = 160;
    const H = Math.max(1, Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * W));
    canvas.width = W;
    canvas.height = H;
    let prev: ImageData | null = null;
    const t0 = Date.now();
    const timer = window.setInterval(() => {
      if (!streamRef.current || video.readyState < 2) return;
      try {
        ctx.drawImage(video, 0, 0, W, H);
        const curr = ctx.getImageData(0, 0, W, H);
        const speed = prev ? frameDiff(prev, curr) : 0;
        prev = curr;
        const blur = blurScore(curr);
        const light = brightness(curr);
        setMeters({ speed: Math.round(speed), blur: Math.round(blur), light: Math.round(light) });
        statsRef.current.push({ t: (Date.now() - t0) / 1000, speed, blur, light });
        if (statsRef.current.length > 1500) statsRef.current.shift();
        const ok = blur >= 60 && light >= 45 && light <= 210;
        qualityOkRef.current = ok;
        const next = guideRef.current.advise({ speed, blur, light });
        setAdvice(next);
        // Weak-moment chapters for targeted re-recording (review screen).
        const t = (Date.now() - t0) / 1000;
        const labels: Record<string, string> = {
          fast: 'moving too fast',
          blur: 'blurry',
          flat: 'low detail (blank wall?)',
          dark: 'too dark',
          bright: 'overexposed',
        };
        for (const a of next) {
          const label = labels[a.kind];
          if (label) logEvent(a.kind as WeakMoment['kind'], label, t);
          // 'good'/'still' need no chapters.
        }
      } catch {
        // Frame read failed (transient) — skip this tick, never crash recording.
      }
    }, 500);
    (videoRef.current as HTMLVideoElement & { __meterTimer?: number }).__meterTimer = timer;
  }

  function stopAnalyze() {
    const t = (videoRef.current as HTMLVideoElement & { __meterTimer?: number } | null)?.__meterTimer;
    if (t) window.clearInterval(t);
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    statsRef.current = [];
    eventsRef.current = [];
    orientRef.current = { roll: 0, pitch: 0, sudden: 0, lastYaw: null };
    resetCompass();
    const mime = MediaRecorder.isTypeSupported('video/mp4')
      ? 'video/mp4'
      : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stopAnalyze();
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      blobRef.current = blob;
      setBlobUrl(URL.createObjectURL(blob));
      setReport(
        buildReport({
          samples: statsRef.current,
          durationSec: elapsedRef.current,
          estimatedBytes: Math.round((8_000_000 / 8) * elapsedRef.current),
          mimeType: recorder.mimeType,
          compass: {
            supported: compassRef.current.supported,
            sectorsCovered: compassRef.current.covered.filter(Boolean).length,
            sectorsTotal: compassRef.current.covered.length,
            lookedUp: compassRef.current.lookedUp,
            lookedDown: compassRef.current.lookedDown,
            uncoveredHint: compassRef.current.uncoveredHint,
          },
          rollWarnings: orientRef.current.roll,
          pitchWarnings: orientRef.current.pitch,
          suddenMoves: orientRef.current.sudden,
          weakMoments: [...eventsRef.current],
        }),
      );
      setPaused(false);
      setPhase('review');
    };
    recorder.start(1000);
    setElapsed(0);
    setPaused(false);
    setPhase('recording');
    analyzeLoop();
  }

  // Orientation tracking during recording: roll/pitch warnings + sudden turns.
  // Thresholds are loose heuristics (sensor axes vary); counts only, and the
  // report labels them as such rather than ground truth.
  useEffect(() => {
    if (phase !== 'recording') return;
    let rollStreak = 0;
    let pitchStreak = 0;
    const handler = (e: DeviceOrientationEvent) => {
      const { alpha, beta, gamma } = e;
      if (gamma !== null && Math.abs(gamma) > 30) {
        rollStreak++;
        if (rollStreak === 6) orientRef.current.roll++;
      } else {
        rollStreak = 0;
      }
      if (beta !== null && (beta < 25 || beta > 155)) {
        pitchStreak++;
        if (pitchStreak === 6) orientRef.current.pitch++;
      } else {
        pitchStreak = 0;
      }
      if (alpha !== null) {
        const yaw = ((alpha % 360) + 360) % 360;
        const last = orientRef.current.lastYaw;
        if (last !== null) {
          let d = Math.abs(yaw - last);
          if (d > 180) d = 360 - d;
          if (d > 50) {
            orientRef.current.sudden++;
            logEvent('turn', 'sudden turn', elapsedRef.current, 2);
          }
        }
        orientRef.current.lastYaw = yaw;
      }
    };
    window.addEventListener('deviceorientation', handler);
    return () => window.removeEventListener('deviceorientation', handler);
  }, [phase]);

  function pauseRecording() {
    recorderRef.current?.pause();
    setPaused(true);
  }

  function resumeRecording() {
    recorderRef.current?.resume();
    setPaused(false);
  }

  useEffect(() => {
    if (phase !== 'recording' || paused) return;
    const t = window.setInterval(() => {
      setElapsed((e) => {
        elapsedRef.current = e + 1;
        return e + 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [phase, paused]);

  // Server check-in: every ~25 s of recording, send 2 thumbnail frames for
  // semantic coverage hints. Cheap by design; routine checks stay on-device.
  // Failures are silent — local guidance keeps working regardless.
  useEffect(() => {
    if (phase !== 'recording') return;
    let cancelled = false;
    const send = () => {
      const canvas = canvasRef.current;
      if (!canvas || paused) return;
      canvas.toBlob(async (blob) => {
        if (!blob || cancelled) return;
        try {
          const form = new FormData();
          form.append('frames', blob, 'now.jpg');
          form.append(
            'context',
            JSON.stringify({ elapsedSec: elapsedRef.current, pass }),
          );
          const res = await fetch('/api/capture/checkin', { method: 'POST', body: form });
          if (!res.ok || cancelled) return;
          const data = (await res.json()) as { nextInstruction?: string };
          if (data.nextInstruction && !cancelled) setScout(data.nextInstruction);
        } catch {
          // Silent: on-device guidance continues.
        }
      }, 'image/jpeg', 0.7);
    };
    const t = window.setInterval(send, 25000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [phase, paused, pass]);

  function stopRecording() {
    recorderRef.current?.stop();
  }

  function discardRecording() {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobRef.current = null;
    setBlobUrl(null);
    setReport(null);
    setPhase('preview');
  }

  /** Stash the current blob plus all kept passes, then open sign-in. */
  async function sendToSignIn(ext: string) {
    const files: File[] = [...passFiles];
    if (blobRef.current) files.push(new File([blobRef.current], `capture.${ext}`, { type: blobRef.current.type }));
    let ok = true;
    for (let i = 0; i < files.length && i < 10; i++) {
      ok = (await stashFile(i === 0 ? 'capture-pending' : `capture-pending-${i}`, files[i])) && ok;
    }
    if (!ok) {
      setError('Please sign in, then select your video again.');
      setPhase('error');
      return;
    }
    setSignInOpen(true);
  }

  const iterationsFor = (q: string) => (q === 'full' ? 30000 : q === 'balanced' ? 15000 : 7000);
  const defaultName = (passes: number) =>
    `Guided capture ${new Date().toLocaleString()}${passes > 1 ? ` (${passes} passes)` : ''}`;

  async function useRecording() {
    const blob = blobRef.current;
    if (!blob) return;
    setPhase('uploading');
    setUploadProgress(0);
    setError(null);
    try {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      // Pipeline accepts mp4/mov; convert webm server-side if needed is
      // future work — for now require mp4, else fall back to file upload.
      if (ext !== 'mp4') {
        throw new Error(
          'This browser recorded WebM, which the pipeline does not accept yet. ' +
            'Please upload an MP4/MOV file instead (or use a Chromium browser).',
        );
      }
      const createRes = await fetch('/api/scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sceneName.trim() || defaultName(1) }),
      });
      if (createRes.status === 401) {
        setPhase('review');
        await sendToSignIn(ext);
        return;
      }
      if (!createRes.ok) throw new Error(`Scene creation failed (${createRes.status})`);
      const { sceneId } = (await createRes.json()) as { sceneId: string };
      // XHR (not fetch) so the upload reports progress like the file form.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/scenes/${sceneId}/upload`);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(100);
            resolve();
          } else {
            try {
              const body = JSON.parse(xhr.responseText) as { error?: string };
              reject(new Error(body.error ?? `Upload failed (${xhr.status})`));
            } catch {
              reject(new Error(`Upload failed (${xhr.status})`));
            }
          }
        };
        xhr.onerror = () => reject(new Error('Upload connection failed'));
        const form = new FormData();
        form.append('video', blob, `capture.${ext}`);
        xhr.send(form);
      });
      await fetch(`/api/scenes/${sceneId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend, allowPartial, iterations: iterationsFor(quality) }),
      });
      stopStream();
      router.push(`/scenes/${sceneId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      setUploadProgress(null);
      setPhase('review');
    }
  }

  /** Keep the current recording and go again — passes join into one video. */
  function keepPassAndRecord() {
    const blob = blobRef.current;
    if (!blob) return;
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    setPassFiles((prev) => [...prev, new File([blob], `capture-pass-${pass}.${ext}`, { type: blob.type })]);
    discardRecording();
    setPass((p) => p + 1);
    setPhase('preview');
    startPreview();
  }

  /** Upload all kept passes + the current recording as ONE joined scene. */
  async function useJoinedRecording() {
    const blob = blobRef.current;
    const all = [...passFiles];
    if (blob) {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      all.push(new File([blob], `capture-pass-${pass}.${ext}`, { type: blob.type }));
    }
    if (all.length < 2) return;
    setPhase('uploading');
    setUploadProgress(0);
    setError(null);
    try {
      const createRes = await fetch('/api/scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sceneName.trim() || defaultName(all.length) }),
      });
      if (createRes.status === 401) {
        setPhase('review');
        await sendToSignIn('mp4');
        return;
      }
      if (!createRes.ok) throw new Error(`Scene creation failed (${createRes.status})`);
      const { sceneId } = (await createRes.json()) as { sceneId: string };
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/scenes/${sceneId}/passes`);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(100);
            resolve();
          } else {
            try {
              const body = JSON.parse(xhr.responseText) as { error?: string };
              reject(new Error(body.error ?? `Pass upload failed (${xhr.status})`));
            } catch {
              reject(new Error(`Pass upload failed (${xhr.status})`));
            }
          }
        };
        xhr.onerror = () => reject(new Error('Upload connection failed'));
        const form = new FormData();
        all.forEach((f, i) => form.append(`pass-${i}`, f, f.name));
        xhr.send(form);
      });
      await fetch(`/api/scenes/${sceneId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend, allowPartial, iterations: iterationsFor(quality) }),
      });
      stopStream();
      router.push(`/scenes/${sceneId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      setUploadProgress(null);
      setPhase('review');
    }
  }

  function fmt(s: number) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function fmtClock(s: number) {
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  return (
    <div className="mt-8 rounded-md border border-neutral-800 p-4">
      <h2 className="text-sm font-medium">Guided recording (beta)</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Record in the browser with live pacing, sharpness, light, and coverage guidance.
      </p>
      {phase === 'idle' && (
        <button
          type="button"
          onClick={() => startPreview()}
          className="mt-3 rounded-md bg-white px-4 py-2 text-sm font-medium text-black"
        >
          Open camera
        </button>
      )}
      {/* Always mounted so setup can attach the stream before preview shows.
          Hidden until there is something to display. */}
      <div
        className={
          phase === 'preview' || phase === 'recording' ? 'relative mt-3' : 'hidden'
        }
      >
        <video ref={videoRef} muted playsInline className="w-full rounded-md bg-black" />
        {phase === 'recording' && (
          <DirectorOverlay
            advice={advice}
            meters={meters}
            elapsed={elapsed}
            paused={paused}
            resolution={resolution}
            tilt={tilt}
            covered={compass.supported ? compass.covered : null}
          />
        )}
      </div>
      {(phase === 'preview' || phase === 'recording') && (
        <div className="mt-3">
          {cameras.length > 1 && (
            <div className="mb-2 flex items-center gap-2 text-xs text-neutral-400">
              <label htmlFor="capture-camera">Camera ({cameraLabel || 'unknown'})</label>
              <select
                id="capture-camera"
                value={cameraId}
                onChange={(e) => {
                  stopStream();
                  setPhase('idle');
                  startPreview(e.target.value);
                }}
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
              >
                {cameras.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <canvas ref={canvasRef} className="hidden" />
          {resolution && Math.max(resolution.w, resolution.h) < 1280 && (
            <p className="mt-2 rounded-md border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              Capturing at {resolution.w}×{resolution.h} — fine detail is capped by these
              pixels. For the sharpest reconstruction, record at 1080p or higher.
            </p>
          )}
          {phase === 'recording' && (
            <ShotChecklist
              sectorsCovered={compass.supported ? compass.covered.filter(Boolean).length : null}
              sectorsTotal={compass.supported ? compass.covered.length : null}
              lookedUp={compass.supported ? compass.lookedUp : null}
              lookedDown={compass.supported ? compass.lookedDown : null}
              elapsed={elapsed}
            />
          )}
          <div className="mt-2 flex items-center gap-3 text-xs text-neutral-400">
            <span>motion {meters.speed}</span>
            <span>sharp {meters.blur}</span>
            <span>light {meters.light}</span>
            {phase === 'recording' && (
              <span className="ml-auto text-red-400">
                ● {fmt(elapsed)}
                {paused ? ' (paused)' : ''} · ~{Math.max(1, Math.round(((8_000_000 / 8) * elapsed) / 1048576))} MB
              </span>
            )}
          </div>
          <div className="mt-2 space-y-1">
            {scout && phase === 'recording' && (
              <p className="text-sm text-sky-300">Scout: {scout}</p>
            )}
            {advice.map((a, i) => (
              <p
                key={i}
                className={
                  a.level === 'bad'
                    ? 'text-sm text-red-400'
                    : a.level === 'warn'
                      ? 'text-sm text-amber-400'
                      : 'text-sm text-neutral-500'
                }
              >
                {a.message}
              </p>
            ))}
          </div>
          {compass.supported && (
            <div className="mt-3 flex items-center gap-3">
              <CompassDial covered={compass.covered} />
              <div className="text-xs text-neutral-400">
                {compass.permission === 'needed' ? (
                  <button type="button" onClick={requestPermission} className="underline">
                    Enable motion sensors for direction coverage
                  </button>
                ) : (
                  <>
                    <p>White sectors filmed; dim sectors missing.</p>
                    {compass.uncoveredHint && <p className="text-amber-400">{compass.uncoveredHint}</p>}
                    {!compass.lookedUp && <p>Tip: tilt up to capture the ceiling.</p>}
                    {!compass.lookedDown && <p>Tip: tilt down to capture the floor.</p>}
                  </>
                )}
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {phase === 'preview' ? (
              <button
                type="button"
                onClick={startRecording}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white"
              >
                ● Record{pass > 1 ? ` pass ${pass}` : ''}
              </button>
            ) : (
              <>
                {!paused ? (
                  <button
                    type="button"
                    onClick={pauseRecording}
                    className="rounded-md bg-neutral-700 px-4 py-2 text-sm font-medium"
                  >
                    Pause
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={resumeRecording}
                    className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black"
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  onClick={stopRecording}
                  className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white"
                >
                  Stop
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {phase === 'review' && blobUrl && (
        <div className="mt-3">
          <p className="mb-2 rounded-md border border-white/10 bg-[#111113] px-3 py-2 text-xs text-neutral-300">
            Pass {pass} ready{passFiles.length > 0 ? ` — ${passFiles.length} earlier pass${passFiles.length === 1 ? '' : 'es'} kept` : ''}.
            Continue uploads this pass alone, or join everything into one complete video.
            {passFiles.length === 0 && ' Tip for multi-pass: end each pass looking at where the next one will start — shared views are what let the passes merge.'}
          </p>
          {restoredPasses && passFiles.length > 0 && (
            <p className="mb-2 rounded-md border border-white/10 bg-[#111113] px-3 py-2 text-xs text-neutral-300">
              {passFiles.length} stashed pass{passFiles.length === 1 ? '' : 'es'} restored after sign-in — record more or upload them joined.
            </p>
          )}
          <video src={blobUrl} controls playsInline className="w-full rounded-md bg-black" />
          <div className="mt-3 grid gap-3 rounded-md border border-neutral-800 bg-neutral-950/60 p-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="capture-scene-name" className="text-xs text-neutral-400">Scene name</label>
              <input
                id="capture-scene-name"
                value={sceneName}
                onChange={(e) => setSceneName(e.target.value)}
                placeholder={`Guided capture ${new Date().toLocaleDateString()}`}
                className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor="capture-backend" className="text-xs text-neutral-400">Reconstruction backend</label>
              <select
                id="capture-backend"
                value={backend}
                onChange={(e) => setBackend(e.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
              >
                <option value="spirula">Spirula — free, on this machine (recommended)</option>
                <option value="kiri">KIRI hosted API — spends credits (needs key)</option>
                <option value="runpod">RunPod cloud GPU — needs pod + asset</option>
              </select>
            </div>
            <div>
              <label htmlFor="capture-quality" className="text-xs text-neutral-400">Quality (training time)</label>
              <select
                id="capture-quality"
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
              >
                <option value="fast">Fast preview — ~7k iterations, minutes</option>
                <option value="balanced">Balanced — ~15k iterations</option>
                <option value="full">Full — 30k iterations, best quality (slow)</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-neutral-400 sm:col-span-2">
              <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
              Train a labeled partial preview if coverage is incomplete
            </label>
          </div>
          {report && <CaptureReportView report={report} />}
          <p className="mt-2 text-xs text-neutral-500">
            A passing report helps; it does not guarantee reconstruction. True coverage is established afterwards.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={useRecording}
              className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black"
              title="Upload only this pass as its own scene"
            >
              Continue with this recording
            </button>
            {passFiles.length > 0 && (
              <button
                type="button"
                onClick={useJoinedRecording}
                className="rounded-md bg-[#e2a63b] px-4 py-2 text-sm font-medium text-black"
                title="Join all kept passes in order into one video and one scene"
              >
                Upload {passFiles.length + 1} passes as one video
              </button>
            )}
            <button
              type="button"
              onClick={keepPassAndRecord}
              className="rounded-md border border-neutral-700 px-4 py-2 text-sm"
              title="Keep this pass and film the parts you missed — everything joins into one video"
            >
              Keep &amp; record missing areas (pass {pass + 1})
            </button>
            <button
              type="button"
              onClick={discardRecording}
              className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400"
            >
              Discard this pass
            </button>
          </div>
        </div>
      )}
      {phase === 'uploading' && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full bg-white transition-all"
              style={{ width: `${uploadProgress ?? 0}%` }}
            />
          </div>
          <p className="mt-1 text-sm text-neutral-500">
            Uploading… {uploadProgress ?? 0}%{uploadProgress === 100 && ' — starting reconstruction…'}
          </p>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} callbackUrl="/capture" />
      {(phase === 'error' || phase === 'review') && !blobUrl && phase === 'error' && (
        <button
          type="button"
          onClick={() => setPhase('idle')}
          className="mt-3 rounded-md border border-neutral-700 px-4 py-2 text-sm"
        >
          Back
        </button>
      )}
    </div>
  );
}

/** Live shot checklist: what a complete room capture needs. Nulls = no sensors. */
function ShotChecklist({
  sectorsCovered,
  sectorsTotal,
  lookedUp,
  lookedDown,
  elapsed,
}: {
  sectorsCovered: number | null;
  sectorsTotal: number | null;
  lookedUp: boolean | null;
  lookedDown: boolean | null;
  elapsed: number;
}) {
  const loopDone = sectorsCovered != null && sectorsTotal != null && sectorsCovered >= sectorsTotal;
  const loopText =
    sectorsCovered == null || sectorsTotal == null
      ? 'Full loop (no motion sensors — walk the full room anyway)'
      : `Full loop ${sectorsCovered}/${sectorsTotal} directions`;
  const items: { done: boolean | null; text: string }[] = [
    { done: loopDone, text: loopText },
    { done: lookedUp, text: 'Tilt up — ceiling' },
    { done: lookedDown, text: 'Tilt down — floor' },
    { done: elapsed >= 30, text: 'At least 30 seconds' },
  ];
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Capture checklist">
      {items.map((it, i) => (
        <span
          key={i}
          className={`rounded-full border px-2.5 py-1 text-[11px] ${
            it.done === true
              ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
              : it.done === false
                ? 'border-neutral-700 text-neutral-400'
                : 'border-neutral-800 text-neutral-500'
          }`}
        >
          {it.done === true ? '✓ ' : it.done === false ? '○ ' : '– '}
          {it.text}
        </span>
      ))}
    </div>
  );
}
