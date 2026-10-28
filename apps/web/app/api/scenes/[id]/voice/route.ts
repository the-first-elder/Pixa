import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { transcribe } from '@pixa/model-adapters';
import { loadConfig } from '@pixa/model-adapters';
import { getScene } from '@/lib/store';
import { authEnabled, canRead, sessionUser } from '@/lib/authz';

/**
 * POST /api/scenes/:sceneId/voice — push-to-talk speech input (PRD §12.3).
 * Accepts a recorded audio blob, converts to the API's required format
 * (WAV mono 16-bit PCM 16/24 kHz, ≤32 MB, ≤10 min), transcribes, and returns
 * the transcript for user correction. The text then enters the SAME
 * conversational pipeline as typed input — no separate scene actions.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scene = getScene(id);
  const user = await sessionUser();
  if (!scene || !canRead(scene, user?.uid ?? null)) {
    return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  }
  // Transcription costs API money per call: session required when auth is on.
  if (authEnabled() && !user) {
    return NextResponse.json({ error: 'Sign in to use voice input.' }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get('audio');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing audio file (field "audio")' }, { status: 400 });
  }
  if (file.size > 15 * 1024 * 1024) {
    return NextResponse.json({ error: 'Audio too large (limit 15 MB pre-conversion)' }, { status: 413 });
  }

  const dir = join(tmpdir(), `wl-voice-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const src = join(dir, 'in.bin');
  const wav = join(dir, 'out.wav');
  writeFileSync(src, Buffer.from(await file.arrayBuffer()));
  try {
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-i', src,
      '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', wav,
    ]);
  } catch {
    return NextResponse.json(
      { error: 'Audio could not be converted (send webm/mp4/m4a/wav)' },
      { status: 422 },
    );
  }
  const wavBytes = readFileSync(wav);
  if (wavBytes.length > 32 * 1024 * 1024) {
    return NextResponse.json({ error: 'Converted audio exceeds 32 MB' }, { status: 413 });
  }

  try {
    const result = await transcribe({ wav: wavBytes }, loadConfig());
    return NextResponse.json({
      transcript: result.transcript,
      audioDurationMs: result.audioDurationMs,
      turns: result.turns,
      sessionId: result.sessionId,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 200) : 'unknown';
    return NextResponse.json(
      { error: `Transcription failed: ${detail}` },
      { status: 502 },
    );
  }
}
