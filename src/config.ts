import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ForgeConfig {
  defaultProvider: 'openrouter' | 'nvidia';
  defaultModel: string;
  fallbackModels: string[];
  maxSteps: number;
  confirm: {
    edit: boolean;
    bash: boolean;
  };
}

export interface AuthConfig {
  openrouterApiKey?: string;
  nvidiaApiKey?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: 'openrouter' | 'nvidia';
  pricing?: {
    prompt?: number | string;
    completion?: number | string;
  };
  contextLength?: number;
  supportsTools?: boolean;
}

export interface ModelsCache {
  updatedAt: string;
  openrouter: ModelInfo[];
  nvidia: ModelInfo[];
  deadModels: string[];
}

export const DEFAULT_CONFIG: ForgeConfig = {
  defaultProvider: 'openrouter',
  defaultModel: 'openrouter/free',
  fallbackModels: [
    'nvidia/nemotron-3-super-120b-a12b',
    'openai/gpt-oss-120b:free'
  ],
  maxSteps: 30,
  confirm: {
    edit: true,
    bash: true
  }
};

export function getForgeDir(): string {
  const dir = path.join(os.homedir(), '.forge');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getSessionsDir(): string {
  const dir = path.join(getForgeDir(), 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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

export function loadConfig(): ForgeConfig {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        confirm: {
          ...DEFAULT_CONFIG.confirm,
          ...(parsed.confirm || {})
        }
      };
    }
  } catch (err) {
    // fallback to default if malformed
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: Partial<ForgeConfig>): ForgeConfig {
  const existing = loadConfig();
  const updated: ForgeConfig = {
    ...existing,
    ...config,
    confirm: {
      ...existing.confirm,
      ...(config.confirm || {})
    }
  };
  fs.writeFileSync(getConfigPath(), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

export function loadAuth(): AuthConfig {
  const authPath = getAuthPath();
  try {
    if (fs.existsSync(authPath)) {
      const raw = fs.readFileSync(authPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  return {};
}

export function saveAuth(auth: Partial<AuthConfig>): AuthConfig {
  const existing = loadAuth();
  const updated = { ...existing, ...auth };
  fs.writeFileSync(getAuthPath(), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

export function getOpenRouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY || loadAuth().openrouterApiKey;
}

export function getNvidiaKey(): string | undefined {
  return process.env.NVIDIA_API_KEY || loadAuth().nvidiaApiKey;
}

export function loadModelsCache(): ModelsCache {
  const cachePath = getModelsCachePath();
  try {
    if (fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  return {
    updatedAt: new Date(0).toISOString(),
    openrouter: [],
    nvidia: [],
    deadModels: ['deepseek-ai/deepseek-v4-flash']
  };
}

export function saveModelsCache(cache: Partial<ModelsCache>): ModelsCache {
  const existing = loadModelsCache();
  const updated: ModelsCache = {
    ...existing,
    ...cache,
    deadModels: Array.from(new Set([...existing.deadModels, ...(cache.deadModels || [])]))
  };
  fs.writeFileSync(getModelsCachePath(), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

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
