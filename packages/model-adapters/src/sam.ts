/**
 * SAM 3.1 adapter — segmentation/detection/tracking (PRD §§ 9.2, 20.2).
 * ONE noun-phrase concept per request. Returns image-space geometry ONLY
 * (boxes in source pixels + raster masks) — never 3D positions.
 * Image-space results must never be treated as registered 3D geometry.
 *
 * NOTE: request/response shapes follow https://dev.meta.ai/docs/media-segmentation
 * and will be re-verified live with a billed test call before Stage 3 use.
 */
import { loadConfig, metaFetch, throwIfError, type AdapterConfig } from './config';
import { parseVideoStream, recordsOfKind } from '@meta-sam/parser';
import OpenAI from 'openai';

export interface SamBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface SamImageResult {
  /** Raw model output text (special-token lines). Empty string = zero matches (valid). */
  rawOutput: string;
  /** Boxes parsed from raw output where the format is confirmed. */
  boxes: SamBox[];
  frameIndex: number;
}

export interface SegmentImageOptions {
  /** Public URL, base64 data URL, or Meta file_id of the frame. */
  image: string;
  /** Single noun phrase, e.g. "chair". One concept per request. */
  prompt: string;
  modelOverride?: string;
}

/**
 * Parse `<|box;…|>` tokens from SAM output.
 * Verified live format: `<|box;x1=200;y1=140;x2=439;y2=339;w=640;h=480|>`
 * (named params + source dims). A legacy positional `box;xMin;yMin;xMax;yMax`
 * form is also accepted. Unknown token formats are ignored, never guessed.
 */
export function parseBoxes(raw: string): SamBox[] {
  const boxes: SamBox[] = [];
  const token = /<\|box;([^|]*)\|>/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(raw)) !== null) {
    const params = Object.fromEntries(
      m[1].split(';').flatMap((kv) => {
        const eq = kv.indexOf('=');
        return eq > 0 ? [[kv.slice(0, eq).trim(), Number(kv.slice(eq + 1))]] : [];
      }),
    ) as Record<string, number>;
    const xMin = params.x1 ?? params.x_min ?? params.xmin;
    const yMin = params.y1 ?? params.y_min ?? params.ymin;
    const xMax = params.x2 ?? params.x_max ?? params.xmax;
    const yMax = params.y2 ?? params.y_max ?? params.ymax;
    if (
      [xMin, yMin, xMax, yMax].every(
        (n) => typeof n === 'number' && Number.isFinite(n),
      )
    ) {
      boxes.push({ xMin, yMin, xMax, yMax });
    }
  }
  return boxes;
}

export async function segmentImage(
  options: SegmentImageOptions,
  config: AdapterConfig = loadConfig(),
): Promise<SamImageResult> {
  const imagePart = options.image.startsWith('file:')
    ? { type: 'input_file', file_id: options.image.slice('file:'.length) }
    : { type: 'input_image', image_url: options.image };
  const res = await metaFetch(config, '/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.modelOverride ?? config.samModel,
      stream: false,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: options.prompt },
            imagePart,
          ],
        },
      ],
    }),
  });
  await throwIfError(res);
  const data = (await res.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  if (process.env.WL_DEBUG_SAM) {
    const sanitized = JSON.stringify(data).slice(0, 2000);
    console.error(`[sam-debug] response: ${sanitized}`);
  }
  const raw =
    data.output_text ??
    data.output?.map((o) => o.content?.map((c) => c.text ?? '').join('')).join('\n') ??
    '';
  return { rawOutput: raw, boxes: parseBoxes(raw), frameIndex: 0 };
}

/** Upload a clip once for repeated video segmentation (Files API, free). */
export async function uploadFile(
  bytes: Uint8Array,
  filename: string,
  config: AdapterConfig = loadConfig(),
): Promise<string> {
  const form = new FormData();
  form.set('purpose', 'user_data');
  // BlobPart typing rejects Uint8Array in some TS DOM libs; copy via ArrayBuffer.
  form.set('file', new Blob([bytes.buffer as ArrayBuffer], { type: 'video/mp4' }), filename);
  const res = await metaFetch(config, '/files', { method: 'POST', body: form });
  await throwIfError(res);
  const data = (await res.json()) as { id: string };
  if (!data.id) throw new Error('Files API returned no id');
  return data.id;
}

export interface SamTrackObs {
  /** Stable SAM object id within this request (string of the wire integer). */
  objectId: string;
  /** Source video frame index the box was observed on. */
  frame: number;
  box: SamBox;
  /** Per-record confidence when requested; absent otherwise (never zero-filled). */
  confidence?: number;
}

export interface SegmentVideoOptions {
  /** file_id from uploadFile (uploaded clip, not a URL — billed per frame). */
  fileId: string;
  /** Concept noun phrase OR buildObjectPrompt() box/point text — never both. */
  prompt: string;
  /** Request per-record confidence (needs parser >=0.0.13). Default true. */
  confidence?: boolean;
  modelOverride?: string;
}

export interface SegmentVideoResult {
  /** Exact wire text (special-token lines). Persist for mask work; parse via records. */
  rawOutput: string;
  /** One record per observed (object, frame); dense across the clip. */
  obs: SamTrackObs[];
  /** Frames the API billed (usage.video_frames_processed). */
  framesProcessed: number;
  outcome: string;
  /** Recoverable format problems; inspect even on success. */
  diagnostics: readonly unknown[];
}

/**
 * Track objects through a clip (ONE request, whole video, non-streaming).
 * Streaming full clips flaked at the transport (ETIMEDOUT); non-streaming
 * completes a 2825-frame clip in ~100s. Concept prompts return stable
 * per-frame ordinals; box prompts echo caller ids. IDs are stable while the
 * object stays in frame — never trust them across exit/re-entry (docs).
 */
export async function segmentVideo(
  options: SegmentVideoOptions,
  config: AdapterConfig = loadConfig(),
): Promise<SegmentVideoResult> {
  // The documented OpenAI SDK (not raw fetch): global fetch caps header wait
  // at 300s, but a 14-object x 2825-frame track computes longer server-side.
  // maxRetries=0: a timed-out billed request may still complete server-side;
  // auto-retry would silently double-bill. Surface errors, never re-fire.
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    timeout: 20 * 60 * 1000,
    maxRetries: 0,
  });
  // Meta extensions (input_video part, mask_encoding/confidence metadata)
  // predate SDK types; wire shape verified live against api.meta.ai.
  const data = await client.responses.create({
    model: options.modelOverride ?? config.samModel,
    stream: false,
    metadata: {
      mask_encoding: 'one_bit',
      include_confidence: options.confidence === false ? 'false' : 'true',
    },
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: options.prompt },
        { type: 'input_video', file_id: options.fileId },
      ],
    }],
  } as never) as unknown as {
    output?: Array<{ content?: Array<{ text?: string }> }>;
    usage?: { video_frames_processed?: number };
  };
  const raw = data.output?.map((o) => o.content?.map((c) => c.text ?? '').join('')).join('\n') ?? '';
  const framesProcessed = data.usage?.video_frames_processed ?? 0;
  // Non-streaming returns complete text; replay it through the official
  // parser with a synthesized envelope (mask payloads are base85 and may
  // contain '|' — never tokenize by hand).
  async function* replay(): AsyncGenerator<Record<string, unknown>> {
    const lane = { item_id: 'sam-video', output_index: 0, content_index: 0 };
    for (const line of raw.split('\n')) {
      if (line.trim()) yield { type: 'response.output_text.delta', delta: line + '\n', ...lane };
    }
    yield { type: 'response.output_text.done', text: raw, ...lane };
    yield { type: 'response.completed' };
  }
  const parsed = await parseVideoStream(replay() as never).finalResult;
  const obs: SamTrackObs[] = [];
  for (const b of recordsOfKind(parsed.records, 'box')) {
    if (b.frame == null) continue;
    obs.push({
      objectId: b.objectId,
      frame: b.frame.frameIndex,
      box: { xMin: b.left, yMin: b.top, xMax: b.right - 1, yMax: b.bottom - 1 },
      ...(b.confidence !== undefined ? { confidence: b.confidence } : {}),
    });
  }
  obs.sort((a, b2) => a.frame - b2.frame || (a.objectId < b2.objectId ? -1 : 1));
  return {
    rawOutput: raw, obs, framesProcessed,
    outcome: parsed.outcome.status, diagnostics: parsed.diagnostics,
  };
}
