import React, { useState, useEffect } from 'react';
import { AgentSettings } from '../types/index.js';
import { api } from '../lib/api.js';

export const SettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const loadSettings = async () => {
    try {
      const res = await api.getSettings();
      setSettings(res);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handleToggleAutoApproveEdit = async () => {
    if (!settings) return;
    const nextVal = !settings.confirm.edit;
    try {
      await api.updateSettings({
        confirm: { ...settings.confirm, edit: nextVal }
      });
      setSettings({
        ...settings,
        confirm: { ...settings.confirm, edit: nextVal }
      });
      setMessage(`File edit confirmation ${nextVal ? 'enabled' : 'disabled'}.`);
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleToggleAutoApproveBash = async () => {
    if (!settings) return;
    const nextVal = !settings.confirm.bash;
    try {
      await api.updateSettings({
        confirm: { ...settings.confirm, bash: nextVal }
      });
      setSettings({
        ...settings,
        confirm: { ...settings.confirm, bash: nextVal }
      });
      setMessage(`Bash command confirmation ${nextVal ? 'enabled' : 'disabled'}.`);
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleMaxStepsChange = async (val: number) => {
    if (!settings || val < 1 || val > 100) return;
    try {
      await api.updateSettings({ maxSteps: val });
      setSettings({ ...settings, maxSteps: val });
      setMessage(`Max steps updated to ${val}`);
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  if (loading || !settings) {
    return <div className="forge-card" style={{ color: 'var(--text-muted)' }}>Loading settings...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="forge-card">
        <h2 style={{ fontSize: '1.2rem', color: 'var(--text-primary)', marginBottom: '4px' }}>
          Agent Configuration & Controls
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Configure loop limits, permission prompts, and guardrails stored in ~/.forge/config.json.
        </p>
      </div>

      {message && (
        <div style={{ padding: '8px 14px', background: 'rgba(63, 185, 80, 0.15)', color: 'var(--green)', borderRadius: '6px', fontSize: '0.85rem' }}>
          {message}
        </div>
      )}

      {/* Execution Limits */}
      <div className="forge-card">
        <h3 className="card-title">Loop Execution Controls</h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
              MAXIMUM STEPS PER TASK
            </label>
            <input
              type="number"
              className="form-input"
              value={settings.maxSteps}
              min={1}
              max={100}
              onChange={(e) => handleMaxStepsChange(parseInt(e.target.value, 10) || 30)}
              style={{ maxWidth: '160px' }}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
              Loop automatically halts after this many ReAct steps.
            </span>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
              HISTORY COMPACTION THRESHOLD
            </label>
            <input
              type="text"
              className="form-input"
              value="70% of context window"
              disabled
              style={{ maxWidth: '200px' }}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
              Older turns are automatically summarized when history reaches 70%.
            </span>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
              BASH TIMEOUT
            </label>
            <input
              type="text"
              className="form-input"
              value="60 seconds"
              disabled
              style={{ maxWidth: '160px' }}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
              Shell processes are terminated if they exceed 60s.
            </span>
          </div>
        </div>
      </div>

      {/* Permission Prompts */}
      <div className="forge-card">
        <h3 className="card-title">Confirmation & Auto-Approve</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Confirm File Edits</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Prompt user confirmation before writing or modifying any file.
              </div>
            </div>
            <button
              className={`btn btn-sm ${settings.confirm.edit ? 'btn-primary' : ''}`}
              onClick={handleToggleAutoApproveEdit}
            >
              {settings.confirm.edit ? 'ON (Prompt)' : 'OFF (Auto-Approve)'}
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0' }}>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Confirm Bash Commands</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Prompt user confirmation before executing shell commands outside the allowlist.
              </div>
            </div>
            <button
              className={`btn btn-sm ${settings.confirm.bash ? 'btn-primary' : ''}`}
              onClick={handleToggleAutoApproveBash}
            >
              {settings.confirm.bash ? 'ON (Prompt)' : 'OFF (Auto-Approve)'}
            </button>
          </div>
        </div>
      </div>

      {/* Security Policies */}
      <div className="forge-card">
        <h3 className="card-title">Security Policies (Always Enforced)</h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          <div className="metric-card">
            <div style={{ fontSize: '1rem', color: 'var(--green)', fontWeight: 'bold' }}>🔒 Active</div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginTop: '4px' }}>Project Root Guard</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Prevents ../ path escapes outside workspace</div>
          </div>

          <div className="metric-card">
            <div style={{ fontSize: '1rem', color: 'var(--green)', fontWeight: 'bold' }}>🔒 Active</div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginTop: '4px' }}>Credential Blocker</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Denies access to .env, .env.*, *.pem, *.key</div>
          </div>

          <div className="metric-card">
            <div style={{ fontSize: '1rem', color: 'var(--green)', fontWeight: 'bold' }}>🔒 Active</div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginTop: '4px' }}>SSH Key Shield</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Blocks read/write access to ~/.ssh</div>
          </div>

          <div className="metric-card">
            <div style={{ fontSize: '1rem', color: 'var(--green)', fontWeight: 'bold' }}>🔒 Active</div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginTop: '4px' }}>Dangerous Shell Guard</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Blocks sudo, rm -rf /, curl | sh</div>
          </div>
        </div>
      </div>
    </div>
  );
};
