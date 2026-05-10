import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type Provider = 'anthropic' | 'openai';

export type ModelOption = {
  /** "provider:model" — used as the value in dropdowns and env transport */
  id: string;
  provider: Provider;
  /** Model id used by the provider's SDK */
  model: string;
  label: string;
};

// Curated list. Add or remove freely; client picker reads this set.
export const MODELS: ModelOption[] = [
  { id: 'anthropic:claude-opus-4-7', provider: 'anthropic', model: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { id: 'anthropic:claude-sonnet-4-6', provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'anthropic:claude-haiku-4-5', provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'openai:gpt-4.1', provider: 'openai', model: 'gpt-4.1', label: 'GPT-4.1' },
  { id: 'openai:gpt-4o', provider: 'openai', model: 'gpt-4o', label: 'GPT-4o' },
  { id: 'openai:gpt-4o-mini', provider: 'openai', model: 'gpt-4o-mini', label: 'GPT-4o mini' },
];

export const DEFAULT_MODEL_ID = 'anthropic:claude-sonnet-4-6';

export function findModel(id: string | undefined | null): ModelOption {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!;
}

export function availableProviders(): Record<Provider, boolean> {
  return {
    anthropic: !!process.env['ANTHROPIC_API_KEY'],
    openai: !!process.env['OPENAI_API_KEY'],
  };
}

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (anthropicClient) return anthropicClient;
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (openaiClient) return openaiClient;
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

export async function generate(opts: {
  modelId: string;
  system?: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const m = findModel(opts.modelId);
  const maxTokens = opts.maxTokens ?? 2000;

  if (m.provider === 'anthropic') {
    const r = await getAnthropic().messages.create({
      model: m.model,
      max_tokens: maxTokens,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: 'user', content: opts.user }],
    });
    return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }

  const r = await getOpenAI().chat.completions.create({
    model: m.model,
    max_completion_tokens: maxTokens,
    messages: [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      { role: 'user' as const, content: opts.user },
    ],
  });
  return r.choices[0]?.message?.content ?? '';
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

/**
 * Streams text deltas from the configured provider.
 * Yields strings — concatenate to get the full reply.
 */
export async function* streamChat(opts: {
  modelId: string;
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
}): AsyncGenerator<string, void, unknown> {
  const m = findModel(opts.modelId);
  const maxTokens = opts.maxTokens ?? 1500;

  if (m.provider === 'anthropic') {
    const stream = await getAnthropic().messages.stream({
      model: m.model,
      max_tokens: maxTokens,
      system: opts.system,
      messages: opts.messages.map((msg) => ({ role: msg.role, content: msg.content })),
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
    return;
  }

  const stream = await getOpenAI().chat.completions.create({
    model: m.model,
    max_completion_tokens: maxTokens,
    stream: true,
    messages: [
      { role: 'system', content: opts.system },
      ...opts.messages.map((msg) => ({ role: msg.role, content: msg.content })),
    ],
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}
