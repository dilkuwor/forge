import type { ModelInfo, ProviderName } from '../config.js';

export type { ProviderName };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface ToolCallData {
  id: string;
  name: string;
  arguments: string;
}

export interface UsageData {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; toolCall: ToolCallData }
  | { type: 'usage'; usage: UsageData }
  /** Informational router/provider notice (fallback, retry). Never part of the assistant's text. */
  | { type: 'status'; message: string }
  /**
   * Emitted by the router before it switches models after a partial stream.
   * Consumers should discard text/thinking accumulated for the current step.
   */
  | { type: 'reset' }
  | { type: 'error'; error: Error };

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  stream?: boolean;
  onEvent?: (event: ProviderEvent) => void;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  thinking: string;
  toolCalls: ToolCallData[];
  usage?: UsageData;
}

export interface ProviderClient {
  name: ProviderName;
  chat(options: ChatOptions): Promise<ChatResponse>;
  /**
   * Fetch the provider's live model list. Returns model ids; implementations
   * may also update the on-disk models cache.
   */
  fetchModels(): Promise<string[]>;
  /** Detailed model list (optional; used by setup & routing when available). */
  fetchModelInfos?(): Promise<ModelInfo[]>;
}
