/**
 * Adapter configuration. Model names/versions/endpoints live HERE —
 * never scattered through application code (PRD §20.6).
 * Secrets stay server-side; this module must never be imported by client components.
 */
export interface AdapterConfig {
  baseUrl: string;
  apiKey: string;
  sparkModel: string;
  samModel: string;
  voiceModel: string;
  imageModel: string;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  return {
    baseUrl: env.META_API_BASE ?? 'https://api.meta.ai/v1',
    apiKey: required('META_API_KEY', env.META_API_KEY),
    sparkModel: env.META_SPARK_MODEL ?? 'muse-spark-1.3',
    samModel: env.META_SAM_MODEL ?? 'sam-3.1',
    voiceModel: env.META_VOICE_MODEL ?? 'muse-voice-transcribe-1.0',
    imageModel: env.META_IMAGE_MODEL ?? 'muse-image-1.0',
  };
}

/** Error with the secret redacted — safe to surface/log. */
export class MetaApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`Meta API ${status}: ${message}`);
    this.status = status;
  }
}

export async function metaFetch(
  config: AdapterConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(init.headers ?? {}),
    },
  });
  return res;
}

export async function throwIfError(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  // Never include auth material; truncate server messages.
  throw new MetaApiError(res.status, text.slice(0, 500));
}
