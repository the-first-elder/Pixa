/**
 * Web search grounding via Muse Spark (Responses API only — search is not
 * available on Chat Completions). Used for questions about the world beyond
 * the scene (buying, prices, product facts). Answers must be presented as
 * web facts with sources, never as scene evidence.
 * Cost: $2.50 per 1,000 searches + tokens (Meta pricing, 2026-10).
 */
import OpenAI from 'openai';
import { loadConfig, type AdapterConfig } from './config';

export interface SearchSource {
  title: string;
  url: string;
}

export interface SearchWebResult {
  /** Model's grounded answer text (may contain inline citations). */
  answer: string;
  /** Sources the model actually cited (url_citation annotations). */
  sources: SearchSource[];
  /** True when a web_search_call actually ran (model may skip search). */
  searched: boolean;
}

export async function searchWeb(
  options: { query: string; modelOverride?: string },
  config: AdapterConfig = loadConfig(),
): Promise<SearchWebResult> {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    timeout: 2 * 60 * 1000,
    maxRetries: 0,
  });
  // Meta extension shape (web_search tool) predates SDK types; verified
  // against https://dev.meta.ai/docs/search-grounding.
  const data = await client.responses.create({
    model: options.modelOverride ?? config.sparkModel,
    tools: [{ type: 'web_search', search_context_size: 'medium' }],
    include: ['web_search_call.results'],
    input: options.query,
  } as never) as unknown as {
    output?: Array<{
      type?: string;
      content?: Array<{
        text?: string;
        annotations?: Array<{ type?: string; url?: string; title?: string }>;
      }>;
    }>;
  };
  let answer = '';
  let searched = false;
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const item of data.output ?? []) {
    if (item.type === 'web_search_call') searched = true;
    if (item.type !== 'message') continue;
    for (const block of item.content ?? []) {
      if (block.text) answer += block.text;
      for (const ann of block.annotations ?? []) {
        if (ann.type === 'url_citation' && ann.url && !seen.has(ann.url)) {
          seen.add(ann.url);
          sources.push({ title: ann.title ?? ann.url, url: ann.url });
        }
      }
    }
  }
  return { answer: answer.trim(), sources, searched };
}
