import fs from 'node:fs';
import path from 'node:path';
import { exec, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  loadConfig,
  saveConfig,
  loadAuth,
  saveAuth,
  loadModelsCache,
  saveModelsCache,
  getForgeDir,
  getSessionsDir,
  ForgeConfig,
  ModelInfo
} from '../../src/config.js';
import { SessionStore, listSessions, SessionRecord, SessionMeta } from '../../src/store/session.js';
import { AgentLoop, AgentEvent } from '../../src/agent/loop.js';
import { ModelRouter } from '../../src/providers/router.js';
import { isBashAllowlisted, isBashCommandDenied } from '../../src/tools/index.js';

import {
  AgentStatusResponse,
  AgentStatusType,
  PendingPermission,
  ActivityItem,
  TodoItem,
  FileChangeItem,
  TestSummary,
  ProviderStatus,
  AgentSettings,
  PermissionsPolicyResponse,
  SessionDetailResponse,
  TokenUsageStats,
  CompactionStats,
  SessionListItem
} from './types/index.js';
import {
  formatTokens,
  resolveModelContextLimit,
  calculateTokenUsageStats,
  computeSessionTokenStats,
  estimateTokenCount,
  estimateHistoryTokens
} from './token-utils.js';

export function maskApiKey(key?: string): string | null {
  if (!key || key.length === 0) return null;
  if (key.length <= 8) return '••••••••';
  return '••••••••••••' + key.slice(-4);
}

export class PausableModelRouter extends ModelRouter {
  private adapter: ForgeAdapter;

  constructor(adapter: ForgeAdapter) {
    super();
    this.adapter = adapter;
  }

  override async chat(params: any): Promise<any> {
    if (this.adapter.isPausedState()) {
      await this.adapter.waitForResume();
    }
    const estimatedPromptTokens = estimateHistoryTokens(params.messages || []);
    const resp = await super.chat(params);
    this.adapter.recordStepTokenUsage(resp, estimatedPromptTokens, params.model);
    return resp;
  }
}

export class ForgeAdapter extends EventEmitter {
  public readonly projectRoot: string;
  private activeLoop: AgentLoop | null = null;
  private abortController: AbortController | null = null;
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private pauseResolver: (() => void) | null = null;

  private currentTask: string = '';
  private currentOperation: string = '';
  private currentStatus: AgentStatusType = 'IDLE';
  private step: number = 0;
  private maxSteps: number = 30;
  private toolCount: number = 0;
  private startTime: number | null = null;
  private activeSessionId: string | null = null;

  // Token & Context tracking
  private inputTokensCumulative: number = 0;
  private outputTokensCumulative: number = 0;
  private currentContextTokens: number = 0;
  private isActualTokens: boolean = false;
  private compactionCount: number = 0;
  private lastTokensBefore?: number;
  private lastTokensAfter?: number;
  private lastTokensFreed?: number;
  private totalTokensFreed: number = 0;

  private currentActivity: ActivityItem[] = [];
  private currentTodos: TodoItem[] = [];
  private terminalOutput: string = '';
  private latestTestSummary: TestSummary | null = null;

  private sessionApprovedFiles: Set<string> = new Set();
  private pendingPermission: {
    permission: PendingPermission;
    resolve: (approved: boolean) => void;
  } | null = null;
  private defaultNoConfirm: boolean = false;

  private initialUntrackedFiles: Set<string> = new Set();
  private forgeTouchedFiles: Set<string> = new Set();

  constructor(projectRoot: string = process.cwd(), options?: { autoApprove?: boolean }) {
    super();
    this.projectRoot = projectRoot;
    this.defaultNoConfirm = !!options?.autoApprove;
    this.recordBaseline();
  }

  public recordBaseline(): void {
    try {
      const output = execSync('git status --porcelain', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      this.initialUntrackedFiles.clear();
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('?? ')) {
          this.initialUntrackedFiles.add(trimmed.slice(3).trim());
        }
      }
    } catch {
      // not a git repo or git error
    }
  }

  public isPausedState(): boolean {
    return this.isPaused;
  }

  public waitForResume(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pauseResolver = resolve;
    });
  }

  public recordStepTokenUsage(resp: any, estimatedPromptTokens: number, model?: string): void {
    const usage = resp?.usage;
    let promptTokens = estimatedPromptTokens;
    let completionTokens = 0;
    let actualThisStep = false;

    if (usage && typeof usage.promptTokens === 'number' && usage.promptTokens > 0) {
      promptTokens = usage.promptTokens;
      actualThisStep = true;
    }
    if (usage && typeof usage.completionTokens === 'number' && usage.completionTokens > 0) {
      completionTokens = usage.completionTokens;
      actualThisStep = true;
    } else {
      let outputText = resp?.text || '';
      if (resp?.thinking) outputText += resp.thinking;
      if (resp?.toolCalls) outputText += JSON.stringify(resp.toolCalls);
      completionTokens = estimateTokenCount(outputText);
    }

    this.inputTokensCumulative += promptTokens;
    this.outputTokensCumulative += completionTokens;
    this.currentContextTokens = promptTokens + completionTokens;

    if (actualThisStep) {
      this.isActualTokens = true;
    }

    this.emitStateUpdate();
  }

  // --- Status & State ---

  public getStatus(): AgentStatusResponse {
    const config = loadConfig();
    const elapsedTimeMs = this.startTime ? Date.now() - this.startTime : 0;
    const filesChanged = this.getFilesChanged();
    const currentModel = this.activeLoop
      ? (this.activeLoop as any).currentModel || config.defaultModel
      : config.defaultModel;

    const tokenUsage = calculateTokenUsageStats({
      inputTokens: this.inputTokensCumulative,
      outputTokens: this.outputTokensCumulative,
      currentContextTokens: this.currentContextTokens,
      model: currentModel,
      isActual: this.isActualTokens
    });

    const compactions: CompactionStats = {
      count: this.compactionCount,
      lastTokensBefore: this.lastTokensBefore,
      lastTokensAfter: this.lastTokensAfter,
      lastTokensFreed: this.lastTokensFreed,
      totalTokensFreed: this.totalTokensFreed
    };

    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      status: this.currentStatus,
      projectRoot: this.projectRoot,
      currentTask: this.currentTask,
      currentModel,
      currentProvider: config.defaultProvider,
      currentOperation: this.currentOperation,
      step: this.step,
      maxSteps: this.maxSteps,
      toolCount: this.toolCount,
      elapsedTimeMs,
      filesChangedCount: filesChanged.length,
      tokenUsage,
      compactions,
      testStatus: this.latestTestSummary
        ? {
            passed: this.latestTestSummary.passed,
            failed: this.latestTestSummary.failed,
            skipped: this.latestTestSummary.skipped
          }
        : null,
      pendingPermission: this.pendingPermission ? this.pendingPermission.permission : null,
      activeSessionId: this.activeSessionId
    };
  }

  public getCurrentSessionDetail(): SessionDetailResponse | null {
    if (this.activeSessionId) {
      return this.getSessionDetail(this.activeSessionId);
    }
    const all = listSessions();
    if (all.length > 0) {
      return this.getSessionDetail(all[0].id);
    }
    return null;
  }

  // --- Agent Lifecycle ---

  public async runTask(task: string, noConfirm: boolean = false): Promise<string> {
    if (this.isRunning) {
      throw new Error('An agent task is already running');
    }

    const config = loadConfig();
    this.isRunning = true;
    this.isPaused = false;
    this.currentTask = task;
    this.currentOperation = 'Initializing agent...';
    this.currentStatus = 'WORKING';
    this.step = 0;
    this.maxSteps = config.maxSteps || 30;
    this.toolCount = 0;
    this.startTime = Date.now();
    this.currentActivity = [];
    this.currentTodos = [];
    this.terminalOutput = '';
    this.abortController = new AbortController();

    // Reset token metrics for new task
    this.inputTokensCumulative = 0;
    this.outputTokensCumulative = 0;
    this.currentContextTokens = estimateTokenCount(task) + 1200;
    this.isActualTokens = false;
    this.compactionCount = 0;
    this.lastTokensBefore = undefined;
    this.lastTokensAfter = undefined;
    this.lastTokensFreed = undefined;
    this.totalTokensFreed = 0;

    this.recordBaseline();
    const router = new PausableModelRouter(this);
    router.initBootCache().catch(() => {});

    const session = new SessionStore(undefined, {
      cwd: this.projectRoot,
      model: config.defaultModel,
      provider: config.defaultProvider
    });
    this.activeSessionId = session.id;

    const effectiveNoConfirm = noConfirm !== undefined ? noConfirm : this.defaultNoConfirm;
    const confirmConfig = effectiveNoConfirm
      ? { edit: false, bash: false }
      : config.confirm;

    const onConfirm = async (prompt: { type: 'file' | 'bash'; target: string }): Promise<boolean> => {
      // If auto-approved or already approved in session
      if (prompt.type === 'file' && this.sessionApprovedFiles.has(prompt.target)) {
        return true;
      }

      this.currentStatus = 'AWAITING_APPROVAL';
      this.currentOperation = `Awaiting confirmation for ${prompt.type === 'file' ? 'edit' : 'command'}: ${prompt.target}`;
      this.emitStateUpdate();

      const perm: PendingPermission = {
        id: crypto.randomUUID(),
        type: prompt.type,
        target: prompt.target,
        timestamp: Date.now()
      };

      return new Promise<boolean>((resolve) => {
        this.pendingPermission = {
          permission: perm,
          resolve: (approved: boolean) => {
            this.pendingPermission = null;
            this.currentStatus = this.isPaused ? 'PAUSED' : 'WORKING';
            this.emitStateUpdate();
            resolve(approved);
          }
        };

        this.emit('permission_required', perm);
      });
    };

    const onEvent = (event: AgentEvent) => {
      this.handleAgentEvent(event);
    };

    this.activeLoop = new AgentLoop({
      projectRoot: this.projectRoot,
      router,
      session,
      confirmConfig,
      onConfirm,
      onEvent,
      signal: this.abortController.signal
    });

    this.emitStateUpdate();

    try {
      const result = await this.activeLoop.run(task, {
        confirmConfig,
        onConfirm,
        onEvent,
        signal: this.abortController.signal
      });

      this.currentStatus = 'COMPLETED';
      this.currentOperation = 'Task finished successfully';
      return result;
    } catch (err: any) {
      if (this.abortController?.signal.aborted) {
        this.currentStatus = 'IDLE';
        this.currentOperation = 'Task stopped by user';
      } else {
        this.currentStatus = 'ERROR';
        this.currentOperation = `Error: ${err.message}`;
      }
      throw err;
    } finally {
      this.isRunning = false;
      this.isPaused = false;
      this.pauseResolver = null;
      this.activeLoop = null;
      this.abortController = null;
      this.emitStateUpdate();
    }
  }

  private handleAgentEvent(event: AgentEvent) {
    const timestamp = new Date().toLocaleTimeString();

    if (event.type === 'step_start') {
      this.step = event.step;
      this.maxSteps = event.maxSteps;
      this.currentOperation = `Step ${event.step} of ${event.maxSteps}`;
      this.emit('step_start', { step: event.step, maxSteps: event.maxSteps });
    } else if (event.type === 'tool_call_start') {
      this.toolCount++;
      const detail =
        event.args.path ||
        event.args.command ||
        event.args.pattern ||
        (event.args.items ? `${event.args.items.length} items` : '');

      this.currentOperation = `Executing ${event.name}: ${detail}`;

      let actType: ActivityItem['type'] = 'info';
      if (event.name === 'read_file' || event.name === 'list_dir' || event.name === 'glob' || event.name === 'grep') {
        actType = 'read';
      } else if (event.name === 'edit_file' || event.name === 'write_file') {
        actType = 'edit';
      } else if (event.name === 'bash') {
        actType = 'shell';
      }

      const item: ActivityItem = {
        id: event.id || crypto.randomUUID(),
        timestamp,
        type: actType,
        status: 'running',
        title: `${event.name} ${detail}`,
        detail: JSON.stringify(event.args, null, 2),
        toolName: event.name,
        toolArgs: event.args
      };

      if ((event.name === 'edit_file' || event.name === 'write_file') && event.args?.path) {
        this.forgeTouchedFiles.add(event.args.path);
      }

      this.currentActivity.unshift(item);
      this.emit('activity_item', item);

      if (event.name === 'bash') {
        this.appendTerminalOutput(`$ ${event.args.command}\n`);
      }
    } else if (event.type === 'tool_call_result') {
      const match = this.currentActivity.find((a) => a.id === event.id || a.toolName === event.name);
      if (match) {
        match.status = event.error ? 'failed' : 'done';
        match.toolResult = event.result;
        if (event.name === 'edit_file') {
          match.diff = `--- ${match.toolArgs?.path}\n+++ ${match.toolArgs?.path}\n- ${match.toolArgs?.old}\n+ ${match.toolArgs?.new}`;
        }
      }

      if (event.name === 'bash') {
        this.appendTerminalOutput(`${event.result}\n`);
        this.tryParseTestOutput(event.result);
      }

      if (event.name === 'todo' && match?.toolArgs?.items) {
        this.updateTodosFromItems(match.toolArgs.items);
      }

      this.emit('tool_result', event);
    } else if (event.type === 'text') {
      this.emit('text_chunk', event.text);
    } else if (event.type === 'compact') {
      const freed = Math.max(0, event.tokensBefore - event.tokensAfter);
      this.compactionCount++;
      this.lastTokensBefore = event.tokensBefore;
      this.lastTokensAfter = event.tokensAfter;
      this.lastTokensFreed = freed;
      this.totalTokensFreed += freed;
      this.currentContextTokens = event.tokensAfter;

      const item: ActivityItem = {
        id: crypto.randomUUID(),
        timestamp,
        type: 'compact',
        status: 'done',
        title: `Context compacted: ${formatTokens(event.tokensBefore)} → ${formatTokens(event.tokensAfter)} tokens (${formatTokens(freed)} freed)`
      };
      this.currentActivity.unshift(item);
      this.emit('activity_item', item);
    } else if (event.type === 'done') {
      const item: ActivityItem = {
        id: crypto.randomUUID(),
        timestamp,
        type: 'done',
        status: 'done',
        title: 'Task completed',
        detail: event.text
      };
      this.currentActivity.unshift(item);
      this.emit('activity_item', item);
    } else if (event.type === 'error') {
      const item: ActivityItem = {
        id: crypto.randomUUID(),
        timestamp,
        type: 'error',
        status: 'failed',
        title: `Error: ${event.error.message}`
      };
      this.currentActivity.unshift(item);
      this.emit('activity_item', item);
    }

    this.emitStateUpdate();
  }

  private appendTerminalOutput(chunk: string) {
    this.terminalOutput += chunk;
    if (this.terminalOutput.length > 50000) {
      this.terminalOutput = this.terminalOutput.slice(-40000);
    }
    this.emit('terminal_chunk', chunk);
  }

  private updateTodosFromItems(items: Array<string | { text: string; done?: boolean }>) {
    this.currentTodos = items.map((item, idx) => {
      if (typeof item === 'string') {
        return { id: idx + 1, text: item, done: false };
      }
      return { id: idx + 1, text: item.text, done: !!item.done };
    });
    this.emit('todos_update', this.currentTodos);
  }

  private tryParseTestOutput(output: string) {
    const parsed = parseTestOutput(output);
    if (parsed) {
      this.latestTestSummary = parsed;
      this.emit('test_summary', parsed);
    }
  }

  private emitStateUpdate() {
    this.emit('status_update', this.getStatus());
  }

  public pause(): void {
    if (!this.isRunning || this.isPaused) return;
    this.isPaused = true;
    this.currentStatus = 'PAUSED';
    this.currentOperation = 'Agent execution paused';
    this.emitStateUpdate();
  }

  public resume(): void {
    if (!this.isRunning || !this.isPaused) return;
    this.isPaused = false;
    this.currentStatus = this.pendingPermission ? 'AWAITING_APPROVAL' : 'WORKING';
    this.currentOperation = 'Agent execution resumed';
    if (this.pauseResolver) {
      this.pauseResolver();
      this.pauseResolver = null;
    }
    this.emitStateUpdate();
  }

  public stop(): void {
    if (!this.isRunning) return;
    if (this.pendingPermission) {
      this.pendingPermission.resolve(false);
      this.pendingPermission = null;
    }
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isRunning = false;
    this.isPaused = false;
    this.currentStatus = 'IDLE';
    this.currentOperation = 'Agent stopped by user';
    this.emitStateUpdate();
  }

  public approvePermission(id: string, mode: 'once' | 'session' = 'once'): boolean {
    if (!this.pendingPermission || this.pendingPermission.permission.id !== id) {
      return false;
    }
    if (mode === 'session') {
      this.sessionApprovedFiles.add(this.pendingPermission.permission.target);
    }
    this.pendingPermission.resolve(true);
    return true;
  }

  public denyPermission(id: string): boolean {
    if (!this.pendingPermission || this.pendingPermission.permission.id !== id) {
      return false;
    }
    this.pendingPermission.resolve(false);
    return true;
  }

  // --- Sessions Persistence ---

  public getSessions(): SessionListItem[] {
    const list = listSessions();
    const sessionsDir = getSessionsDir();

    return list.map((meta) => {
      if (this.activeSessionId && meta.id === this.activeSessionId) {
        const liveStatus = this.getStatus();
        return {
          ...meta,
          task: this.currentTask || undefined,
          status: this.currentStatus,
          tokenUsage: liveStatus.tokenUsage,
          compactionsCount: this.compactionCount
        };
      }

      const filePath = path.join(sessionsDir, `${meta.id}.jsonl`);
      let task = '';
      let status = 'COMPLETED';
      let records: SessionRecord[] = [];

      if (fs.existsSync(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const lines = raw.split('\n').filter((l) => l.trim().length > 0);
          records = lines.map((l) => JSON.parse(l));
          for (const rec of records) {
            if (rec.type === 'user' && !task) {
              task = rec.data?.content || '';
            } else if (rec.type === 'error') {
              status = 'ERROR';
            }
          }
        } catch {
          // ignore
        }
      }

      const { tokenUsage, compactions } = computeSessionTokenStats(records, meta.model);

      return {
        ...meta,
        task: task || undefined,
        status,
        tokenUsage,
        compactionsCount: compactions.count
      };
    });
  }

  public getSessionDetail(id: string): SessionDetailResponse | null {
    const filePath = path.join(getSessionsDir(), `${id}.jsonl`);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const records: SessionRecord[] = lines.map((l) => JSON.parse(l));

      let task = '';
      let model = '';
      let provider = '';
      let createdAt = '';
      let cwd = this.projectRoot;
      let status = 'COMPLETED';
      let stepCount = 0;
      const touched = new Set<string>();
      const activity: ActivityItem[] = [];
      const todos: TodoItem[] = [];
      let terminalOut = '';
      let testSummary: TestSummary | null = null;

      for (const rec of records) {
        if (rec.type === 'meta') {
          createdAt = rec.data.createdAt || rec.timestamp;
          cwd = rec.data.cwd || cwd;
          model = rec.data.model || model;
          provider = rec.data.provider || provider;
        } else if (rec.type === 'user' && !task) {
          task = rec.data.content || '';
        } else if (rec.type === 'assistant') {
          stepCount++;
          if (rec.data.toolCalls) {
            for (const tc of rec.data.toolCalls) {
              const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments || '{}') : tc.arguments;
              const detail = args.path || args.command || '';
              if (args.path) touched.add(args.path);
              activity.push({
                id: tc.id || crypto.randomUUID(),
                timestamp: rec.timestamp.slice(11, 19),
                type: tc.name === 'bash' ? 'shell' : tc.name.includes('edit') || tc.name.includes('write') ? 'edit' : 'read',
                status: 'done',
                title: `${tc.name} ${detail}`,
                toolName: tc.name,
                toolArgs: args
              });
            }
          }
        } else if (rec.type === 'system' && rec.data?.action === 'compact') {
          const before = rec.data.tokensBefore || 0;
          const after = rec.data.tokensAfter || 0;
          const freed = Math.max(0, before - after);
          activity.push({
            id: crypto.randomUUID(),
            timestamp: rec.timestamp.slice(11, 19),
            type: 'compact',
            status: 'done',
            title: `Context compacted: ${formatTokens(before)} → ${formatTokens(after)} tokens (${formatTokens(freed)} freed)`
          });
        } else if (rec.type === 'tool_result') {
          terminalOut += `${rec.data.result || ''}\n`;
          const parsed = parseTestOutput(rec.data.result || '');
          if (parsed) testSummary = parsed;
        } else if (rec.type === 'error') {
          status = 'ERROR';
          activity.push({
            id: crypto.randomUUID(),
            timestamp: rec.timestamp.slice(11, 19),
            type: 'error',
            status: 'failed',
            title: `Error: ${rec.data.message}`
          });
        }
      }

      let tokenUsage: TokenUsageStats;
      let compactions: CompactionStats;

      if (this.activeSessionId && id === this.activeSessionId) {
        const liveStatus = this.getStatus();
        tokenUsage = liveStatus.tokenUsage;
        compactions = liveStatus.compactions;
      } else {
        const computed = computeSessionTokenStats(records, model);
        tokenUsage = computed.tokenUsage;
        compactions = computed.compactions;
      }

      return {
        id,
        createdAt,
        cwd,
        model,
        provider,
        task,
        status,
        step: stepCount,
        maxSteps: 30,
        activity,
        todos,
        touchedFiles: Array.from(touched),
        terminalOutput: terminalOut,
        testSummary,
        tokenUsage,
        compactions
      };
    } catch {
      return null;
    }
  }

  // --- Git & Files ---

  public getFilesChanged(): FileChangeItem[] {
    try {
      const out = execSync('git status --porcelain', {
        cwd: this.projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });

      const lines = out.split('\n').filter((l) => l.trim().length > 0);
      return lines.map((l) => {
        const status = l.slice(0, 2).trim() as 'M' | 'A' | 'D' | '??';
        const p = l.slice(3).trim();
        return { path: p, status };
      });
    } catch {
      return [];
    }
  }

  public getDiff(file?: string): string {
    if (file) {
      const target = path.resolve(this.projectRoot, file);
      if (!target.startsWith(this.projectRoot) || file.includes('..')) {
        throw new Error('Access denied: target outside project boundary');
      }
      try {
        return execSync(`git diff HEAD -- "${file}"`, {
          cwd: this.projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch {
        return '';
      }
    }

    try {
      return execSync('git diff HEAD', {
        cwd: this.projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      return '';
    }
  }

  public revertFile(file: string): { success: boolean; message: string } {
    if (!file || file.includes('..')) {
      throw new Error('Invalid file path');
    }
    const fullPath = path.resolve(this.projectRoot, file);
    if (!fullPath.startsWith(this.projectRoot)) {
      throw new Error('Access denied: target outside project root');
    }

    // Safety guard: Never revert files that existed as untracked before Forge started
    if (this.initialUntrackedFiles.has(file)) {
      throw new Error(`Cannot revert ${file}: file was untracked before this Forge session started.`);
    }

    let isTracked = false;
    try {
      execSync(`git ls-files --error-unmatch "${file}"`, {
        cwd: this.projectRoot,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      isTracked = true;
    } catch {
      isTracked = false;
    }

    if (isTracked) {
      try {
        execSync(`git checkout HEAD -- "${file}"`, {
          cwd: this.projectRoot,
          stdio: ['ignore', 'pipe', 'ignore']
        });
        this.forgeTouchedFiles.delete(file);
        return { success: true, message: `Reverted Forge changes in ${file}` };
      } catch (err: any) {
        throw new Error(`Failed to checkout ${file}: ${err.message}`);
      }
    } else if (this.forgeTouchedFiles.has(file)) {
      // Safely delete only the specific file created by Forge
      try {
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
        this.forgeTouchedFiles.delete(file);
        return { success: true, message: `Removed file created by Forge: ${file}` };
      } catch (err: any) {
        throw new Error(`Failed to remove file ${file}: ${err.message}`);
      }
    } else {
      throw new Error(`Cannot revert ${file}: file was not modified by Forge in this session.`);
    }
  }

  public revertForgeChanges(): { success: boolean; message: string; revertedCount: number } {
    if (this.forgeTouchedFiles.size === 0) {
      return { success: true, message: 'No file changes attributable to this Forge session.', revertedCount: 0 };
    }

    let count = 0;
    const errors: string[] = [];
    for (const file of Array.from(this.forgeTouchedFiles)) {
      try {
        this.revertFile(file);
        count++;
      } catch (err: any) {
        errors.push(err.message);
      }
    }
    this.forgeTouchedFiles.clear();

    if (errors.length > 0) {
      return {
        success: true,
        message: `Reverted ${count} Forge change(s) with ${errors.length} warning(s).`,
        revertedCount: count
      };
    }

    return {
      success: true,
      message: `Safely reverted ${count} change(s) introduced by Forge.`,
      revertedCount: count
    };
  }

  // Backwards-compatible alias for existing API callers
  public revertAll(): { success: boolean; message: string } {
    const res = this.revertForgeChanges();
    return { success: res.success, message: res.message };
  }

  // --- Tests ---

  public getTestSummary(): TestSummary | null {
    return this.latestTestSummary;
  }

  public async runTests(): Promise<TestSummary> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      exec('npm test', { cwd: this.projectRoot }, (err, stdout, stderr) => {
        const fullOutput = (stdout || '') + '\n' + (stderr || '');
        const summary = parseTestOutput(fullOutput) || {
          passed: err ? 0 : 1,
          failed: err ? 1 : 0,
          skipped: 0,
          total: 1,
          durationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          tests: [],
          rawOutput: fullOutput
        };
        summary.durationMs = Date.now() - startTime;
        summary.rawOutput = fullOutput;
        this.latestTestSummary = summary;
        this.appendTerminalOutput(`$ npm test\n${fullOutput}\n`);
        this.emit('test_summary', summary);
        resolve(summary);
      });
    });
  }

  // --- Models & Providers ---

  public getModelsData() {
    const config = loadConfig();
    const cache = loadModelsCache();

    return {
      defaultModel: config.defaultModel,
      defaultProvider: config.defaultProvider,
      fallbackModels: config.fallbackModels,
      openrouter: cache.openrouter,
      nvidia: cache.nvidia,
      deadModels: cache.deadModels
    };
  }

  public selectDefaultModel(model: string, provider?: 'openrouter' | 'nvidia'): ForgeConfig {
    const config = loadConfig();
    const prov = provider || (model.startsWith('nvidia/') ? 'nvidia' : 'openrouter');
    return saveConfig({
      defaultModel: model,
      defaultProvider: prov
    });
  }

  public setFallbackModels(models: string[]): ForgeConfig {
    return saveConfig({ fallbackModels: models });
  }

  public async refreshModels(): Promise<{ openrouterCount: number; nvidiaCount: number }> {
    const router = new ModelRouter();
    let openrouterCount = 0;
    let nvidiaCount = 0;

    try {
      const or = await router.openrouter.fetchModels();
      openrouterCount = or.length;
    } catch {
      // ignore
    }

    try {
      const nv = await router.nvidia.fetchModels();
      nvidiaCount = nv.length;
    } catch {
      // ignore
    }

    return { openrouterCount, nvidiaCount };
  }

  public getProvidersData(): ProviderStatus[] {
    const auth = loadAuth();
    const orKey = process.env.OPENROUTER_API_KEY || auth.openrouterApiKey;
    const nvKey = process.env.NVIDIA_API_KEY || auth.nvidiaApiKey;

    return [
      {
        provider: 'openrouter',
        configured: !!orKey,
        keyMasked: maskApiKey(orKey)
      },
      {
        provider: 'nvidia',
        configured: !!nvKey,
        keyMasked: maskApiKey(nvKey)
      }
    ];
  }

  public setProviderKey(provider: 'openrouter' | 'nvidia', apiKey: string): { success: boolean; keyMasked: string } {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('API key cannot be empty');
    }
    const cleanKey = apiKey.trim();
    if (provider === 'openrouter') {
      saveAuth({ openrouterApiKey: cleanKey });
      process.env.OPENROUTER_API_KEY = cleanKey;
    } else if (provider === 'nvidia') {
      saveAuth({ nvidiaApiKey: cleanKey });
      process.env.NVIDIA_API_KEY = cleanKey;
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    // If currently in ERROR due to missing API key, automatically clear the error state
    if (this.currentStatus === 'ERROR' && this.currentOperation.toLowerCase().includes('api key not found')) {
      this.currentStatus = 'IDLE';
      this.currentOperation = 'API key saved. Ready to run task.';
    }
    this.emitStateUpdate();

    return { success: true, keyMasked: maskApiKey(cleanKey)! };
  }

  public async testProviderConnection(provider: 'openrouter' | 'nvidia'): Promise<{ ok: boolean; message: string }> {
    const router = new ModelRouter();
    try {
      if (provider === 'openrouter') {
        const models = await router.openrouter.fetchModels();
        return { ok: true, message: `Connected! ${models.length} tool models available.` };
      } else {
        const models = await router.nvidia.fetchModels();
        return { ok: true, message: `Connected! ${models.length} live models available.` };
      }
    } catch (err: any) {
      return { ok: false, message: err.message || 'Connection failed' };
    }
  }

  // --- Settings & Permissions ---

  public getSettings(): AgentSettings {
    const config = loadConfig();
    return {
      maxSteps: config.maxSteps || 30,
      confirm: this.defaultNoConfirm ? { edit: false, bash: false } : config.confirm,
      projectRoot: this.projectRoot,
      historyCompactionThreshold: 0.7,
      bashTimeout: 60,
      security: {
        projectRootGuard: true,
        blockEnv: true,
        blockSsh: true,
        blockDangerousCommands: true
      }
    };
  }

  public updateSettings(updates: Partial<AgentSettings>): ForgeConfig {
    const current = loadConfig();
    const next: Partial<ForgeConfig> = {};
    if (updates.maxSteps !== undefined) {
      next.maxSteps = updates.maxSteps;
    }
    if (updates.confirm) {
      next.confirm = {
        ...current.confirm,
        ...updates.confirm
      };
    }
    return saveConfig(next);
  }

  public getPermissionsPolicy(): PermissionsPolicyResponse {
    const config = loadConfig();
    const isEditAutoApproved = this.defaultNoConfirm || !config.confirm.edit;
    const isBashAutoApproved = this.defaultNoConfirm || !config.confirm.bash;

    return {
      fileEditing: {
        status: isEditAutoApproved ? 'auto_approved' : 'confirm_required',
        rule: 'Exact string-replacement with edit_file or write_file requires user approval'
      },
      bashExecution: {
        status: isBashAutoApproved ? 'auto_approved' : 'confirm_required',
        rule: 'Shell commands require approval unless present on allowlist',
        allowlist: ['ls', 'pwd', 'rg', 'git status', 'git diff', 'npm test', 'npx vitest']
      },
      protectedAssets: [
        { target: '.env / .env.*', description: 'Environment credentials and API keys', locked: true },
        { target: '~/.ssh', description: 'SSH private and public keys', locked: true },
        { target: '*.pem / *.key', description: 'Cryptographic certificates and secrets', locked: true },
        { target: '../ (Path escapes)', description: 'Directory access outside project root', locked: true },
        { target: 'sudo / rm -rf /', description: 'Dangerous and destructive system commands', locked: true }
      ],
      sessionApprovedFiles: Array.from(this.sessionApprovedFiles),
      pendingPermission: this.pendingPermission ? this.pendingPermission.permission : null
    };
  }

  public revokeSessionApproval(file: string): boolean {
    return this.sessionApprovedFiles.delete(file);
  }
}

export function parseTestOutput(output: string): TestSummary | null {
  if (!output) return null;

  // Vitest / Jest style summary parser
  // e.g., "Tests  7 passed (7)" or "Tests: 142 passed, 2 failed, 8 skipped"
  const vitestMatch = output.match(/Tests\s+(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+skipped)?/i);
  const vitestSummaryMatch = output.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/i);
  const jestMatch = output.match(/Tests:\s*(?:(\d+)\s*passed,?)?\s*(?:(\d+)\s*failed,?)?\s*(?:(\d+)\s*skipped,?)?/i);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  if (vitestSummaryMatch) {
    passed = parseInt(vitestSummaryMatch[1], 10) || 0;
  } else if (vitestMatch) {
    passed = parseInt(vitestMatch[1], 10) || 0;
    failed = parseInt(vitestMatch[2] || '0', 10) || 0;
    skipped = parseInt(vitestMatch[3] || '0', 10) || 0;
  } else if (jestMatch) {
    passed = parseInt(jestMatch[1] || '0', 10) || 0;
    failed = parseInt(jestMatch[2] || '0', 10) || 0;
    skipped = parseInt(jestMatch[3] || '0', 10) || 0;
  } else if (output.includes('✓') || output.includes('PASS') || output.includes('FAIL')) {
    const passMatches = output.match(/✓|PASS/g) || [];
    const failMatches = output.match(/✗|FAIL/g) || [];
    passed = passMatches.length;
    failed = failMatches.length;
  } else {
    return null;
  }

  const tests: Array<{ name: string; suite: string; status: 'passed' | 'failed' | 'skipped' }> = [];
  const lines = output.split('\n');
  for (const l of lines) {
    const trimmed = l.trim();
    if (trimmed.startsWith('✓') || trimmed.includes('PASS')) {
      tests.push({
        name: trimmed.replace(/^[✓\sPASS]+/, '').trim(),
        suite: 'default',
        status: 'passed'
      });
    } else if (trimmed.startsWith('✗') || trimmed.includes('FAIL')) {
      tests.push({
        name: trimmed.replace(/^[✗\sFAIL]+/, '').trim(),
        suite: 'default',
        status: 'failed'
      });
    }
  }

  return {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    timestamp: new Date().toISOString(),
    tests
  };
}
