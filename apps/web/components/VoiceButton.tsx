'use client';

import { useRef, useState } from 'react';

/**
 * Push-to-talk voice input. Records, uploads for transcription, and hands the
 * transcript back for correction before it enters the query pipeline.
 * Degrades to typed input when mic/transcription is unavailable (PRD §12.7).
 */
export default function VoiceButton({
  sceneId,
  onTranscript,
}: {
  sceneId: string;
  onTranscript: (text: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'recording' | 'working' | 'error'>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function start() {
    setNotice(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState('error');
      setNotice('Microphone unavailable — type instead.');
      return;
    }
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setState('working');
      try {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const form = new FormData();
        form.append('audio', blob, 'speech.webm');
        const res = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}/voice`, {
          method: 'POST',
          body: form,
        });
        const data = (await res.json()) as { transcript?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? `Voice failed (${res.status})`);
        onTranscript(data.transcript ?? '');
        setState('idle');
      } catch (e) {
        setState('error');
        setNotice(e instanceof Error ? e.message : 'Transcription failed — type instead.');
      }
    };
    recorder.start();
    setState('recording');
  }

  function stop() {
    recorderRef.current?.stop();
  }

  return (
    <span className="inline-flex items-center gap-2">
      {state === 'recording' ? (
        <button
          type="button"
          onClick={stop}
          className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white"
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={start}
          disabled={state === 'working'}
          className="rounded-md border border-neutral-700 px-3 py-2 text-sm disabled:opacity-50"
          title="Push to talk"
        >
          {state === 'working' ? '…' : '🎤'}
        </button>
      )}
      {notice && <span className="text-xs text-red-400">{notice}</span>}
    </span>
  );
}
