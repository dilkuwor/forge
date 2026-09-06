import {
  AgentStatusResponse,
  SessionDetailResponse,
  SessionMeta,
  ActivityItem,
  FileChangeItem,
  TestSummary,
  ModelsDataResponse,
  ProviderStatus,
  AgentSettings,
  PermissionsPolicyResponse
} from '../types/index.js';

const BASE_URL = '';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, options);
  if (!res.ok) {
    let errMessage = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) errMessage = body.error;
    } catch {
      // ignore
    }
    throw new Error(errMessage);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getStatus: () => fetchJson<AgentStatusResponse>('/api/status'),

  getCurrentSession: () => fetchJson<SessionDetailResponse | { message: string }>('/api/session/current'),

  getSessions: () => fetchJson<SessionMeta[]>('/api/sessions'),

  getSessionDetail: (id: string) => fetchJson<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}`),

  getActivity: () => fetchJson<ActivityItem[]>('/api/activity'),

  getFiles: () => fetchJson<FileChangeItem[]>('/api/files'),

  getDiff: (file?: string) =>
    fetchJson<{ diff: string }>(`/api/diff${file ? `?file=${encodeURIComponent(file)}` : ''}`),

  revertFile: (file: string) =>
    fetchJson<{ success: boolean; message: string }>('/api/files/revert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    }),

  revertForgeChanges: () =>
    fetchJson<{ success: boolean; message: string; revertedCount?: number }>('/api/files/revert-forge', {
      method: 'POST'
    }),

  revertAllFiles: () =>
    fetchJson<{ success: boolean; message: string }>('/api/files/revert-forge', {
      method: 'POST'
    }),

  getTests: () => fetchJson<TestSummary>('/api/tests'),

  runTests: () =>
    fetchJson<TestSummary>('/api/tests/run', {
      method: 'POST'
    }),

  getModels: () => fetchJson<ModelsDataResponse>('/api/models'),

  selectModel: (model: string, provider?: 'openrouter' | 'nvidia') =>
    fetchJson<{ success: boolean }>('/api/models/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, provider })
    }),

  setFallbackModels: (fallbackModels: string[]) =>
    fetchJson<{ success: boolean; fallbackModels: string[] }>('/api/models/fallback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fallbackModels })
    }),

  refreshModels: () =>
    fetchJson<{ success: boolean; openrouterCount: number; nvidiaCount: number }>('/api/models/refresh', {
      method: 'POST'
    }),

  getProviders: () => fetchJson<ProviderStatus[]>('/api/providers'),

  setProviderKey: (provider: 'openrouter' | 'nvidia', apiKey: string) =>
    fetchJson<{ success: boolean; keyMasked: string }>(`/api/providers/${provider}/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    }),

  testProvider: (provider: 'openrouter' | 'nvidia') =>
    fetchJson<{ ok: boolean; message: string }>(`/api/providers/${provider}/test`, {
      method: 'POST'
    }),

  getSettings: () => fetchJson<AgentSettings>('/api/settings'),

  updateSettings: (settings: Partial<AgentSettings>) =>
    fetchJson<{ success: boolean; settings: AgentSettings }>('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    }),

  getPermissions: () => fetchJson<PermissionsPolicyResponse>('/api/permissions'),

  approvePermission: (id: string, mode: 'once' | 'session' = 'once') =>
    fetchJson<{ success: boolean }>('/api/permissions/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, mode })
    }),

  denyPermission: (id: string) =>
    fetchJson<{ success: boolean }>('/api/permissions/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    }),

  revokePermission: (file: string) =>
    fetchJson<{ success: boolean }>('/api/permissions/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    }),

  runTask: (task: string, noConfirm: boolean = false) =>
    fetchJson<{ success: boolean; message: string }>('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, noConfirm })
    }),

  pauseAgent: () => fetchJson<{ success: boolean }>('/api/agent/pause', { method: 'POST' }),

  resumeAgent: () => fetchJson<{ success: boolean }>('/api/agent/resume', { method: 'POST' }),

  stopAgent: () => fetchJson<{ success: boolean }>('/api/agent/stop', { method: 'POST' })
};
