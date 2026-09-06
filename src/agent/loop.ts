import { loadConfig, getModelContextWindow } from '../config.js';
import { SessionStore } from '../store/session.js';
import { TOOLS } from '../tools/definitions.js';
import {
  executeToolDetailed,
  ToolContext,
  SecurityError,
  ToolDeniedError,
  ConfirmRequest
} from '../tools/index.js';
import { ChatMessage, ToolCallData, UsageData } from '../providers/types.js';
import { ModelRouter, RoutingError } from '../providers/router.js';
import { classifyError, isAbortError } from '../providers/errors.js';
import { ContextBuilder } from './context.js';
import {
  compactHistory,
  estimateTokenCount,
  estimateHistoryTokens,
  repairToolPairing
} from './compact.js';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface TokenUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  currentContextTokens: number;
  contextWindow: number;
  isActual: boolean;
}

export interface CompactionStats {
  count: number;
  lastTokensBefore?: number;
  lastTokensAfter?: number;
  lastTokensFreed?: number;
  totalTokensFreed: number;
}

export type AgentEvent =
  | { type: 'step_start'; step: number; maxSteps: number }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  /** Discard any text/thinking accumulated for the current step (model fallback). */
  | { type: 'stream_reset' }
  | { type: 'tool_call_start'; id: string; name: string; args: Record<string, unknown> }
  | {
      type: 'tool_call_result';
      id: string;
      name: string;
      result: string;
      error?: boolean;
      denied?: boolean;
    }
  | { type: 'todos'; todos: string[] }
  | { type: 'compact'; tokensBefore: number; tokensAfter: number; reason: 'threshold' | 'overflow' | 'manual' }
  | { type: 'token_usage'; tokenUsage: TokenUsageSnapshot; compactions: CompactionStats }
  | { type: 'model_changed'; from: string; to: string }
  | { type: 'status'; message: string }
  | { type: 'done'; text: string }
  | { type: 'cancelled'; text: string }
  | { type: 'error'; error: Error };

export type RunOutcome = 'completed' | 'cancelled' | 'max_steps' | 'error';

export interface RunResult {
  outcome: RunOutcome;
  text: string;
  steps: number;
  error?: Error;
}

export interface AgentLoopOptions {
  projectRoot?: string;
  model?: string;
  router?: ModelRouter;
  session?: SessionStore;
  maxSteps?: number;
  initialMessages?: ChatMessage[];
  initialTouchedFiles?: Iterable<string>;
  resumedNote?: string;
  confirmConfig?: { edit: boolean; bash: boolean };
  onConfirm?: (req: ConfirmRequest) => Promise<boolean>;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Override the context window used for compaction decisions. */
  contextWindow?: number;
  /** Compaction threshold as a fraction of the context window (default 0.7). */
  compactThreshold?: number;
}

export type RunOptions = Partial<
  Pick<AgentLoopOptions, 'model' | 'confirmConfig' | 'onConfirm' | 'onEvent' | 'signal'>
>;

const TOOL_FAILURE_LIMIT = 2;
const DENIAL_LIMIT = 2;

function isToolErrorText(text: string): boolean {
  return /^(Error:|Command failed|Command timed out|Command cancelled|Tool execution error|Permission denied|Cancelled)/.test(text);
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export class AgentLoop {
  public readonly projectRoot: string;
  public readonly session: SessionStore;
  public readonly router: ModelRouter;

  private readonly context: ContextBuilder;
  private allowedFiles = new Set<string>();
  private touchedFiles: Set<string>;
  private failedToolCounts = new Map<string, number>();
  private messages: ChatMessage[] = [];
  private todos: string[] = [];
  private resumedNote?: string;
  private currentModel: string;
  private maxSteps: number;
  private defaultConfirmConfig?: { edit: boolean; bash: boolean };
  private defaultOnConfirm?: (req: ConfirmRequest) => Promise<boolean>;
  private defaultOnEvent?: (event: AgentEvent) => void;
  private contextWindowOverride?: number;
  private compactThreshold: number;
  private running = false;

  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  private currentContextTokens = 0;
  private isActualTokens = false;
  private compactionCount = 0;
  private totalTokensFreed = 0;
  private lastTokensBefore?: number;
  private lastTokensAfter?: number;

  constructor(options?: AgentLoopOptions) {
    const config = loadConfig();
    this.projectRoot = options?.projectRoot || process.cwd();
    this.currentModel = options?.model || config.defaultModel;
    this.maxSteps = options?.maxSteps || config.maxSteps || 30;
    this.router = options?.router || new ModelRouter();
    this.defaultConfirmConfig = options?.confirmConfig;
    this.defaultOnConfirm = options?.onConfirm;
    this.defaultOnEvent = options?.onEvent;
    this.contextWindowOverride = options?.contextWindow;
    this.compactThreshold = options?.compactThreshold ?? 0.7;
    this.context = new ContextBuilder(this.projectRoot);
    this.touchedFiles = new Set(options?.initialTouchedFiles || []);
    this.resumedNote = options?.resumedNote;
    this.session =
      options?.session ||
      new SessionStore(undefined, {
        cwd: this.projectRoot,
        model: this.currentModel,
        provider: config.defaultProvider
      });

    if (options?.initialMessages) {
      // Copy so we never mutate the caller's array; repair pairing defensively.
      this.messages = repairToolPairing(options.initialMessages.map((m) => ({ ...m })));
    }
  }

  /**
   * Resume a previously recorded session. Returns null if the session does not exist.
   */
  public static resume(sessionId: string, options?: Omit<AgentLoopOptions, 'session' | 'initialMessages'>): AgentLoop | null {
    const store = SessionStore.load(sessionId);
    if (!store) return null;
    const meta = store.getMeta();
    const messages = store.toMessages();
    const touched = store.getTouchedFiles();
    const turns = messages.filter((m) => m.role === 'user').length;
    return new AgentLoop({
      ...options,
      projectRoot: options?.projectRoot || meta?.cwd || process.cwd(),
      model: options?.model || meta?.model,
      session: store,
      initialMessages: messages,
      initialTouchedFiles: touched,
      resumedNote: `This session was resumed from disk (${turns} earlier user turn${turns === 1 ? '' : 's'}). Earlier tool results reflect the state at that time; re-read files before editing.`
    });
  }

  // ---------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------

  public getMessages(): ChatMessage[] {
    return this.messages;
  }

  public getTouchedFiles(): Set<string> {
    return this.touchedFiles;
  }

  public getTodos(): string[] {
    return [...this.todos];
  }

  public getModel(): string {
    return this.currentModel;
  }

  public setModel(model: string): void {
    this.currentModel = model;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getContextWindow(): number {
    return this.contextWindowOverride ?? getModelContextWindow(this.currentModel);
  }

  public getTokenUsage(): TokenUsageSnapshot {
    return {
      inputTokens: this.cumulativeInputTokens,
      outputTokens: this.cumulativeOutputTokens,
      totalTokens: this.cumulativeInputTokens + this.cumulativeOutputTokens,
      currentContextTokens: this.currentContextTokens,
      contextWindow: this.getContextWindow(),
      isActual: this.isActualTokens
    };
  }

  private compactionStats(): CompactionStats {
    return {
      count: this.compactionCount,
      lastTokensBefore: this.lastTokensBefore,
      lastTokensAfter: this.lastTokensAfter,
      lastTokensFreed:
        this.lastTokensBefore !== undefined && this.lastTokensAfter !== undefined
          ? Math.max(0, this.lastTokensBefore - this.lastTokensAfter)
          : undefined,
      totalTokensFreed: this.totalTokensFreed
    };
  }

  // ---------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------

  /**
   * Compact history. `force` compacts regardless of the threshold (used by
   * /compact and by context-length recovery). Returns whether anything changed.
   */
  public compact(
    force: boolean = false,
    onEvent?: (e: AgentEvent) => void,
    reason: 'threshold' | 'overflow' | 'manual' = force ? 'manual' : 'threshold'
  ): { compacted: boolean; tokensBefore: number; tokensAfter: number } {
    const window = this.getContextWindow();
    const keepRecent = reason === 'overflow' ? 2 : 6;
    const res = compactHistory(this.messages, window, force ? 0 : this.compactThreshold, keepRecent);
    if (!res.compacted) {
      return { compacted: false, tokensBefore: res.tokensBefore, tokensAfter: res.tokensAfter };
    }
    this.messages = res.messages;
    this.compactionCount++;
    const freed = Math.max(0, res.tokensBefore - res.tokensAfter);
    this.totalTokensFreed += freed;
    this.lastTokensBefore = res.tokensBefore;
    this.lastTokensAfter = res.tokensAfter;
    this.currentContextTokens = res.tokensAfter;

    const emit = onEvent || this.defaultOnEvent;
    emit?.({ type: 'compact', tokensBefore: res.tokensBefore, tokensAfter: res.tokensAfter, reason });
    emit?.({ type: 'token_usage', tokenUsage: this.getTokenUsage(), compactions: this.compactionStats() });
    this.session.append({
      timestamp: new Date().toISOString(),
      type: 'system',
      data: {
        action: 'compact',
        reason,
        tokensBefore: res.tokensBefore,
        tokensAfter: res.tokensAfter,
        summary: res.messages.find((m) => m.role === 'assistant' && m.content?.startsWith('[CONVERSATION HISTORY COMPACTED'))?.content
      }
    });
    return { compacted: true, tokensBefore: res.tokensBefore, tokensAfter: res.tokensAfter };
  }

  // ---------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------

  /** Backwards-compatible entry point returning the final assistant text. */
  public async run(prompt: string, options?: RunOptions): Promise<string> {
    const result = await this.runTask(prompt, options);
    if (result.outcome === 'error' && result.error) throw result.error;
    return result.text;
  }

  public async runTask(prompt: string, options?: RunOptions): Promise<RunResult> {
    if (this.running) {
      throw new Error('AgentLoop.run called while a run is already in progress.');
    }
    this.running = true;
    try {
      return await this.runInternal(prompt, options);
    } finally {
      this.running = false;
    }
  }

  private syncSystemPrompt(): void {
    const content = this.context.build({
      touchedFiles: this.touchedFiles,
      todos: this.todos,
      resumedNote: this.resumedNote
    });
    if (this.messages.length === 0 || this.messages[0].role !== 'system') {
      this.messages.unshift({ role: 'system', content });
    } else {
      this.messages[0] = { ...this.messages[0], content };
    }
  }

  private async runInternal(prompt: string, options?: RunOptions): Promise<RunResult> {
    if (options?.model) this.currentModel = options.model;
    const config = loadConfig();
    const confirmConfig = options?.confirmConfig || this.defaultConfirmConfig || config.confirm;
    const onConfirm = options?.onConfirm || this.defaultOnConfirm;
    const onEvent = options?.onEvent || this.defaultOnEvent;
    const signal = options?.signal;
    const emit = (e: AgentEvent) => onEvent?.(e);

    this.syncSystemPrompt();
    this.messages.push({ role: 'user', content: prompt });
    this.session.append({ timestamp: new Date().toISOString(), type: 'user', data: { content: prompt } });

    this.currentContextTokens = estimateHistoryTokens(this.messages);
    emit({ type: 'token_usage', tokenUsage: this.getTokenUsage(), compactions: this.compactionStats() });

    const toolCtx: ToolContext = {
      projectRoot: this.projectRoot,
      allowedFiles: this.allowedFiles,
      confirmConfig,
      onConfirm,
      touchedFiles: this.touchedFiles,
      signal,
      bashTimeoutMs: config.bashTimeoutMs,
      onTodosUpdate: (todos) => {
        this.todos = todos;
        emit({ type: 'todos', todos: [...todos] });
      }
    };

    let step = 0;
    let finalText = '';
    let denials = 0;
    let overflowRetries = 0;

    const finish = (outcome: RunOutcome, error?: Error): RunResult => {
      if (outcome === 'cancelled') emit({ type: 'cancelled', text: finalText });
      else if (outcome === 'completed') emit({ type: 'done', text: finalText });
      else if (outcome === 'max_steps') {
        emit({ type: 'status', message: `Reached maximum step limit (${this.maxSteps}). Stopping.` });
        emit({ type: 'done', text: finalText });
      }
      return { outcome, text: finalText, steps: step, error };
    };

    while (step < this.maxSteps) {
      if (signal?.aborted) return finish('cancelled');

      step++;
      emit({ type: 'step_start', step, maxSteps: this.maxSteps });
      this.syncSystemPrompt();
      this.compact(false, onEvent, 'threshold');

      // ---- Model call -------------------------------------------------
      let text = '';
      let thinking = '';
      let toolCalls: ToolCallData[] = [];
      let usage: UsageData | undefined;
      let streamUsage: UsageData | undefined;
      let partialText = '';

      try {
        const resp = await this.router.chat({
          model: this.currentModel,
          messages: this.messages,
          tools: TOOLS,
          stream: true,
          signal,
          onEvent: (ev) => {
            switch (ev.type) {
              case 'text':
                partialText += ev.text;
                emit({ type: 'text', text: ev.text });
                break;
              case 'thinking':
                emit({ type: 'thinking', text: ev.text });
                break;
              case 'usage':
                streamUsage = ev.usage;
                break;
              case 'status':
                emit({ type: 'status', message: ev.message });
                break;
              case 'reset':
                partialText = '';
                emit({ type: 'stream_reset' });
                break;
              default:
                break;
            }
          }
        });
        text = resp.text;
        thinking = resp.thinking;
        toolCalls = resp.toolCalls;
        usage = resp.usage || streamUsage;
        if (resp.finalModel && resp.finalModel !== this.currentModel) {
          emit({ type: 'model_changed', from: this.currentModel, to: resp.finalModel });
          this.currentModel = resp.finalModel;
        }
      } catch (err) {
        const error = err as Error;

        if (isAbortError(error) || signal?.aborted) {
          // Preserve whatever the model managed to say so the transcript is coherent.
          if (partialText.trim()) {
            this.messages.push({ role: 'assistant', content: partialText });
            this.session.append({
              timestamp: new Date().toISOString(),
              type: 'assistant',
              data: { text: partialText, interrupted: true }
            });
            finalText = partialText;
          }
          return finish('cancelled');
        }

        const classified = err instanceof RoutingError ? err.classified : classifyError(err);
        if (classified.kind === 'context_length' && overflowRetries < 2) {
          overflowRetries++;
          emit({ type: 'status', message: 'Prompt exceeded the model context window; compacting history and retrying...' });
          const res = this.compact(true, onEvent, 'overflow');
          if (res.compacted) {
            step--; // this step did not consume a model turn
            continue;
          }
          // Nothing left to compact: last resort, drop the oldest non-system turns.
          if (this.dropOldestTurns()) {
            step--;
            continue;
          }
        }

        emit({ type: 'error', error });
        this.session.append({
          timestamp: new Date().toISOString(),
          type: 'error',
          data: { message: error.message, kind: classified.kind, status: classified.status }
        });
        return finish('error', error);
      }

      // ---- Usage accounting --------------------------------------------
      let stepIn: number;
      let stepOut: number;
      if (usage && usage.promptTokens > 0) {
        this.isActualTokens = true;
        stepIn = usage.promptTokens;
        stepOut = usage.completionTokens || 0;
      } else {
        stepIn = estimateHistoryTokens(this.messages);
        stepOut =
          estimateTokenCount(text) +
          estimateTokenCount(thinking) +
          estimateTokenCount(JSON.stringify(toolCalls));
      }
      this.cumulativeInputTokens += stepIn;
      this.cumulativeOutputTokens += stepOut;
      this.currentContextTokens = stepIn + stepOut;
      emit({ type: 'token_usage', tokenUsage: this.getTokenUsage(), compactions: this.compactionStats() });

      // ---- Record assistant turn ----------------------------------------
      if (text) finalText = text;
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: text || null,
        tool_calls:
          toolCalls.length > 0
            ? toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments }
              }))
            : undefined
      };
      this.messages.push(assistantMsg);
      this.session.append({
        timestamp: new Date().toISOString(),
        type: 'assistant',
        data: {
          text,
          thinking,
          toolCalls,
          model: this.currentModel,
          usage: usage || { promptTokens: stepIn, completionTokens: stepOut, totalTokens: stepIn + stepOut }
        }
      });

      if (toolCalls.length === 0) return finish('completed');

      // ---- Execute tool calls -------------------------------------------
      let cancelled = false;
      let stopForDenials = false;

      for (const tc of toolCalls) {
        let result: { content: string; isError: boolean; denied?: boolean };
        let parsedArgs: Record<string, unknown> = {};

        if (cancelled || signal?.aborted) {
          cancelled = true;
          result = { content: 'Cancelled by user before execution.', isError: true };
          this.pushToolResult(tc, parsedArgs, result, emit, false);
          continue;
        }
        if (stopForDenials) {
          result = { content: 'Skipped: user denied a previous action in this step.', isError: true };
          this.pushToolResult(tc, parsedArgs, result, emit, false);
          continue;
        }

        const parsed = parseToolArgs(tc.arguments);
        if (!parsed.ok) {
          parsedArgs = {};
          emit({ type: 'tool_call_start', id: tc.id, name: tc.name, args: parsedArgs });
          result = {
            content: `Error: could not parse arguments for ${tc.name} as JSON (${parsed.error}). Re-issue the call with valid JSON arguments.`,
            isError: true
          };
          this.pushToolResult(tc, parsedArgs, result, emit);
          continue;
        }
        parsedArgs = parsed.value;
        emit({ type: 'tool_call_start', id: tc.id, name: tc.name, args: parsedArgs });

        const failKey = `${tc.name}:${stableStringify(parsedArgs)}`;
        const prevFailCount = this.failedToolCounts.get(failKey) || 0;

        if (prevFailCount >= TOOL_FAILURE_LIMIT) {
          result = {
            content: `Error: Tool "${tc.name}" with these exact arguments has already failed ${prevFailCount} times. Do not repeat it. Explain the failure and try a different approach.`,
            isError: true
          };
        } else {
          try {
            const r = await executeToolDetailed(tc.name, parsedArgs, toolCtx);
            result = r.isError || isToolErrorText(r.content) ? { ...r, isError: true } : r;
            if (result.isError) this.failedToolCounts.set(failKey, prevFailCount + 1);
            else this.failedToolCounts.delete(failKey);
          } catch (err) {
            if (err instanceof ToolDeniedError) {
              denials++;
              result = { content: `Denied by user: ${err.message}`, isError: true, denied: true };
              this.failedToolCounts.set(failKey, prevFailCount + 1);
              if (denials >= DENIAL_LIMIT) stopForDenials = true;
            } else if (err instanceof SecurityError) {
              result = { content: `${err.message}`, isError: true };
              this.failedToolCounts.set(failKey, prevFailCount + 1);
            } else if (isAbortError(err) || signal?.aborted) {
              cancelled = true;
              result = { content: 'Cancelled by user.', isError: true };
            } else {
              result = { content: `Tool execution error: ${(err as Error).message}`, isError: true };
              this.failedToolCounts.set(failKey, prevFailCount + 1);
            }
          }
        }

        if (tc.name === 'write_file' || tc.name === 'edit_file') this.context.invalidate();
        this.pushToolResult(tc, parsedArgs, result, emit);
      }

      if (cancelled) return finish('cancelled');
      if (stopForDenials) {
        emit({ type: 'status', message: 'Stopped: multiple actions were denied. Tell the agent how to proceed.' });
        return finish('completed');
      }
    }

    return finish('max_steps');
  }

  private pushToolResult(
    tc: ToolCallData,
    args: Record<string, unknown>,
    result: { content: string; isError: boolean; denied?: boolean },
    emit: (e: AgentEvent) => void,
    startAlreadyEmitted: boolean = true
  ): void {
    if (!startAlreadyEmitted) emit({ type: 'tool_call_start', id: tc.id, name: tc.name, args });
    emit({
      type: 'tool_call_result',
      id: tc.id,
      name: tc.name,
      result: result.content,
      error: result.isError,
      denied: result.denied
    });
    this.session.append({
      timestamp: new Date().toISOString(),
      type: 'tool_result',
      data: { id: tc.id, name: tc.name, args, result: result.content, error: result.isError, denied: result.denied }
    });
    this.messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: result.content });
  }

  /** Emergency: remove the oldest user/assistant/tool turns after the first user message. */
  private dropOldestTurns(): boolean {
    const hasSystem = this.messages[0]?.role === 'system';
    const start = hasSystem ? 2 : 1; // keep system + initial user request
    if (this.messages.length - start <= 2) return false;
    // Remove one "turn": a message plus any tool results that depend on it.
    const removed = this.messages.splice(start, 1)[0];
    if (removed?.role === 'assistant' && removed.tool_calls) {
      const ids = new Set(removed.tool_calls.map((t) => t.id));
      this.messages = this.messages.filter((m) => !(m.role === 'tool' && m.tool_call_id && ids.has(m.tool_call_id)));
    }
    this.messages = repairToolPairing(this.messages);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseToolArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || !raw.trim()) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
    return { ok: false, error: 'arguments must be a JSON object' };
  } catch (err) {
    // Some models emit concatenated JSON objects for parallel calls; take the first.
    const m = raw.match(/^\s*(\{[\s\S]*?\})\s*(\{|$)/);
    if (m) {
      try {
        const v = JSON.parse(m[1]);
        if (v && typeof v === 'object') return { ok: true, value: v as Record<string, unknown> };
      } catch {}
    }
    return { ok: false, error: (err as Error).message };
  }
}

function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(obj, keys);
}
