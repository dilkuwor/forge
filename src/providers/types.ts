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
  | { type: 'error'; error: Error };

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: any[];
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
  name: 'openrouter' | 'nvidia';
  chat(options: ChatOptions): Promise<ChatResponse>;
  fetchModels(): Promise<string[]>;
}
