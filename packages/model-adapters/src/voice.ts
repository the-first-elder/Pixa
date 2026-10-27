/**
 * Muse Voice Transcribe adapter — speech input only (PRD §§ 12.3, 20.3).
 * WAV mono 16-bit PCM 16/24 kHz ONLY, ≤32 MB, ≤10 min per request.
 * Callers must convert first, e.g.:
 *   ffmpeg -i in.m4a -ac 1 -ar 24000 -c:a pcm_s16le out.wav
 * Turn-level timestamps + session speaker labels only (no word timestamps,
 * no confidence). There is NO Meta TTS — spoken output uses browser speech
 * synthesis (Stage 6).
 */
import { loadConfig, metaFetch, throwIfError, type AdapterConfig } from './config';

export interface TranscribeTurn {
  turnId: string;
  startMs: number;
  endMs: number;
  transcript: string;
  speaker?: string;
}

export interface TranscribeResult {
  sessionId: string;
  transcript: string;
  audioDurationMs: number;
  turns: TranscribeTurn[];
}

export interface TranscribeOptions {
  /** Raw WAV bytes (already converted to mono PCM 16/24 kHz). */
  wav: Buffer | Uint8Array;
  sessionId?: string;
  languageBias?: string[];
  keywords?: string[];
}

export async function transcribe(
  options: TranscribeOptions,
  config: AdapterConfig = loadConfig(),
): Promise<TranscribeResult> {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const form = new FormData();
  form.append(
    'request',
    JSON.stringify({
      model: config.voiceModel,
      mode: 'PUSH_TO_TALK',
      audioEncoding: 'WAV',
      ...(options.languageBias ? { languageBias: options.languageBias } : {}),
      ...(options.keywords ? { keywords: options.keywords } : {}),
    }),
  );
  form.append(
    'audio',
    new Blob([options.wav as BlobPart], { type: 'audio/wav' }),
    'audio.wav',
  );
  const res = await metaFetch(
    config,
    `/asr/transcribe?sessionId=${encodeURIComponent(sessionId)}`,
    { method: 'POST', headers: { Accept: 'application/json' }, body: form },
  );
  await throwIfError(res);
  const data = (await res.json()) as TranscribeResult;
  if (typeof data.transcript !== 'string') {
    throw new Error('Transcription response missing transcript');
  }
  return data;
}
