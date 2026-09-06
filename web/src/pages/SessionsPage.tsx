import React, { useState, useEffect } from 'react';
import { SessionMeta, SessionDetailResponse, ActiveSessionInfo } from '../types/index.js';
import { api } from '../lib/api.js';
import { ActivityTimeline } from '../components/ActivityTimeline.js';
import { TodoList } from '../components/TodoList.js';
import { formatTokens, getContextStatus } from '../lib/tokens.js';

interface SessionsPageProps {
  activeSessions?: ActiveSessionInfo[];
  selectedSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
}

export const SessionsPage: React.FC<SessionsPageProps> = ({
  activeSessions: initialActiveSessions,
  selectedSessionId: currentActiveSessionId,
  onSelectSession
}) => {
  const [activeSessions, setActiveSessions] = useState<ActiveSessionInfo[]>(initialActiveSessions || []);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(currentActiveSessionId || null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const loadActive = async () => {
    try {
      const list = await api.getActiveSessions();
      setActiveSessions(list);
    } catch {
      // ignore
    }
  };

  const loadSessions = async () => {
    try {
      const list = await api.getSessions();
      setSessions(list);
      if (list.length > 0 && !selectedSessionId && activeSessions.length === 0) {
        loadDetail(list[0].id);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadActive();
    loadSessions();
  }, []);

  useEffect(() => {
    if (initialActiveSessions) {
      setActiveSessions(initialActiveSessions);
    }
  }, [initialActiveSessions]);

  useEffect(() => {
    if (currentActiveSessionId && !selectedSessionId) {
      loadDetail(currentActiveSessionId);
    }
  }, [currentActiveSessionId]);

  const loadDetail = async (id: string) => {
    setSelectedSessionId(id);
    setLoading(true);
    try {
      const detail = await api.getSessionDetail(id);
      setSessionDetail(detail);
    } catch {
      setSessionDetail(null);
    } finally {
      setLoading(false);
    }
  };

  const detailTokenUsage = sessionDetail?.tokenUsage;
  const detailCompactions = sessionDetail?.compactions;
  const detailContextStatus = getContextStatus(detailTokenUsage?.utilizationPercent ?? 0);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '20px', height: '100%' }}>
      {/* Session list: Active and Historical */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' }}>
        {/* 1. Active Terminal Sessions */}
        <div className="forge-card" style={{ padding: '14px' }}>
          <div className="card-title" style={{ marginBottom: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Active Terminals ({activeSessions.length} live)</span>
            <button
              className="btn btn-sm"
              style={{ fontSize: '0.75rem', padding: '2px 8px' }}
              onClick={() => {
                loadActive();
                loadSessions();
              }}
            >
              🔄 Refresh
            </button>
          </div>

          {activeSessions.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}>
              No terminal sessions currently connected.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {activeSessions.map((as) => {
                const isSelected = selectedSessionId === as.sessionId || as.isSelected;
                const statusClass =
                  as.status === 'WORKING' ? 'var(--cyan)' : as.status === 'ERROR' ? 'var(--red)' : 'var(--green)';
                return (
                  <div
                    key={as.sessionId}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '6px',
                      border: isSelected ? '1px solid var(--cyan)' : '1px solid var(--border-subtle)',
                      background: isSelected ? 'rgba(88, 166, 255, 0.08)' : 'var(--bg-input)',
                      cursor: 'pointer'
                    }}
                    onClick={() => loadDetail(as.sessionId)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.85rem' }}>
                        {as.workspaceName}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: statusClass, fontWeight: 600 }}>
                        ● {as.status}
                      </span>
                    </div>

                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
                      {as.terminalId} {as.pid ? `(PID ${as.pid})` : ''}
                    </div>

                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                      Model: <strong>{as.model}</strong>
                    </div>

                    {as.currentTask && (
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-primary)',
                          marginTop: '4px',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}
                      >
                        {as.currentTask}
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        Tokens: {formatTokens(as.tokenUsage?.totalTokens || 0)}
                      </span>
                      {onSelectSession && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{
                            fontSize: '0.68rem',
                            padding: '2px 8px',
                            background: as.isSelected ? 'var(--green)' : undefined
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectSession(as.sessionId);
                          }}
                        >
                          {as.isSelected ? '✓ Active' : 'Switch'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 2. Historical Sessions */}
        <div className="forge-card" style={{ padding: '14px', flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="card-title" style={{ marginBottom: '10px' }}>
            <span>Historical Sessions</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{sessions.length}</span>
          </div>

          {sessions.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}>
              No historical sessions found.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto' }}>
              {sessions.map((s) => {
                const util = s.tokenUsage?.utilizationPercent ?? 0;
                const statusInfo = getContextStatus(util);
                const isSelected = selectedSessionId === s.id;
                return (
                  <div
                    key={s.id}
                    style={{
                      padding: '8px 10px',
                      borderRadius: '6px',
                      border: isSelected ? '1px solid var(--cyan)' : '1px solid var(--border-subtle)',
                      background: isSelected ? '#21262d' : 'var(--bg-input)',
                      cursor: 'pointer'
                    }}
                    onClick={() => loadDetail(s.id)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--cyan)', fontSize: '0.8rem' }}>
                        {s.id.slice(0, 10)}
                      </span>
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        {s.status || 'Saved'}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      {s.createdAt ? new Date(s.createdAt).toLocaleDateString() : ''}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {s.model}
                    </div>
                    {s.tokenUsage && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                        <span>Tokens: {formatTokens(s.tokenUsage.totalTokens)}</span>
                        <span>Peak: <strong style={{ color: statusInfo.color }}>{util}%</strong></span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Session Detail */}
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {loading ? (
          <div className="forge-card" style={{ color: 'var(--text-muted)' }}>
            Loading session details...
          </div>
        ) : !sessionDetail ? (
          <div className="forge-card" style={{ color: 'var(--text-muted)' }}>
            Select a session on the left to view details.
          </div>
        ) : (
          <>
            <div className="forge-card">
              <div className="card-title">
                <span>Session: {sessionDetail.id}</span>
                <span style={{ fontSize: '0.8rem', color: 'var(--green)' }}>● {sessionDetail.status}</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
                <div className="metric-card">
                  <div className="metric-label">Model</div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginTop: '4px' }}>
                    {sessionDetail.model}
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Provider</div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginTop: '4px' }}>
                    {sessionDetail.provider}
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Steps Executed</div>
                  <div className="metric-value">{sessionDetail.step}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Files Touched</div>
                  <div className="metric-value">{sessionDetail.touchedFiles.length}</div>
                </div>
              </div>

              {/* Session Token & Context Monitoring Section */}
              {detailTokenUsage && (
                <div style={{ padding: '14px', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                        Context & Token Usage
                      </span>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '2px 8px',
                          borderRadius: '12px',
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          background: detailContextStatus.badgeBg,
                          color: detailContextStatus.color,
                          border: `1px solid ${detailContextStatus.color}40`
                        }}
                      >
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: detailContextStatus.color }} />
                        {detailContextStatus.label} ({detailTokenUsage.utilizationPercent}%)
                      </span>
                    </div>

                    <div>
                      {detailTokenUsage.isActual ? (
                        <span style={{ padding: '2px 8px', borderRadius: '12px', fontSize: '0.7rem', fontWeight: 600, background: 'rgba(63, 185, 80, 0.15)', color: 'var(--green)', border: '1px solid rgba(63, 185, 80, 0.4)' }}>
                          ✓ ACTUAL TOKENS
                        </span>
                      ) : (
                        <span style={{ padding: '2px 8px', borderRadius: '12px', fontSize: '0.7rem', fontWeight: 600, background: 'rgba(188, 140, 255, 0.15)', color: 'var(--magenta)', border: '1px solid rgba(188, 140, 255, 0.4)' }}>
                          ~ ESTIMATED TOKENS
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', marginBottom: '6px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        Peak Context {detailTokenUsage.utilizationPercent}% — {formatTokens(detailTokenUsage.currentContextTokens)} / {formatTokens(detailTokenUsage.modelContextLimit)}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        Remaining Limit: {formatTokens(detailTokenUsage.estimatedRemainingTokens)}
                      </span>
                    </div>
                    <div style={{ width: '100%', height: '8px', borderRadius: '4px', background: 'rgba(255, 255, 255, 0.08)', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${Math.min(100, Math.max(0, detailTokenUsage.utilizationPercent))}%`,
                          height: '100%',
                          borderRadius: '4px',
                          background: detailContextStatus.color
                        }}
                      />
                    </div>
                  </div>

                  {/* 4 Token Metric Cards */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
                    <div className="metric-card" style={{ padding: '10px' }}>
                      <div className="metric-label" style={{ fontSize: '0.7rem' }}>Input Tokens</div>
                      <div className="metric-value" style={{ fontSize: '1.1rem', marginTop: '2px' }}>
                        {formatTokens(detailTokenUsage.inputTokens)}
                      </div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        {detailTokenUsage.inputTokens.toLocaleString()} raw
                      </div>
                    </div>
                    <div className="metric-card" style={{ padding: '10px' }}>
                      <div className="metric-label" style={{ fontSize: '0.7rem' }}>Output Tokens</div>
                      <div className="metric-value" style={{ fontSize: '1.1rem', marginTop: '2px' }}>
                        {formatTokens(detailTokenUsage.outputTokens)}
                      </div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        {detailTokenUsage.outputTokens.toLocaleString()} raw
                      </div>
                    </div>
                    <div className="metric-card" style={{ padding: '10px' }}>
                      <div className="metric-label" style={{ fontSize: '0.7rem' }}>Total Tokens</div>
                      <div className="metric-value" style={{ fontSize: '1.1rem', marginTop: '2px' }}>
                        {formatTokens(detailTokenUsage.totalTokens)}
                      </div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        {detailTokenUsage.totalTokens.toLocaleString()} raw
                      </div>
                    </div>
                    <div className="metric-card" style={{ padding: '10px' }}>
                      <div className="metric-label" style={{ fontSize: '0.7rem' }}>Peak Context / Limit</div>
                      <div className="metric-value" style={{ fontSize: '1.1rem', marginTop: '2px' }}>
                        {formatTokens(detailTokenUsage.currentContextTokens)} / {formatTokens(detailTokenUsage.modelContextLimit)}
                      </div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        {detailTokenUsage.utilizationPercent}% utilization
                      </div>
                    </div>
                  </div>

                  {/* Compactions */}
                  {detailCompactions && detailCompactions.count > 0 && (
                    <div style={{ marginTop: '10px', padding: '8px 12px', borderRadius: '4px', background: 'rgba(210, 153, 34, 0.1)', border: '1px solid rgba(210, 153, 34, 0.3)', fontSize: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                      <div>
                        <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>⚡ Compactions: </span>
                        <span style={{ color: 'var(--text-primary)' }}>{detailCompactions.count} executed ({formatTokens(detailCompactions.totalTokensFreed)} freed)</span>
                      </div>
                      {detailCompactions.lastTokensBefore != null && detailCompactions.lastTokensAfter != null && (
                        <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                          Last: {formatTokens(detailCompactions.lastTokensBefore)} → {formatTokens(detailCompactions.lastTokensAfter)} ({formatTokens(detailCompactions.lastTokensFreed ?? 0)} freed)
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {sessionDetail.task && (
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600 }}>
                    TASK OBJECTIVE
                  </div>
                  <div style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginTop: '4px' }}>
                    {sessionDetail.task}
                  </div>
                </div>
              )}

              {sessionDetail.touchedFiles.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px' }}>
                    FILES TOUCHED IN THIS SESSION
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {sessionDetail.touchedFiles.map((f) => (
                      <span
                        key={f}
                        style={{
                          background: '#090d13',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: '4px',
                          padding: '2px 8px',
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--cyan)'
                        }}
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {sessionDetail.todos.length > 0 && <TodoList todos={sessionDetail.todos} />}

            <ActivityTimeline activity={sessionDetail.activity} />
          </>
        )}
      </div>
    </div>
  );
};
