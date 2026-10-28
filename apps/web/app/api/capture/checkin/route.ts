import { NextRequest, NextResponse } from 'next/server';
import { chat } from '@pixa/model-adapters';
import { loadConfig } from '@pixa/model-adapters';

/**
 * POST /api/capture/checkin — periodic semantic coverage hint while recording.
 * Multipart: up to 3 small JPEG frames (field "frames") + optional JSON
 * context (field "context": { elapsedSec, compassHint }).
 * Returns one concrete next instruction + observed/missing lists. Cheap by
 * design (small frames, ~20-30 s client cadence); routine second-by-second
 * checks stay on-device and never reach this endpoint.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const files = form.getAll('frames').filter((f): f is File => f instanceof File).slice(0, 3);
  if (files.length === 0) {
    return NextResponse.json({ error: 'No frames provided (field "frames")' }, { status: 400 });
  }
  for (const f of files) {
    if (f.size > 1024 * 1024) {
      return NextResponse.json({ error: 'Frame too large (limit 1 MB each — send thumbnails)' }, { status: 413 });
    }
  }
  let context = '';
  const rawCtx = form.get('context');
  if (typeof rawCtx === 'string' && rawCtx.length < 2000) context = rawCtx;

  const images = [];
  for (const f of files) {
    const buf = Buffer.from(await f.arrayBuffer());
    images.push({
      type: 'image_url' as const,
      image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` },
    });
  }
  try {
    const result = await chat(
      {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `You are a capture director watching a live indoor room scan. These ${files.length} recent frames ` +
                  `show where the user is now. Context: ${context || 'none'}. ` +
                  `Return JSON {"covered": ["..."], "missing": ["..."], "nextInstruction": "..."}. ` +
                  `Rules: name only clearly visible areas/objects; missing = plausible unscanned parts ` +
                  `(other side of furniture, corners, ceiling, floor, doorways); nextInstruction is ONE ` +
                  `concrete physical action under 20 words (never unsafe: no walking backward while filming). ` +
                  `If coverage already looks complete, nextInstruction says to finish.`,
              },
              ...images,
            ],
          },
        ],
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'checkin',
            schema: {
              type: 'object',
              properties: {
                covered: { type: 'array', items: { type: 'string' } },
                missing: { type: 'array', items: { type: 'string' } },
                nextInstruction: { type: 'string' },
              },
              required: ['covered', 'missing', 'nextInstruction'],
              additionalProperties: false,
            },
          },
        },
        maxTokens: 2048,
      },
      loadConfig(),
    );
    try {
      const parsed = JSON.parse(result.content ?? '{}') as {
        covered?: string[];
        missing?: string[];
        nextInstruction?: string;
      };
      return NextResponse.json({
        covered: parsed.covered ?? [],
        missing: parsed.missing ?? [],
        nextInstruction: parsed.nextInstruction ?? '',
      });
    } catch {
      return NextResponse.json(
        { covered: [], missing: [], nextInstruction: '' },
        { status: 502 },
      );
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 200) : 'unknown';
    return NextResponse.json({ error: `Check-in failed: ${detail}` }, { status: 502 });
  }
}
