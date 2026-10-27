/**
 * SAM 3.1 adapter — segmentation/detection/tracking (PRD §§ 9.2, 20.2).
 * ONE noun-phrase concept per request. Returns image-space geometry ONLY
 * (boxes in source pixels + raster masks) — never 3D positions.
 * Image-space results must never be treated as registered 3D geometry.
 *
 * NOTE: request/response shapes follow https://dev.meta.ai/docs/media-segmentation
 * and will be re-verified live with a billed test call before Stage 3 use.
 */
import { loadConfig, metaFetch, throwIfError, type AdapterConfig } from './config.js';

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
