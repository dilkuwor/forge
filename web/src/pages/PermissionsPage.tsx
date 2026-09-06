import React, { useState, useEffect } from 'react';
import { PermissionsPolicyResponse } from '../types/index.js';
import { api } from '../lib/api.js';

export const PermissionsPage: React.FC = () => {
  const [policy, setPolicy] = useState<PermissionsPolicyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const loadPolicy = async () => {
    try {
      const res = await api.getPermissions();
      setPolicy(res);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPolicy();
  }, []);

  const handleRevoke = async (file: string) => {
    try {
      await api.revokePermission(file);
      setMessage(`Revoked session approval for: ${file}`);
      await loadPolicy();
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      alert(`Error revoking permission: ${err.message}`);
    }
  };

  if (loading || !policy) {
    return <div className="forge-card" style={{ color: 'var(--text-muted)' }}>Loading permissions policy...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="forge-card">
        <h2 style={{ fontSize: '1.2rem', color: 'var(--text-primary)', marginBottom: '4px' }}>
          Security & Sandbox Permissions Policy
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Forge enforces strict deny-by-default boundary sandboxing. The web dashboard cannot bypass or weaken these protections.
        </p>
      </div>

      {message && (
        <div style={{ padding: '8px 14px', background: 'rgba(63, 185, 80, 0.15)', color: 'var(--green)', borderRadius: '6px', fontSize: '0.85rem' }}>
          {message}
        </div>
      )}

      {/* Policy Table */}
      <div className="forge-card">
        <h3 className="card-title">Protected Assets & Command Bans</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {policy.protectedAssets.map((asset) => (
            <div
              key={asset.target}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '1.1rem' }}>🔒</span>
                <div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--red)', fontSize: '0.9rem' }}>
                    {asset.target}
                  </span>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{asset.description}</div>
                </div>
              </div>

              <span
                style={{
                  fontSize: '0.75rem',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background: 'rgba(248, 81, 73, 0.15)',
                  color: 'var(--red)',
                  fontWeight: 600
                }}
              >
                BLOCKED
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Pre-approved bash commands */}
      <div className="forge-card">
        <h3 className="card-title">Pre-Approved Bash Allowlist</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '12px' }}>
          Safe inspection and test commands that run without prompting user confirmation:
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {policy.bashExecution.allowlist.map((cmd) => (
            <span
              key={cmd}
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '4px',
                padding: '4px 10px',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                color: 'var(--green)'
              }}
            >
              ✓ {cmd}
            </span>
          ))}
        </div>
      </div>

      {/* Session Approvals */}
      <div className="forge-card">
        <h3 className="card-title">Session-Level Approvals</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '12px' }}>
          Files approved for unrestricted edits during this current active session:
        </p>

        {policy.sessionApprovedFiles.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '8px 0' }}>
            No session-level file approvals active. Files require approval when modified.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {policy.sessionApprovedFiles.map((file) => (
              <div
                key={file}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '6px'
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--cyan)' }}>
                  {file}
                </span>

                <button className="btn btn-sm btn-danger" onClick={() => handleRevoke(file)}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
