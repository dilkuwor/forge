import React, { useState, useEffect } from 'react';
import { SessionMeta, SessionDetailResponse } from '../types/index.js';
import { api } from '../lib/api.js';
import { ActivityTimeline } from '../components/ActivityTimeline.js';
import { TodoList } from '../components/TodoList.js';
import { formatTokens, getContextStatus } from '../lib/tokens.js';

export const SessionsPage: React.FC = () => {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    try {
      const list = await api.getSessions();
      setSessions(list);
      if (list.length > 0 && !selectedSessionId) {
        loadDetail(list[0].id);
      }
    } catch {
      // ignore
    }
  };

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
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '20px', height: '100%' }}>
      {/* Session list */}
      <div className="forge-card" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="card-title">
          <span>Sessions History</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{sessions.length}</span>
        </div>

        {sessions.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', padding: '16px 0', fontSize: '0.85rem' }}>
            No saved sessions found in ~/.forge/sessions/
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto' }}>
            {sessions.map((s) => {
              const util = s.tokenUsage?.utilizationPercent ?? 0;
              const statusInfo = getContextStatus(util);
              return (
                <div
                  key={s.id}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-subtle)',
                    background: selectedSessionId === s.id ? '#21262d' : 'var(--bg-input)',
                    cursor: 'pointer'
                  }}
                  onClick={() => loadDetail(s.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--cyan)', fontSize: '0.85rem' }}>
                      {s.id.slice(0, 12)}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--green)' }}>● Completed</span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {s.createdAt ? new Date(s.createdAt).toLocaleString() : s.id}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    {s.model}
                  </div>
                  {s.tokenUsage && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      <span>Tokens: <strong style={{ color: 'var(--text-secondary)' }}>{formatTokens(s.tokenUsage.totalTokens)}</strong></span>
                      <span>Peak: <strong style={{ color: statusInfo.color }}>{formatTokens(s.tokenUsage.currentContextTokens)} ({util}%)</strong></span>
                    </div>
                  )}
                  {s.compactionsCount != null && s.compactionsCount > 0 && (
                    <div style={{ fontSize: '0.68rem', color: 'var(--yellow)', marginTop: '2px' }}>
                      ⚡ {s.compactionsCount} {s.compactionsCount === 1 ? 'compaction' : 'compactions'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
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
