'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { blurScore, brightness, frameDiff, GuideEngine } from '@/lib/capture-analysis';
import { CompassDial, useCoverageCompass } from './CoverageCompass';

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
  const [advice, setAdvice] = useState<{ level: string; message: string }[]>([]);
  const [meters, setMeters] = useState({ speed: 0, blur: 0, light: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const qualityOkRef = useRef(true);
  const { state: compass, requestPermission, reset: resetCompass } = useCoverageCompass(
    phase === 'recording',
    qualityOkRef.current,
  );

  useEffect(() => () => stopStream(), []);

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
      setAdvice([{ level: 'good', message: 'Camera live. Tap Record, then walk slowly around one room.' }]);
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
        const ok = blur >= 60 && light >= 38 && light <= 215;
        qualityOkRef.current = ok;
        setAdvice(guideRef.current.advise({ speed, blur, light }));
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
      setPhase('review');
    };
    recorder.start(1000);
    setElapsed(0);
    setPhase('recording');
    analyzeLoop();
  }

  useEffect(() => {
    if (phase !== 'recording') return;
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  function stopRecording() {
    recorderRef.current?.stop();
  }

  async function useRecording() {
    const blob = blobRef.current;
    if (!blob) return;
    setPhase('uploading');
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
        body: JSON.stringify({ name: `Guided capture ${new Date().toLocaleString()}` }),
      });
      if (!createRes.ok) throw new Error(`Scene creation failed (${createRes.status})`);
      const { sceneId } = (await createRes.json()) as { sceneId: string };
      const form = new FormData();
      form.append('video', blob, `capture.${ext}`);
      const upRes = await fetch(`/api/scenes/${sceneId}/upload`, { method: 'POST', body: form });
      if (!upRes.ok) {
        const body = (await upRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Upload failed (${upRes.status})`);
      }
      await fetch(`/api/scenes/${sceneId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: 'spirula' }),
      });
      stopStream();
      router.push(`/scenes/${sceneId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      setPhase('review');
    }
  }

  function fmt(s: number) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
      <video
        ref={videoRef}
        muted
        playsInline
        className={
          phase === 'preview' || phase === 'recording'
            ? 'mt-3 w-full rounded-md bg-black'
            : 'hidden'
        }
      />
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
          <div className="mt-2 flex items-center gap-3 text-xs text-neutral-400">
            <span>motion {meters.speed}</span>
            <span>sharp {meters.blur}</span>
            <span>light {meters.light}</span>
            {phase === 'recording' && <span className="ml-auto text-red-400">● {fmt(elapsed)}</span>}
          </div>
          <div className="mt-2 space-y-1">
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
          <div className="mt-3 flex gap-2">
            {phase === 'preview' ? (
              <button
                type="button"
                onClick={startRecording}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white"
              >
                ● Record
              </button>
            ) : (
              <button
                type="button"
                onClick={stopRecording}
                className="rounded-md bg-neutral-700 px-4 py-2 text-sm font-medium"
              >
                Stop
              </button>
            )}
          </div>
        </div>
      )}
      {phase === 'review' && blobUrl && (
        <div className="mt-3">
          <video src={blobUrl} controls playsInline className="w-full rounded-md bg-black" />
          <p className="mt-2 text-xs text-neutral-500">Review, then send to reconstruction.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={useRecording}
              className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black"
            >
              Use this recording
            </button>
            <button
              type="button"
              onClick={() => setPhase('preview')}
              className="rounded-md border border-neutral-700 px-4 py-2 text-sm"
            >
              Re-record
            </button>
          </div>
        </div>
      )}
      {phase === 'uploading' && <p className="mt-3 text-sm text-neutral-500">Uploading…</p>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
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
