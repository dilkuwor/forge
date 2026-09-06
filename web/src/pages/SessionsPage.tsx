import React, { useState, useEffect } from 'react';
import { SessionMeta, SessionDetailResponse } from '../types/index.js';
import { api } from '../lib/api.js';
import { ActivityTimeline } from '../components/ActivityTimeline.js';
import { TodoList } from '../components/TodoList.js';

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
            {sessions.map((s) => (
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
              </div>
            ))}
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
