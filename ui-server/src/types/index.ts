export interface PendingPermission {
  id: string;
  type: 'file' | 'bash';
  target: string;
  timestamp: number;
}

export type AgentStatusType =
  | 'IDLE'
  | 'WORKING'
  | 'PAUSED'
  | 'AWAITING_APPROVAL'
  | 'ERROR'
  | 'COMPLETED';

export interface ActivityItem {
  id: string;
  timestamp: string;
  type: 'info' | 'read' | 'edit' | 'shell' | 'error' | 'compact' | 'done';
  status: 'done' | 'running' | 'failed' | 'pending';
  title: string;
  detail?: string;
  durationMs?: number;
  toolName?: string;
  toolArgs?: any;
  toolResult?: string;
  diff?: string;
}

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

export interface FileChangeItem {
  path: string;
  status: 'M' | 'A' | 'D' | '??';
  additions?: number;
  deletions?: number;
}

export interface TestCaseResult {
  name: string;
  suite: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs?: number;
  error?: string;
}

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs?: number;
  timestamp: string;
  tests: TestCaseResult[];
  rawOutput?: string;
}

export interface TokenUsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  currentContextTokens: number;
  modelContextLimit: number;
  utilizationPercent: number;
  estimatedRemainingTokens: number;
  isActual: boolean;
}

export interface CompactionStats {
  count: number;
  lastTokensBefore?: number;
  lastTokensAfter?: number;
  lastTokensFreed?: number;
  totalTokensFreed: number;
}

export interface ActiveSessionInfo {
  sessionId: string;
  terminalId: string;
  pid: number;
  workspace: string;
  workspaceName: string;
  status: AgentStatusType;
  currentTask?: string;
  currentOperation?: string;
  model: string;
  provider: 'openrouter' | 'nvidia';
  step: number;
  maxSteps: number;
  toolCount: number;
  filesChangedCount: number;
  elapsedTimeMs: number;
  tokenUsage: TokenUsageStats;
  compactions: CompactionStats;
  registeredAt: number;
  lastHeartbeat: number;
  isHost?: boolean;
}

export interface RegisterSessionRequest {
  sessionId: string;
  terminalId?: string;
  pid?: number;
  workspace?: string;
  workspaceName?: string;
  model?: string;
  provider?: 'openrouter' | 'nvidia';
  status?: AgentStatusType;
}

export interface SessionUpdateRequest {
  status?: AgentStatusType;
  currentTask?: string;
  currentOperation?: string;
  model?: string;
  provider?: 'openrouter' | 'nvidia';
  step?: number;
  maxSteps?: number;
  toolCount?: number;
  elapsedTimeMs?: number;
  filesChangedCount?: number;
  tokenUsage?: Partial<TokenUsageStats>;
  compactions?: Partial<CompactionStats>;
  activityItem?: ActivityItem;
  todoItems?: TodoItem[];
  terminalChunk?: string;
  touchedFile?: string;
  pendingPermission?: PendingPermission | null;
}

export interface AgentStatusResponse {
  isRunning: boolean;
  isPaused: boolean;
  status: AgentStatusType;
  projectRoot: string;
  currentTask: string;
  currentModel: string;
  currentProvider: string;
  currentOperation: string;
  step: number;
  maxSteps: number;
  toolCount: number;
  elapsedTimeMs: number;
  filesChangedCount: number;
  tokenUsage: TokenUsageStats;
  compactions: CompactionStats;
  testStatus: { passed: number; failed: number; skipped: number } | null;
  pendingPermission: PendingPermission | null;
  activeSessionId: string | null;
  terminalId?: string;
  pid?: number;
  workspace?: string;
  workspaceName?: string;
  activeSessions?: ActiveSessionInfo[];
  selectedSessionId?: string;
}

export interface ProviderStatus {
  provider: 'openrouter' | 'nvidia';
  configured: boolean;
  keyMasked: string | null;
}

export interface AgentSettings {
  maxSteps: number;
  confirm: {
    edit: boolean;
    bash: boolean;
  };
  projectRoot: string;
  historyCompactionThreshold: number;
  bashTimeout: number;
  security: {
    projectRootGuard: boolean;
    blockEnv: boolean;
    blockSsh: boolean;
    blockDangerousCommands: boolean;
  };
}

export interface PermissionsPolicyResponse {
  fileEditing: {
    status: 'confirm_required' | 'auto_approved';
    rule: string;
  };
  bashExecution: {
    status: 'confirm_required' | 'auto_approved';
    rule: string;
    allowlist: string[];
  };
  protectedAssets: Array<{
    target: string;
    description: string;
    locked: boolean;
  }>;
  sessionApprovedFiles: string[];
  pendingPermission: PendingPermission | null;
}

export interface SessionListItem {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  provider: string;
  task?: string;
  status?: string;
  tokenUsage?: TokenUsageStats;
  compactionsCount?: number;
}

export interface SessionDetailResponse {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  provider: string;
  task: string;
  status: string;
  step: number;
  maxSteps: number;
  activity: ActivityItem[];
  todos: TodoItem[];
  touchedFiles: string[];
  terminalOutput: string;
  testSummary: TestSummary | null;
  tokenUsage: TokenUsageStats;
  compactions: CompactionStats;
}
