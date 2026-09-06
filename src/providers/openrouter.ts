import OpenAI from 'openai';
import { getOpenRouterKey, saveModelsCache, ModelInfo } from '../config.js';
import { ChatOptions, ChatResponse, ProviderClient, ToolCallData, UsageData } from './types.js';

export class OpenRouterProvider implements ProviderClient {
  public readonly name = 'openrouter';
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    const apiKey = getOpenRouterKey();
    if (!apiKey) {
      throw new Error(
        'OpenRouter API key not found. Set OPENROUTER_API_KEY or run `forge login openrouter`.'
      );
    }

    if (!this.client || this.client.apiKey !== apiKey) {
      this.client = new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey,
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/dilkuwor/forge',
          'X-Title': 'forge'
        }
      });
    }

    return this.client;
  }

  public async fetchModels(): Promise<string[]> {
    const apiKey = getOpenRouterKey();
    try {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as any;
      if (!data || !Array.isArray(data.data)) return [];

      const freeModels: ModelInfo[] = [];
      const modelIds: string[] = [];

      for (const m of data.data) {
        const promptPrice = m.pricing?.prompt;
        const completionPrice = m.pricing?.completion;
        const isFreePrice =
          (promptPrice === 0 || promptPrice === '0') &&
          (completionPrice === 0 || completionPrice === '0');
        const isFreeName = m.id.endsWith(':free') || m.id.includes('/free');
        const params = m.supported_parameters;
        const supportsTools = Array.isArray(params) ? params.includes('tools') : true;

        if ((isFreePrice || isFreeName) && supportsTools) {
          freeModels.push({
            id: m.id,
            name: m.name || m.id,
            provider: 'openrouter',
            pricing: {
              prompt: promptPrice,
              completion: completionPrice
            },
            contextLength: m.context_length,
            supportsTools: true
          });
          modelIds.push(m.id);
        }
      }

      saveModelsCache({
        openrouter: freeModels,
        updatedAt: new Date().toISOString()
      });

      return modelIds;
    } catch {
      return [];
    }
  }

  public async chat(options: ChatOptions): Promise<ChatResponse> {
    const client = this.getClient();
    let text = '';
    let thinking = '';
    const toolCallsMap: Record<number, ToolCallData> = {};
    let usage: UsageData | undefined;

    const stream = options.stream !== false;

    if (!stream) {
      const resp = await client.chat.completions.create(
        {
          model: options.model,
          messages: options.messages as any,
          tools: options.tools && options.tools.length > 0 ? (options.tools as any) : undefined
        },
        { signal: options.signal }
      );

      const choice = resp.choices[0];
      const msg = choice?.message;
      text = msg?.content || '';
      if (text && options.onEvent) {
        options.onEvent({ type: 'text', text });
      }

      const toolCalls: ToolCallData[] = (msg?.tool_calls || []).map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || ''
      }));

      for (const tc of toolCalls) {
        if (options.onEvent) {
          options.onEvent({ type: 'tool_call', toolCall: tc });
        }
      }

      if (resp.usage) {
        usage = {
          promptTokens: resp.usage.prompt_tokens,
          completionTokens: resp.usage.completion_tokens,
          totalTokens: resp.usage.total_tokens
        };
        if (options.onEvent) {
          options.onEvent({ type: 'usage', usage });
        }
      }

      return { text, thinking: '', toolCalls, usage };
    }

    try {
      const responseStream = await client.chat.completions.create(
        {
          model: options.model,
          messages: options.messages as any,
          tools: options.tools && options.tools.length > 0 ? (options.tools as any) : undefined,
          stream: true,
          stream_options: { include_usage: true }
        },
        { signal: options.signal }
      );

      for await (const chunk of responseStream) {
        const delta = chunk.choices[0]?.delta;

        // Reasoning/Thinking stream
        const reasonDelta = (delta as any)?.reasoning || (delta as any)?.reasoning_content;
        if (reasonDelta) {
          thinking += reasonDelta;
          if (options.onEvent) {
            options.onEvent({ type: 'thinking', text: reasonDelta });
          }
        }

        // Text content
        if (delta?.content) {
          text += delta.content;
          if (options.onEvent) {
            options.onEvent({ type: 'text', text: delta.content });
          }
        }

        // Tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            if (!toolCallsMap[index]) {
              toolCallsMap[index] = {
                id: tc.id || `call_${index}`,
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || ''
              };
            } else {
              if (tc.id) toolCallsMap[index].id = tc.id;
              if (tc.function?.name) toolCallsMap[index].name += tc.function.name;
              if (tc.function?.arguments) toolCallsMap[index].arguments += tc.function.arguments;
            }
          }
        }

        // Usage
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens
          };
          if (options.onEvent) {
            options.onEvent({ type: 'usage', usage });
          }
        }
      }

      const toolCalls = Object.values(toolCallsMap);
      for (const tc of toolCalls) {
        if (options.onEvent) {
          options.onEvent({ type: 'tool_call', toolCall: tc });
        }
      }

      return { text, thinking, toolCalls, usage };
    } catch (err: any) {
      if (options.onEvent) {
        options.onEvent({ type: 'error', error: err });
      }
      throw err;
    }
  }
}
