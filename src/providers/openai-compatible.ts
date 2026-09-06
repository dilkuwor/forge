import OpenAI from 'openai';
import type { ModelInfo, ProviderName } from '../config.js';
import { ChatOptions, ChatResponse, ProviderClient, ToolCallData, UsageData } from './types.js';

export interface OpenAICompatibleOptions {
  name: ProviderName;
  baseURL: string;
  /** Returns the API key or undefined when not configured. Evaluated per request. */
  getApiKey: () => string | undefined;
  /** Human readable instructions shown when the key is missing. */
  missingKeyHint: string;
  defaultHeaders?: Record<string, string>;
  /** Models to refuse up-front (retired). */
  retiredModels?: string[];
}

/**
 * Shared implementation for any OpenAI-compatible chat completions endpoint.
 * Provider subclasses only supply connection details and model-list parsing.
 */
export abstract class OpenAICompatibleProvider implements ProviderClient {
  public readonly name: ProviderName;
  protected readonly baseURL: string;
  protected readonly getApiKey: () => string | undefined;
  protected readonly missingKeyHint: string;
  protected readonly defaultHeaders?: Record<string, string>;
  protected readonly retiredModels: Set<string>;
  private client: OpenAI | null = null;
  private clientKey: string | null = null;

  constructor(opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.baseURL = opts.baseURL;
    this.getApiKey = opts.getApiKey;
    this.missingKeyHint = opts.missingKeyHint;
    this.defaultHeaders = opts.defaultHeaders;
    this.retiredModels = new Set(opts.retiredModels || []);
  }

  public hasCredentials(): boolean {
    return Boolean(this.getApiKey());
  }

  protected getClient(): OpenAI {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      const err = new Error(this.missingKeyHint);
      (err as { status?: number }).status = 401;
      throw err;
    }
    if (!this.client || this.clientKey !== apiKey) {
      this.client = new OpenAI({
        baseURL: this.baseURL,
        apiKey,
        defaultHeaders: this.defaultHeaders,
        maxRetries: 0 // the router owns retry policy
      });
      this.clientKey = apiKey;
    }
    return this.client;
  }

  /** Subclasses turn the raw `/models` payload into ModelInfo entries. */
  protected abstract parseModelList(data: unknown): ModelInfo[];
  /** Subclasses persist their list into the models cache. */
  protected abstract persistModelInfos(models: ModelInfo[]): void;
  /** Fallback list when the network is unavailable. */
  protected abstract fallbackModelIds(): string[];

  public async fetchModelInfos(): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${this.baseURL}/models`, { headers, signal: controller.signal });
      if (!res.ok) return [];
      const data = await res.json();
      const models = this.parseModelList(data).filter((m) => !this.retiredModels.has(m.id));
      if (models.length > 0) this.persistModelInfos(models);
      return models;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  public async fetchModels(): Promise<string[]> {
    const infos = await this.fetchModelInfos();
    if (infos.length > 0) return infos.map((m) => m.id);
    return this.fallbackModelIds();
  }

  public async chat(options: ChatOptions): Promise<ChatResponse> {
    if (this.retiredModels.has(options.model)) {
      const err = new Error(`Model "${options.model}" is retired and unavailable.`);
      (err as { status?: number }).status = 410;
      throw err;
    }

    const client = this.getClient();
    const tools = options.tools && options.tools.length > 0 ? (options.tools as never) : undefined;

    if (options.stream === false) {
      return this.chatOnce(client, options, tools);
    }
    return this.chatStream(client, options, tools);
  }

  private async chatOnce(client: OpenAI, options: ChatOptions, tools: never | undefined): Promise<ChatResponse> {
    const resp = await client.chat.completions.create(
      {
        model: options.model,
        messages: options.messages as never,
        tools
      },
      { signal: options.signal }
    );

    const msg = resp.choices[0]?.message;
    const text = msg?.content || '';
    const thinking =
      ((msg as { reasoning?: string; reasoning_content?: string } | undefined)?.reasoning ||
        (msg as { reasoning_content?: string } | undefined)?.reasoning_content ||
        '') as string;

    if (thinking) options.onEvent?.({ type: 'thinking', text: thinking });
    if (text) options.onEvent?.({ type: 'text', text });

    const toolCalls: ToolCallData[] = (msg?.tool_calls || [])
      .filter((tc) => tc.type === 'function')
      .map((tc, i) => ({
        id: tc.id || `call_${i}`,
        name: (tc as { function?: { name?: string } }).function?.name || '',
        arguments: (tc as { function?: { arguments?: string } }).function?.arguments || ''
      }));
    for (const tc of toolCalls) options.onEvent?.({ type: 'tool_call', toolCall: tc });

    let usage: UsageData | undefined;
    if (resp.usage) {
      usage = {
        promptTokens: resp.usage.prompt_tokens,
        completionTokens: resp.usage.completion_tokens,
        totalTokens: resp.usage.total_tokens
      };
      options.onEvent?.({ type: 'usage', usage });
    }

    return { text, thinking, toolCalls, usage };
  }

  private async chatStream(client: OpenAI, options: ChatOptions, tools: never | undefined): Promise<ChatResponse> {
    let text = '';
    let thinking = '';
    const toolCallsMap = new Map<number, ToolCallData>();
    let usage: UsageData | undefined;

    const responseStream = await client.chat.completions.create(
      {
        model: options.model,
        messages: options.messages as never,
        tools,
        stream: true,
        stream_options: { include_usage: true }
      },
      { signal: options.signal }
    );

    for await (const chunk of responseStream) {
      if (options.signal?.aborted) {
        responseStream.controller.abort();
        break;
      }

      const delta = chunk.choices?.[0]?.delta as
        | (Record<string, unknown> & {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          })
        | undefined;

      const reasonDelta = (delta?.reasoning ?? delta?.reasoning_content) as string | undefined;
      if (reasonDelta) {
        thinking += reasonDelta;
        options.onEvent?.({ type: 'thinking', text: reasonDelta });
      }

      if (delta?.content) {
        text += delta.content;
        options.onEvent?.({ type: 'text', text: delta.content });
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === 'number' ? tc.index : toolCallsMap.size;
          const existing = toolCallsMap.get(index);
          if (!existing) {
            toolCallsMap.set(index, {
              id: tc.id || `call_${index}`,
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || ''
            });
          } else {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          }
        }
      }

      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens
        };
        options.onEvent?.({ type: 'usage', usage });
      }
    }

    if (options.signal?.aborted) {
      const err = new Error('Request was aborted');
      err.name = 'AbortError';
      throw err;
    }

    const toolCalls = Array.from(toolCallsMap.values());
    for (const tc of toolCalls) options.onEvent?.({ type: 'tool_call', toolCall: tc });

    return { text, thinking, toolCalls, usage };
  }
}
