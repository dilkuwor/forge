import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ForgeAdapter } from './forge-adapter.js';
import {
  ActiveSessionInfo,
  RegisterSessionRequest,
  SessionUpdateRequest,
  AgentStatusResponse,
  SessionDetailResponse,
  ActivityItem,
  TodoItem,
  PendingPermission,
  FileChangeItem
} from './types/index.js';
import { loadConfig } from '../../src/config.js';

interface ActiveSessionInternal {
  info: ActiveSessionInfo;
  activity: ActivityItem[];
  todos: TodoItem[];
  terminalOutput: string;
  touchedFiles: Set<string>;
  pendingPermission: PendingPermission | null;
  adapter: ForgeAdapter;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ActiveSessionInternal>();
  private selectedSessionId: string | null = null;
  constructor(defaultAdapterOrProjectRoot: ForgeAdapter | string, options?: { autoApprove?: boolean }) {
    super();
    if (typeof defaultAdapterOrProjectRoot === 'string') {
      this.defaultAdapter = new ForgeAdapter(defaultAdapterOrProjectRoot, options);
    } else {
      this.defaultAdapter = defaultAdapterOrProjectRoot;
    }
    this.setupDefaultHostSession();
  }

  public getDefaultAdapter(): ForgeAdapter {
    return this.defaultAdapter;
  }

  private setupDefaultHostSession() {
    const config = loadConfig();
    const sessionId =
      (typeof this.defaultAdapter.getActiveSessionId === 'function'
        ? this.defaultAdapter.getActiveSessionId()
        : null) || `session-host-${process.pid}`;
    const workspace = this.defaultAdapter.projectRoot;
    const workspaceName = path.basename(workspace) || 'workspace';

    this.registerSession(
      {
        sessionId,
        terminalId: `Terminal #1 (PID ${process.pid})`,
        pid: process.pid,
        workspace,
        workspaceName,
        model: config.defaultModel,
        provider: config.defaultProvider,
        status: this.defaultAdapter.getStatus().status
      },
      this.defaultAdapter
    );
  }

  public registerSession(req: RegisterSessionRequest, existingAdapter?: ForgeAdapter): ActiveSessionInfo {
    const config = loadConfig();
    const now = Date.now();
    const workspace = req.workspace || process.cwd();
    const workspaceName = req.workspaceName || path.basename(workspace) || 'workspace';
    const adapter = existingAdapter || new ForgeAdapter(workspace);

    const info: ActiveSessionInfo = {
      sessionId: req.sessionId,
      terminalId: req.terminalId || `Terminal (PID ${req.pid || process.pid})`,
      pid: req.pid || process.pid,
      workspace,
      workspaceName,
      status: req.status || 'IDLE',
      currentTask: '',
      currentOperation: 'Ready',
      model: req.model || config.defaultModel,
      provider: req.provider || config.defaultProvider,
      step: 0,
      maxSteps: config.maxSteps || 30,
      toolCount: 0,
      filesChangedCount: 0,
      elapsedTimeMs: 0,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        currentContextTokens: 0,
        modelContextLimit: 32768,
        utilizationPercent: 0,
        estimatedRemainingTokens: 32768,
        isActual: false
      },
      compactions: {
        count: 0,
        totalTokensFreed: 0
      },
      registeredAt: now,
      lastHeartbeat: now,
      isHost: req.pid === process.pid
    };

    const internal: ActiveSessionInternal = {
      info,
      activity: [],
      todos: [],
      terminalOutput: '',
      touchedFiles: new Set<string>(),
      pendingPermission: null,
      adapter
    };

    this.sessions.set(req.sessionId, internal);

    // If no selected session or currently selected is host placeholder, select this session
    if (!this.selectedSessionId || this.sessions.size === 1 || this.selectedSessionId.startsWith('session-host-')) {
      this.selectedSessionId = req.sessionId;
    }

    this.emit('sessions_changed', this.getActiveSessions());
    this.emit('session_registered', info);
    return info;
  }

  public unregisterSession(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;

    existing.info.status = 'COMPLETED';
    this.sessions.delete(sessionId);

    if (this.selectedSessionId === sessionId) {
      const remaining = Array.from(this.sessions.keys());
      this.selectedSessionId = remaining.length > 0 ? remaining[0] : null;
    }

    this.emit('sessions_changed', this.getActiveSessions());
  }

  public updateSession(sessionId: string, update: SessionUpdateRequest): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      // Auto-register if not already registered
      this.registerSession({ sessionId });
      session = this.sessions.get(sessionId)!;
    }

    session.info.lastHeartbeat = Date.now();

    if (update.status !== undefined) session.info.status = update.status;
    if (update.currentTask !== undefined) session.info.currentTask = update.currentTask;
    if (update.currentOperation !== undefined) session.info.currentOperation = update.currentOperation;
    if (update.model !== undefined) session.info.model = update.model;
    if (update.provider !== undefined) session.info.provider = update.provider;
    if (update.step !== undefined) session.info.step = update.step;
    if (update.maxSteps !== undefined) session.info.maxSteps = update.maxSteps;
    if (update.toolCount !== undefined) session.info.toolCount = update.toolCount;
    if (update.elapsedTimeMs !== undefined) session.info.elapsedTimeMs = update.elapsedTimeMs;
    if (update.filesChangedCount !== undefined) session.info.filesChangedCount = update.filesChangedCount;

    if (update.tokenUsage) {
      session.info.tokenUsage = {
        ...session.info.tokenUsage,
        ...update.tokenUsage
      };
    }

    if (update.compactions) {
      session.info.compactions = {
        ...session.info.compactions,
        ...update.compactions
      };
    }

    if (update.activityItem) {
      // Prevent duplicates
      if (!session.activity.some((a) => a.id === update.activityItem!.id)) {
        session.activity.unshift(update.activityItem);
        if (session.activity.length > 100) {
          session.activity.pop();
        }
      }
    }

    if (update.todoItems) {
      session.todos = update.todoItems;
    }

    if (update.terminalChunk) {
      session.terminalOutput = (session.terminalOutput + update.terminalChunk).slice(-50000);
    }

    if (update.touchedFile) {
      session.touchedFiles.add(update.touchedFile);
      session.info.filesChangedCount = session.touchedFiles.size;
    }

    if (update.pendingPermission !== undefined) {
      session.pendingPermission = update.pendingPermission;
    }

    this.emit('session_updated', {
      sessionId,
      info: session.info,
      activity: session.activity,
      todos: session.todos,
      terminalOutput: session.terminalOutput
    });
  }

  public recordHeartbeat(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.info.lastHeartbeat = Date.now();
    }
  }

  public selectSession(sessionId: string): boolean {
    if (this.sessions.has(sessionId)) {
      this.selectedSessionId = sessionId;
      this.emit('selected_session_changed', sessionId);
      return true;
    }
    return false;
  }

  public getSelectedSessionId(): string | null {
    return this.selectedSessionId;
  }

  public getActiveSessions(): (ActiveSessionInfo & { id: string })[] {
    this.pruneDeadSessions();
    return Array.from(this.sessions.values()).map((s) => ({
      ...s.info,
      id: s.info.sessionId,
      isSelected: s.info.sessionId === this.selectedSessionId
    }));
  }

  private pruneDeadSessions() {
    const now = Date.now();
    for (const [id, s] of this.sessions.entries()) {
      if (s.info.isHost) continue; // Keep host session alive
      // If inactive for > 60 seconds
      if (now - s.info.lastHeartbeat > 60000) {
        if (s.info.pid) {
          try {
            process.kill(s.info.pid, 0); // Check if process exists
          } catch (err: any) {
            if (err.code === 'ESRCH') {
              // Process no longer exists, prune it
              this.unregisterSession(id);
            }
          }
        }
      }
    }
  }

  public getSession(sessionId?: string): ActiveSessionInternal | undefined {
    const targetId = sessionId || this.selectedSessionId;
    if (targetId && this.sessions.has(targetId)) {
      return this.sessions.get(targetId);
    }
    // Fallback to first available session
    const first = this.sessions.values().next().value;
    return first;
  }

  public getAdapter(sessionId?: string): ForgeAdapter {
    const session = this.getSession(sessionId);
    if (session?.adapter) {
      return session.adapter;
    }
    return this.defaultAdapter;
  }

  public getStatus(sessionId?: string): AgentStatusResponse {
    const session = this.getSession(sessionId);
    const activeSessions = this.getActiveSessions();
    const adapterStatus = (session?.adapter || this.defaultAdapter).getStatus();

    if (!session) {
      return {
        ...adapterStatus,
        activeSessions,
        selectedSessionId: this.selectedSessionId || undefined
      };
    }

    return {
      isRunning: session.info.status === 'WORKING',
      isPaused: session.info.status === 'PAUSED',
      status: session.info.status,
      projectRoot: session.info.workspace,
      currentTask: session.info.currentTask || '',
      currentModel: session.info.model,
      currentProvider: session.info.provider,
      currentOperation: session.info.currentOperation || '',
      step: session.info.step,
      maxSteps: session.info.maxSteps,
      toolCount: session.info.toolCount,
      elapsedTimeMs: session.info.elapsedTimeMs,
      filesChangedCount: session.info.filesChangedCount,
      tokenUsage: session.info.tokenUsage,
      compactions: session.info.compactions,
      testStatus: adapterStatus.testStatus,
      pendingPermission: session.pendingPermission,
      activeSessionId: session.info.sessionId,
      terminalId: session.info.terminalId,
      pid: session.info.pid,
      workspace: session.info.workspace,
      workspaceName: session.info.workspaceName,
      activeSessions,
      selectedSessionId: session.info.sessionId
    };
  }

  public getSessionDetail(sessionId?: string): SessionDetailResponse | { message: string } {
    const session = this.getSession(sessionId);
    if (!session) {
      return { message: 'No active session found' };
    }

    return {
      id: session.info.sessionId,
      createdAt: new Date(session.info.registeredAt).toISOString(),
      cwd: session.info.workspace,
      model: session.info.model,
      provider: session.info.provider,
      task: session.info.currentTask || '',
      status: session.info.status,
      step: session.info.step,
      maxSteps: session.info.maxSteps,
      activity: session.activity,
      todos: session.todos,
      touchedFiles: Array.from(session.touchedFiles),
      terminalOutput: session.terminalOutput,
      testSummary: session.adapter.getTestSummary() || null,
      tokenUsage: session.info.tokenUsage,
      compactions: session.info.compactions
    };
  }

  public getActivity(sessionId?: string): ActivityItem[] {
    const session = this.getSession(sessionId);
    return session ? session.activity : [];
  }

  public getTodos(sessionId?: string): TodoItem[] {
    const session = this.getSession(sessionId);
    return session ? session.todos : [];
  }

  public getTerminalOutput(sessionId?: string): string {
    const session = this.getSession(sessionId);
    return session ? session.terminalOutput : '';
  }

  public getFilesChanged(sessionId?: string): FileChangeItem[] {
    const adapter = this.getAdapter(sessionId);
    return adapter.getFilesChanged();
  }

  public getDiff(sessionId?: string, file?: string): { diff: string } {
    const adapter = this.getAdapter(sessionId);
    return { diff: adapter.getDiff(file) };
  }

  public revertFile(sessionId: string | undefined, file: string): { success: boolean; message: string } {
    const adapter = this.getAdapter(sessionId);
    return adapter.revertFile(file);
  }

  public revertForgeChanges(sessionId?: string): { success: boolean; message: string; revertedCount?: number } {
    const adapter = this.getAdapter(sessionId);
    return adapter.revertForgeChanges();
  }

  public destroy(): void {
    this.sessions.clear();
    this.removeAllListeners();
  }
}
