import OpenAI from 'openai';
import { getNvidiaKey, saveModelsCache, ModelInfo } from '../config.js';
import { ChatOptions, ChatResponse, ProviderClient, ToolCallData, UsageData } from './types.js';

export const RETIRED_NVIDIA_MODELS = ['deepseek-ai/deepseek-v4-flash'];

export const PREFERRED_NVIDIA_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'deepseek-ai/deepseek-v4-flash-0731'
];

export class NvidiaProvider implements ProviderClient {
  public readonly name = 'nvidia';
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    const apiKey = getNvidiaKey();
    if (!apiKey) {
      throw new Error(
        'NVIDIA API key not found. Set NVIDIA_API_KEY or run `forge login nvidia`.'
      );
    }

    if (!this.client || this.client.apiKey !== apiKey) {
      this.client = new OpenAI({
        baseURL: 'https://integrate.api.nvidia.com/v1',
        apiKey
      });
    }

    return this.client;
  }

  public async fetchModels(): Promise<string[]> {
    const apiKey = getNvidiaKey();
    if (!apiKey) return PREFERRED_NVIDIA_MODELS;

    try {
      const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      });
      if (!res.ok) {
        return PREFERRED_NVIDIA_MODELS;
      }

      const data = (await res.json()) as any;
      if (!data || !Array.isArray(data.data)) return PREFERRED_NVIDIA_MODELS;

      const liveModels: ModelInfo[] = [];
      const modelIds: string[] = [];

      for (const m of data.data) {
        if (RETIRED_NVIDIA_MODELS.includes(m.id)) {
          continue;
        }

        liveModels.push({
          id: m.id,
          name: m.name || m.id,
          provider: 'nvidia',
          supportsTools: true
        });
        modelIds.push(m.id);
      }

      saveModelsCache({
        nvidia: liveModels,
        deadModels: RETIRED_NVIDIA_MODELS,
        updatedAt: new Date().toISOString()
      });

      return modelIds.length > 0 ? modelIds : PREFERRED_NVIDIA_MODELS;
    } catch {
      return PREFERRED_NVIDIA_MODELS;
    }
  }

  public async chat(options: ChatOptions): Promise<ChatResponse> {
    if (RETIRED_NVIDIA_MODELS.includes(options.model)) {
      const err = new Error(
        `Model "${options.model}" is retired and unavailable. Please use a live model like deepseek-ai/deepseek-v4-flash-0731.`
      );
      (err as any).status = 410;
      throw err;
    }

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

        const reasonDelta = (delta as any)?.reasoning || (delta as any)?.reasoning_content;
        if (reasonDelta) {
          thinking += reasonDelta;
          if (options.onEvent) {
            options.onEvent({ type: 'thinking', text: reasonDelta });
          }
        }

        if (delta?.content) {
          text += delta.content;
          if (options.onEvent) {
            options.onEvent({ type: 'text', text: delta.content });
          }
        }

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
