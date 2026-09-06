import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type ProviderName = 'openrouter' | 'nvidia';

export interface ForgeConfig {
  defaultProvider: ProviderName;
  defaultModel: string;
  fallbackModels: string[];
  maxSteps: number;
  confirm: {
    edit: boolean;
    bash: boolean;
  };
  /** Optional override of the context window (tokens) used for compaction decisions. */
  contextWindow?: number;
  /** Per-command timeout for the bash tool, in milliseconds. */
  bashTimeoutMs?: number;
}

export interface AuthConfig {
  openrouterApiKey?: string;
  nvidiaApiKey?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: ProviderName;
  pricing?: {
    prompt?: number | string;
    completion?: number | string;
  };
  contextLength?: number;
  supportsTools?: boolean;
}

export interface DeadModelEntry {
  /** ISO timestamp after which the model may be retried. */
  until: string;
  reason?: string;
}

export interface ModelsCache {
  updatedAt: string;
  openrouter: ModelInfo[];
  nvidia: ModelInfo[];
  /** Permanently retired models (never retried). */
  deadModels: string[];
  /** Temporarily unavailable models with an expiry (cooldown). */
  cooldowns?: Record<string, DeadModelEntry>;
}

export const DEFAULT_CONTEXT_WINDOW = 32768;
export const DEFAULT_BASH_TIMEOUT_MS = 60_000;

export const DEFAULT_CONFIG: ForgeConfig = {
  defaultProvider: 'openrouter',
  defaultModel: 'openrouter/free',
  fallbackModels: ['nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-120b:free'],
  maxSteps: 30,
  confirm: {
    edit: true,
    bash: true
  }
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getForgeDir(): string {
  const dir = process.env.FORGE_HOME || process.env.FORGE_DIR || path.join(os.homedir(), '.forge');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getSessionsDir(): string {
  const dir = path.join(getForgeDir(), 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getConfigPath(): string {
  return path.join(getForgeDir(), 'config.json');
}

export function getAuthPath(): string {
  return path.join(getForgeDir(), 'auth.json');
}

export function getModelsCachePath(): string {
  return path.join(getForgeDir(), 'models-cache.json');
}

// ---------------------------------------------------------------------------
// Low-level JSON I/O with a small, path-keyed in-memory cache.
//
// Config/auth/cache reads sit on hot paths (every agent step, every provider
// resolution). Reading and JSON-parsing from disk each time is wasteful, so we
// cache by absolute path and invalidate on write. The cache also checks mtime
// so external edits (e.g. the user editing config.json) are picked up.
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number;
  value: unknown;
}

const jsonCache = new Map<string, CacheEntry>();

export function clearConfigCache(): void {
  jsonCache.clear();
}

function readJsonCached<T>(filePath: string): T | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    jsonCache.delete(filePath);
    return undefined;
  }

  const cached = jsonCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.value as T;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const value = JSON.parse(raw) as T;
    jsonCache.set(filePath, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch {
    jsonCache.delete(filePath);
    return undefined;
  }
}

/**
 * Atomically write JSON: write to a temp file in the same directory then rename.
 * A crash mid-write can therefore never leave a truncated/corrupt file behind.
 */
export function writeJsonAtomic(filePath: string, value: unknown, mode: number = 0o644): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(value, null, 2);
  fs.writeFileSync(tmp, data, { encoding: 'utf8', mode });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
  // rename preserves the temp file's mode, but if the target pre-existed with
  // looser permissions on some platforms, enforce explicitly.
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
  jsonCache.delete(filePath);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function isProviderName(v: unknown): v is ProviderName {
  return v === 'openrouter' || v === 'nvidia';
}

function toPositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return fallback;
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

/**
 * Coerce an arbitrary parsed object into a valid ForgeConfig. Unknown or
 * malformed fields fall back to defaults rather than poisoning runtime state
 * (e.g. `maxSteps: "abc"` previously produced NaN and a loop that never ran).
 */
export function normalizeConfig(parsed: unknown): ForgeConfig {
  const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const confirm = (p.confirm && typeof p.confirm === 'object' ? p.confirm : {}) as Record<
    string,
    unknown
  >;

  const fallbackModels = Array.isArray(p.fallbackModels)
    ? p.fallbackModels.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    : DEFAULT_CONFIG.fallbackModels;

  const cfg: ForgeConfig = {
    defaultProvider: isProviderName(p.defaultProvider)
      ? p.defaultProvider
      : DEFAULT_CONFIG.defaultProvider,
    defaultModel:
      typeof p.defaultModel === 'string' ? p.defaultModel.trim() : DEFAULT_CONFIG.defaultModel,
    fallbackModels,
    maxSteps: toPositiveInt(p.maxSteps, DEFAULT_CONFIG.maxSteps),
    confirm: {
      edit: toBool(confirm.edit, DEFAULT_CONFIG.confirm.edit),
      bash: toBool(confirm.bash, DEFAULT_CONFIG.confirm.bash)
    }
  };

  if (p.contextWindow !== undefined) {
    const cw = toPositiveInt(p.contextWindow, 0);
    if (cw >= 1024) cfg.contextWindow = cw;
  }
  if (p.bashTimeoutMs !== undefined) {
    const t = toPositiveInt(p.bashTimeoutMs, 0);
    if (t >= 1000) cfg.bashTimeoutMs = t;
  }

  return cfg;
}

export function loadConfig(): ForgeConfig {
  const parsed = readJsonCached<unknown>(getConfigPath());
  if (parsed === undefined) {
    return normalizeConfig({});
  }
  return normalizeConfig(parsed);
}

export function saveConfig(config: Partial<ForgeConfig>): ForgeConfig {
  const existing = loadConfig();
  const updated = normalizeConfig({
    ...existing,
    ...config,
    confirm: {
      ...existing.confirm,
      ...(config.confirm || {})
    }
  });
  writeJsonAtomic(getConfigPath(), updated, 0o644);
  return updated;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function loadAuth(): AuthConfig {
  const parsed = readJsonCached<unknown>(getAuthPath());
  if (!parsed || typeof parsed !== 'object') return {};
  const p = parsed as Record<string, unknown>;
  const auth: AuthConfig = {};
  if (typeof p.openrouterApiKey === 'string' && p.openrouterApiKey.trim()) {
    auth.openrouterApiKey = p.openrouterApiKey.trim();
  }
  if (typeof p.nvidiaApiKey === 'string' && p.nvidiaApiKey.trim()) {
    auth.nvidiaApiKey = p.nvidiaApiKey.trim();
  }
  return auth;
}

export function saveAuth(auth: Partial<AuthConfig>): AuthConfig {
  const existing = loadAuth();
  const updated: AuthConfig = { ...existing, ...auth };
  // Credentials: owner read/write only.
  writeJsonAtomic(getAuthPath(), updated, 0o600);
  return updated;
}

export function getOpenRouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || loadAuth().openrouterApiKey;
}

export function getNvidiaKey(): string | undefined {
  return process.env.NVIDIA_API_KEY?.trim() || loadAuth().nvidiaApiKey;
}

export function getApiKey(provider: ProviderName): string | undefined {
  return provider === 'openrouter' ? getOpenRouterKey() : getNvidiaKey();
}

// ---------------------------------------------------------------------------
// Models cache
// ---------------------------------------------------------------------------

const PERMANENTLY_RETIRED = ['deepseek-ai/deepseek-v4-flash'];

function emptyModelsCache(): ModelsCache {
  return {
    updatedAt: new Date(0).toISOString(),
    openrouter: [],
    nvidia: [],
    deadModels: [...PERMANENTLY_RETIRED],
    cooldowns: {}
  };
}

export function loadModelsCache(): ModelsCache {
  const parsed = readJsonCached<Partial<ModelsCache>>(getModelsCachePath());
  const base = emptyModelsCache();
  if (!parsed || typeof parsed !== 'object') return base;
  return {
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : base.updatedAt,
    openrouter: Array.isArray(parsed.openrouter) ? parsed.openrouter : [],
    nvidia: Array.isArray(parsed.nvidia) ? parsed.nvidia : [],
    deadModels: Array.isArray(parsed.deadModels)
      ? Array.from(new Set([...PERMANENTLY_RETIRED, ...parsed.deadModels.filter((m) => typeof m === 'string')]))
      : base.deadModels,
    cooldowns:
      parsed.cooldowns && typeof parsed.cooldowns === 'object' ? parsed.cooldowns : {}
  };
}

export function saveModelsCache(cache: Partial<ModelsCache>): ModelsCache {
  const existing = loadModelsCache();
  const updated: ModelsCache = {
    ...existing,
    ...cache,
    deadModels:
      cache.deadModels !== undefined
        ? Array.from(new Set([...PERMANENTLY_RETIRED, ...cache.deadModels]))
        : existing.deadModels,
    cooldowns: cache.cooldowns !== undefined ? cache.cooldowns : existing.cooldowns
  };
  writeJsonAtomic(getModelsCachePath(), updated, 0o644);
  return updated;
}

/**
 * Best-effort lookup of a model's context window from the models cache,
 * falling back to a config override or the global default.
 */
export function getModelContextWindow(model: string): number {
  const cfg = loadConfig();
  if (cfg.contextWindow) return cfg.contextWindow;
  const cache = loadModelsCache();
  const info =
    cache.openrouter.find((m) => m.id === model) || cache.nvidia.find((m) => m.id === model);
  if (info?.contextLength && info.contextLength >= 1024) {
    return info.contextLength;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// ---------------------------------------------------------------------------
// Project instructions
// ---------------------------------------------------------------------------

export function getProjectMd(cwd: string = process.cwd()): string | null {
  const projPath = path.join(cwd, '.forge', 'project.md');
  if (fs.existsSync(projPath)) {
    try {
      return fs.readFileSync(projPath, 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}
