import React, { useState } from 'react';
import { AgentStatusResponse, ActivityItem, TodoItem, PendingPermission } from '../types/index.js';
import { ActivityTimeline } from '../components/ActivityTimeline.js';
import { TerminalOutput } from '../components/TerminalOutput.js';
import { TodoList } from '../components/TodoList.js';
import { PermissionModal } from '../components/PermissionModal.js';
import { api } from '../lib/api.js';

interface DashboardPageProps {
  status: AgentStatusResponse | null;
  activity: ActivityItem[];
  todos: TodoItem[];
  terminalOutput: string;
  pendingPermission: PendingPermission | null;
  onRefresh: () => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  status,
  activity,
  todos,
  terminalOutput,
  pendingPermission,
  onRefresh
}) => {
  const [taskText, setTaskText] = useState('');
  const [noConfirm, setNoConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleRunTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskText.trim()) return;
    setSubmitting(true);
    try {
      await api.runTask(taskText.trim(), noConfirm);
      setTaskText('');
      onRefresh();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setSubmitting(false);
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

  return (
    <>
      <PermissionModal permission={pendingPermission} onResolved={onRefresh} />

      {/* Task input card */}
      <div className="forge-card">
        <form onSubmit={handleRunTask}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              type="text"
              className="form-input"
              placeholder="Enter task (e.g. 'Add OAuth authentication to the API' or 'Inspect repo structure')..."
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              disabled={status?.isRunning}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={status?.isRunning || submitting || !taskText.trim()}
            >
              Run Task
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={noConfirm}
                onChange={(e) => setNoConfirm(e.target.checked)}
                disabled={status?.isRunning}
              />
              <span>Auto-approve tool actions (-y)</span>
            </label>

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
        </form>
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

      {/* Current Task & Operation Banner */}
      {status?.currentTask && (
        <div className="forge-card" style={{ borderLeft: '4px solid var(--cyan)' }}>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600 }}>
            CURRENT TASK
          </div>
          <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', marginTop: '4px' }}>
            {status.currentTask}
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--cyan)', marginTop: '6px', fontFamily: 'var(--font-mono)' }}>
            ▶ {status.currentOperation || 'Idle'}
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
