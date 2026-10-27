/**
 * Muse Image adapter — OPTIONAL concept imagery only (PRD §20.4).
 * Generated images are labeled as generated and NEVER replace the
 * reconstruction as evidence. Not a core dependency of reconstruction.
 */
import { loadConfig, metaFetch, throwIfError, type AdapterConfig } from './config';

export interface GenerateImageOptions {
  prompt: string;
  size?: string;
  modelOverride?: string;
}

export interface GenerateImageResult {
  created: number;
  images: Array<{ b64_json?: string; url?: string }>;
  outputFormat: string;
}

export async function generateImage(
  options: GenerateImageOptions,
  config: AdapterConfig = loadConfig(),
): Promise<GenerateImageResult> {
  const res = await metaFetch(config, '/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.modelOverride ?? config.imageModel,
      prompt: options.prompt,
      ...(options.size ? { size: options.size } : {}),
      response_format: 'b64_json',
    }),
  });
  await throwIfError(res);
  const data = (await res.json()) as {
    created: number;
    data: Array<{ b64_json?: string; url?: string }>;
    output_format?: string;
  };
  return {
    created: data.created,
    images: data.data,
    outputFormat: data.output_format ?? 'unknown',
  };
}
