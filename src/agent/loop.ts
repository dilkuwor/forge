import path from 'node:path';
import { loadConfig } from '../config.js';
import { SessionStore } from '../store/session.js';
import { TOOLS } from '../tools/definitions.js';
import { executeTool, ToolContext, SecurityError } from '../tools/index.js';
import { ChatMessage, ToolCallData } from '../providers/types.js';
import { ModelRouter } from '../providers/router.js';
import { buildSystemPrompt } from './context.js';
import { compactHistory } from './compact.js';

export type AgentEvent =
  | { type: 'step_start'; step: number; maxSteps: number }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call_start'; id: string; name: string; args: any }
  | { type: 'tool_call_result'; id: string; name: string; result: string; error?: boolean }
  | { type: 'compact'; tokensBefore: number; tokensAfter: number }
  | { type: 'status'; message: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: Error };

export interface AgentLoopOptions {
  projectRoot?: string;
  model?: string;
  router?: ModelRouter;
  session?: SessionStore;
  maxSteps?: number;
  initialMessages?: ChatMessage[];
  confirmConfig?: {
    edit: boolean;
    bash: boolean;
  };
  onConfirm?: (prompt: { type: 'file' | 'bash'; target: string }) => Promise<boolean>;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export class AgentLoop {
  public readonly projectRoot: string;
  public readonly session: SessionStore;
  public readonly router: ModelRouter;
  private allowedFiles: Set<string> = new Set();
  private touchedFiles: Set<string> = new Set();
  private failedToolCounts: Map<string, number> = new Map();
  private messages: ChatMessage[] = [];
  private todos: string[] = [];
  private currentModel: string;
  private maxSteps: number;
  private defaultConfirmConfig?: { edit: boolean; bash: boolean };
  private defaultOnConfirm?: (prompt: { type: 'file' | 'bash'; target: string }) => Promise<boolean>;

  constructor(options?: AgentLoopOptions) {
    const config = loadConfig();
    this.projectRoot = options?.projectRoot || process.cwd();
    this.currentModel = options?.model || config.defaultModel;
    this.maxSteps = options?.maxSteps || config.maxSteps || 30;
    this.router = options?.router || new ModelRouter();
    this.defaultConfirmConfig = options?.confirmConfig;
    this.defaultOnConfirm = options?.onConfirm;
    this.session =
      options?.session ||
      new SessionStore(undefined, {
        cwd: this.projectRoot,
        model: this.currentModel,
        provider: config.defaultProvider
      });

    if (options?.initialMessages) {
      this.messages = [...options.initialMessages];
    }
  }

  public getMessages(): ChatMessage[] {
    return this.messages;
  }

  public getTouchedFiles(): Set<string> {
    return this.touchedFiles;
  }

  public async run(prompt: string, options?: Partial<AgentLoopOptions>): Promise<string> {
    const config = loadConfig();
    const confirmConfig = options?.confirmConfig || this.defaultConfirmConfig || config.confirm;
    const onConfirm = options?.onConfirm || this.defaultOnConfirm;
    const onEvent = options?.onEvent;
    const signal = options?.signal;

    // Build or update system prompt
    const systemPromptContent = buildSystemPrompt(this.projectRoot, this.touchedFiles);

    if (this.messages.length === 0 || this.messages[0].role !== 'system') {
      this.messages.unshift({
        role: 'system',
        content: systemPromptContent
      });
    } else {
      this.messages[0].content = systemPromptContent;
    }

    // Add user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: prompt
    };
    this.messages.push(userMessage);

    this.session.append({
      timestamp: new Date().toISOString(),
      type: 'user',
      data: { content: prompt }
    });

    let step = 0;
    let finalAssistantText = '';

    const toolCtx: ToolContext = {
      projectRoot: this.projectRoot,
      allowedFiles: this.allowedFiles,
      confirmConfig,
      onConfirm,
      todos: this.todos,
      touchedFiles: this.touchedFiles
    };

    while (step < this.maxSteps) {
      if (signal?.aborted) {
        onEvent?.({ type: 'status', message: 'Operation cancelled by user.' });
        break;
      }

      step++;
      onEvent?.({ type: 'step_start', step, maxSteps: this.maxSteps });

      // Update system prompt with latest touched files & repo map
      this.messages[0].content = buildSystemPrompt(this.projectRoot, this.touchedFiles);

      // Check for compaction at 70% threshold
      const compactResult = compactHistory(this.messages, 32768, 0.7);
      if (compactResult.compacted) {
        this.messages = compactResult.messages;
        onEvent?.({
          type: 'compact',
          tokensBefore: compactResult.tokensBefore,
          tokensAfter: compactResult.tokensAfter
        });
        this.session.append({
          timestamp: new Date().toISOString(),
          type: 'system',
          data: {
            action: 'compact',
            tokensBefore: compactResult.tokensBefore,
            tokensAfter: compactResult.tokensAfter
          }
        });
      }

      let chatResponse: any;
      try {
        chatResponse = await this.router.chat({
          model: this.currentModel,
          messages: this.messages,
          tools: TOOLS,
          stream: true,
          signal,
          onEvent: (ev) => {
            if (ev.type === 'text') {
              onEvent?.({ type: 'text', text: ev.text });
            } else if (ev.type === 'thinking') {
              onEvent?.({ type: 'thinking', text: ev.text });
            } else if (ev.type === 'error') {
              onEvent?.({ type: 'error', error: ev.error });
            }
          }
        });
      } catch (err: any) {
        onEvent?.({ type: 'error', error: err });
        this.session.append({
          timestamp: new Date().toISOString(),
          type: 'error',
          data: { message: err.message }
        });
        throw err;
      }

      if (chatResponse.finalModel && chatResponse.finalModel !== this.currentModel) {
        this.currentModel = chatResponse.finalModel;
      }

      finalAssistantText = chatResponse.text;

      // Append assistant message
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: chatResponse.text || null,
        tool_calls:
          chatResponse.toolCalls.length > 0
            ? chatResponse.toolCalls.map((tc: ToolCallData) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: tc.arguments
                }
              }))
            : undefined
      };

      this.messages.push(assistantMsg);

      this.session.append({
        timestamp: new Date().toISOString(),
        type: 'assistant',
        data: {
          text: chatResponse.text,
          thinking: chatResponse.thinking,
          toolCalls: chatResponse.toolCalls
        }
      });

      // If no tool calls, task is finished!
      if (chatResponse.toolCalls.length === 0) {
        onEvent?.({ type: 'done', text: finalAssistantText });
        break;
      }

      // Execute tool calls
      for (const tc of chatResponse.toolCalls) {
        if (signal?.aborted) break;

        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
        } catch {
          parsedArgs = {};
        }

        onEvent?.({
          type: 'tool_call_start',
          id: tc.id,
          name: tc.name,
          args: parsedArgs
        });

        // Loop guard: if the same tool + args fail twice, stop that path and explain
        const failKey = `${tc.name}:${JSON.stringify(parsedArgs)}`;
        const prevFailCount = this.failedToolCounts.get(failKey) || 0;

        let toolResult = '';
        let isError = false;

        if (prevFailCount >= 2) {
          toolResult = `Error: Tool "${tc.name}" with arguments ${JSON.stringify(
            parsedArgs
          )} has failed twice consecutively. Stopping this path. Please explain this failure and try an alternative approach.`;
          isError = true;
        } else {
          try {
            toolResult = await executeTool(tc.name, parsedArgs, toolCtx);
            // Check if result contains an explicit error
            if (
              toolResult.startsWith('Error:') ||
              toolResult.startsWith('Command failed with exit code')
            ) {
              isError = true;
              this.failedToolCounts.set(failKey, prevFailCount + 1);
            }
          } catch (err: any) {
            isError = true;
            this.failedToolCounts.set(failKey, prevFailCount + 1);
            toolResult = `Tool execution error: ${err.message}`;
          }
        }

        onEvent?.({
          type: 'tool_call_result',
          id: tc.id,
          name: tc.name,
          result: toolResult,
          error: isError
        });

        this.session.append({
          timestamp: new Date().toISOString(),
          type: 'tool_result',
          data: {
            id: tc.id,
            name: tc.name,
            args: parsedArgs,
            result: toolResult,
            error: isError
          }
        });

        this.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: toolResult
        });
      }
    }

    if (step >= this.maxSteps) {
      onEvent?.({
        type: 'status',
        message: `Reached maximum step limit (${this.maxSteps}). Stopping.`
      });
    }

    return finalAssistantText;
  }
}
