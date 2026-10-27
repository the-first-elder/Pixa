/**
 * Muse Spark adapter — reasoning, scene interpretation, tool selection (PRD §§ 9.3, 20.1).
 * Uses the OpenAI-compatible Chat Completions endpoint.
 * Security: request-only. The model NEVER gets DB/filesystem/renderer access;
 * it returns tool calls; the app validates and executes (Stage 5).
 */
import { loadConfig, metaFetch, throwIfError, type AdapterConfig } from './config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  model: string;
  usage: unknown;
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** JSON-schema structured output. Validated schemas only. */
  responseFormat?: { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown> } };
  maxTokens?: number;
  modelOverride?: string;
}

export async function chat(
  options: ChatOptions,
  config: AdapterConfig = loadConfig(),
): Promise<ChatResult> {
  const res = await metaFetch(config, '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.modelOverride ?? config.sparkModel,
      messages: options.messages,
      ...(options.tools ? { tools: options.tools, tool_choice: 'auto' } : {}),
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    }),
  });
  await throwIfError(res);
  const data = (await res.json()) as {
    choices: Array<{
      message: { content: string | null; tool_calls?: ToolCall[] };
    }>;
    model: string;
    usage: unknown;
  };
  const choice = data.choices[0];
  if (!choice) throw new Error('Spark returned no choices');
  return {
    content: choice.message.content,
    toolCalls: choice.message.tool_calls ?? [],
    model: data.model,
    usage: data.usage,
  };
}

/** Read-only access check used by Stage 0 verification. Free of charge. */
export async function listModels(config: AdapterConfig = loadConfig()): Promise<string[]> {
  const res = await metaFetch(config, '/models');
  await throwIfError(res);
  const data = (await res.json()) as { data: Array<{ id: string }> };
  return data.data.map((m) => m.id);
}
