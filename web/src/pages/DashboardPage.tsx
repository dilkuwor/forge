import React, { useState } from 'react';
import { AgentStatusResponse, ActivityItem, TodoItem, PendingPermission } from '../types/index.js';
import { ActivityTimeline } from '../components/ActivityTimeline.js';
import { TerminalOutput } from '../components/TerminalOutput.js';
import { TodoList } from '../components/TodoList.js';
import { PermissionModal } from '../components/PermissionModal.js';
import { api } from '../lib/api.js';
import { formatTokens, getContextStatus } from '../lib/tokens.js';

interface DashboardPageProps {
  status: AgentStatusResponse | null;
  activity: ActivityItem[];
  todos: TodoItem[];
  terminalOutput: string;
  pendingPermission: PendingPermission | null;
  onRefresh: () => void;
  onNavigate?: (tab: 'dashboard' | 'sessions' | 'activity' | 'diff' | 'models' | 'providers' | 'settings' | 'permissions') => void;
  selectedSessionId?: string | null;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  status,
  activity,
  todos,
  terminalOutput,
  pendingPermission,
  onRefresh,
  onNavigate
}) => {
  const [quickKey, setQuickKey] = useState('');
  const [quickProvider, setQuickProvider] = useState<'openrouter' | 'nvidia'>('openrouter');
  const [savingKey, setSavingKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  const handleQuickSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickKey.trim()) return;
    setSavingKey(true);
    try {
      await api.setProviderKey(quickProvider, quickKey.trim());
      setKeyMsg(`API key for ${quickProvider} saved successfully!`);
      setQuickKey('');
      onRefresh();
      setTimeout(() => setKeyMsg(null), 4000);
    } catch (err: any) {
      alert(`Failed to save key: ${err.message}`);
    } finally {
      setSavingKey(false);
    }
  };

  const handlePause = async () => {
    await api.pauseAgent();
    onRefresh();
  };

  const handleResume = async () => {
    await api.resumeAgent();
    onRefresh();
  };

  const handleStop = async () => {
    await api.stopAgent();
    onRefresh();
  };

  const seconds = Math.floor((status?.elapsedTimeMs || 0) / 1000);
  const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secs = String(seconds % 60).padStart(2, '0');
  const timeFormatted = `${mins}:${secs}`;

  const tokenUsage = status?.tokenUsage;
  const compactions = status?.compactions;
  const contextStatus = getContextStatus(tokenUsage?.utilizationPercent ?? 0);

  return (
    <>
      <PermissionModal permission={pendingPermission} onResolved={onRefresh} />

      {/* API Key Missing Alert Banner */}
      {status?.currentOperation && (status.currentOperation.includes('API key not found') || status.currentOperation.toLowerCase().includes('openrouter api key')) && (
        <div className="forge-card" style={{ border: '1px solid var(--yellow)', background: 'rgba(210, 153, 34, 0.12)', padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '1.2rem' }}>⚠️</span>
              <h3 style={{ color: 'var(--yellow)', fontSize: '1rem', margin: 0 }}>API Key Required</h3>
            </div>
            {onNavigate && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                onClick={() => onNavigate('providers')}
              >
                Manage Providers →
              </button>
            )}
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '12px' }}>
            {status.currentOperation}
          </p>
          <form onSubmit={handleQuickSaveKey} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="form-input"
              style={{ width: 'auto', padding: '6px 10px', fontSize: '0.85rem' }}
              value={quickProvider}
              onChange={(e) => setQuickProvider(e.target.value as any)}
            >
              <option value="openrouter">OpenRouter API</option>
              <option value="nvidia">NVIDIA NIM API</option>
            </select>
            <input
              type="password"
              className="form-input"
              placeholder={`Paste ${quickProvider === 'openrouter' ? 'sk-or-v1-...' : 'nvapi-...'} key`}
              style={{ flex: 1, minWidth: '240px', padding: '6px 12px', fontSize: '0.85rem' }}
              value={quickKey}
              onChange={(e) => setQuickKey(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              style={{ fontSize: '0.85rem', padding: '6px 14px' }}
              disabled={savingKey || !quickKey.trim()}
            >
              {savingKey ? 'Saving...' : 'Save & Connect'}
            </button>
          </form>
          {keyMsg && (
            <div style={{ marginTop: '8px', fontSize: '0.8rem', color: 'var(--green)' }}>
              {keyMsg}
            </div>
          )}
        </div>
      )}

      {/* Active Terminal Task Monitor Card */}
      <div className="forge-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.85rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600 }}>
              Active Terminal Session
            </span>
            <span
              style={{
                background: 'rgba(88, 166, 255, 0.15)',
                color: 'var(--cyan)',
                border: '1px solid rgba(88, 166, 255, 0.3)',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '0.75rem',
                fontFamily: 'var(--font-mono)'
              }}
            >
              {status?.workspaceName || 'CLI'} {status?.terminalId ? `(${status.terminalId})` : ''}
            </span>
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handlePause}
              disabled={!status?.isRunning || status?.isPaused}
            >
              ⏸ Pause
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleResume}
              disabled={!status?.isRunning || !status?.isPaused}
            >
              ▶ Resume
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={handleStop}
              disabled={!status?.isRunning}
            >
              ⏹ Stop
            </button>
          </div>
        </div>

        <div style={{ padding: '8px 0', fontSize: '1rem', color: status?.currentTask ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          {status?.currentTask ? (
            <div>
              <div style={{ fontWeight: 600 }}>{status.currentTask}</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--cyan)', marginTop: '6px', fontFamily: 'var(--font-mono)' }}>
                ▶ {status.currentOperation || 'Working...'}
              </div>
            </div>
          ) : (
            <em>No active task running. Enter prompts directly in your Forge terminal.</em>
          )}
        </div>
      </div>

      {/* Project & Session Info */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '-8px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
        <div>
          <span>Project: </span>
          <strong style={{ color: 'var(--text-primary)' }}>{status?.projectRoot ? status.projectRoot.split('/').pop() : 'forge'}</strong>
          <span style={{ margin: '0 8px' }}>•</span>
          <span>Directory: </span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{status?.projectRoot || '~/workspace'}</span>
        </div>
        <div>
          <span>Session: </span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--cyan)' }}>{status?.activeSessionId?.slice(0, 8) || 'None'}</span>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-label">Step</div>
          <div className="metric-value">
            {status ? `${status.step} / ${status.maxSteps}` : '0 / 30'}
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-label">Tools Executed</div>
          <div className="metric-value">{status?.toolCount || 0}</div>
        </div>

        <div className="metric-card">
          <div className="metric-label">Elapsed Time</div>
          <div className="metric-value">{timeFormatted}</div>
        </div>

        <div className="metric-card">
          <div className="metric-label">Files Changed</div>
          <div className="metric-value">{status?.filesChangedCount || 0}</div>
        </div>
      </div>

      {/* Context & Token Usage Panel */}
      <div className="forge-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
              Context & Token Usage
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '2px 8px',
                borderRadius: '12px',
                fontSize: '0.72rem',
                fontWeight: 600,
                background: contextStatus.badgeBg,
                color: contextStatus.color,
                border: `1px solid ${contextStatus.color}40`
              }}
            >
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: contextStatus.color }} />
              {contextStatus.label} ({tokenUsage?.utilizationPercent ?? 0}%)
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {tokenUsage?.isActual ? (
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: '12px',
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  background: 'rgba(63, 185, 80, 0.15)',
                  color: 'var(--green)',
                  border: '1px solid rgba(63, 185, 80, 0.4)'
                }}
                title="Exact token counts reported by provider API"
              >
                ✓ ACTUAL TOKENS
              </span>
            ) : (
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: '12px',
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  background: 'rgba(188, 140, 255, 0.15)',
                  color: 'var(--magenta)',
                  border: '1px solid rgba(188, 140, 255, 0.4)'
                }}
                title="Token counts calculated via character heuristics"
              >
                ~ ESTIMATED TOKENS
              </span>
            )}
          </div>
        </div>

        {/* Progress Bar & Context Utilization */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px', fontSize: '0.85rem' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              Context {tokenUsage?.utilizationPercent ?? 0}% — {formatTokens(tokenUsage?.currentContextTokens ?? 0)} / {formatTokens(tokenUsage?.modelContextLimit ?? 32768)}
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Estimated Remaining: <strong style={{ color: 'var(--text-secondary)' }}>{formatTokens(tokenUsage?.estimatedRemainingTokens ?? 0)}</strong> tokens
            </span>
          </div>

          {/* Progress Bar Track */}
          <div
            style={{
              width: '100%',
              height: '10px',
              borderRadius: '5px',
              background: 'rgba(255, 255, 255, 0.08)',
              overflow: 'hidden',
              position: 'relative'
            }}
          >
            <div
              style={{
                width: `${Math.min(100, Math.max(0, tokenUsage?.utilizationPercent ?? 0))}%`,
                height: '100%',
                borderRadius: '5px',
                background: contextStatus.color,
                transition: 'width 0.3s ease, background 0.3s ease'
              }}
            />
          </div>
        </div>

        {/* 4 Token Metric Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
          <div className="metric-card" style={{ padding: '12px' }}>
            <div className="metric-label" style={{ fontSize: '0.7rem' }}>Input Tokens</div>
            <div className="metric-value" style={{ fontSize: '1.2rem', marginTop: '4px' }}>
              {formatTokens(tokenUsage?.inputTokens ?? 0)}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              {(tokenUsage?.inputTokens ?? 0).toLocaleString()} raw
            </div>
          </div>

          <div className="metric-card" style={{ padding: '12px' }}>
            <div className="metric-label" style={{ fontSize: '0.7rem' }}>Output Tokens</div>
            <div className="metric-value" style={{ fontSize: '1.2rem', marginTop: '4px' }}>
              {formatTokens(tokenUsage?.outputTokens ?? 0)}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              {(tokenUsage?.outputTokens ?? 0).toLocaleString()} raw
            </div>
          </div>

          <div className="metric-card" style={{ padding: '12px' }}>
            <div className="metric-label" style={{ fontSize: '0.7rem' }}>Total Tokens</div>
            <div className="metric-value" style={{ fontSize: '1.2rem', marginTop: '4px' }}>
              {formatTokens(tokenUsage?.totalTokens ?? 0)}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              {(tokenUsage?.totalTokens ?? 0).toLocaleString()} raw
            </div>
          </div>

          <div className="metric-card" style={{ padding: '12px' }}>
            <div className="metric-label" style={{ fontSize: '0.7rem' }}>Model Limit</div>
            <div className="metric-value" style={{ fontSize: '1.2rem', marginTop: '4px' }}>
              {formatTokens(tokenUsage?.modelContextLimit ?? 32768)}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              {(tokenUsage?.modelContextLimit ?? 32768).toLocaleString()} max
            </div>
          </div>
        </div>

        {/* Compaction Events Banner if any occurred */}
        {compactions && compactions.count > 0 && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: '6px',
              background: 'rgba(210, 153, 34, 0.1)',
              border: '1px solid rgba(210, 153, 34, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '0.8rem',
              flexWrap: 'wrap',
              gap: '8px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>⚡ Compactions:</span>
              <span style={{ color: 'var(--text-primary)' }}>
                {compactions.count} {compactions.count === 1 ? 'time' : 'times'} executed ({formatTokens(compactions.totalTokensFreed)} freed total)
              </span>
            </div>
            {compactions.lastTokensBefore != null && compactions.lastTokensAfter != null && (
              <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
                Context compacted: {formatTokens(compactions.lastTokensBefore)} → {formatTokens(compactions.lastTokensAfter)} tokens ({formatTokens(compactions.lastTokensFreed ?? 0)} freed)
              </div>
            )}
          </div>
        )}
      </div>

      {/* Compact Verification Section */}
      {status?.testStatus && (
        <div className="forge-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: status.testStatus.failed > 0 ? '4px solid var(--red)' : '4px solid var(--green)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Verification</span>
            <span style={{ fontSize: '0.9rem', color: status.testStatus.failed > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
              {status.testStatus.failed > 0 ? `✗ Tests: ${status.testStatus.passed} passed, ${status.testStatus.failed} failed` : `✓ Tests: ${status.testStatus.passed}/${status.testStatus.passed}`}
            </span>
          </div>
        </div>
      )}


      {/* 2-Column Dashboard Layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <ActivityTimeline activity={activity} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <TodoList todos={todos} />
          <TerminalOutput output={terminalOutput} />
        </div>
      </div>
    </>
  );
};
