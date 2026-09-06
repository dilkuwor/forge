import React from 'react';
import { PendingPermission } from '../types/index.js';
import { api } from '../lib/api.js';

interface PermissionModalProps {
  permission: PendingPermission | null;
  onResolved: () => void;
}

export const PermissionModal: React.FC<PermissionModalProps> = ({ permission, onResolved }) => {
  if (!permission) return null;

  const handleApprove = async (mode: 'once' | 'session') => {
    try {
      await api.approvePermission(permission.id, mode);
      onResolved();
    } catch {
      // ignore
    }
  };

  const handleDeny = async () => {
    try {
      await api.denyPermission(permission.id);
      onResolved();
    } catch {
      // ignore
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ borderTop: '4px solid var(--yellow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <span style={{ fontSize: '1.2rem', color: 'var(--yellow)' }}>⚠️</span>
          <h3 style={{ fontSize: '1.1rem', color: 'var(--text-primary)' }}>Permission Required</h3>
        </div>

        <p style={{ color: 'var(--text-secondary)', marginBottom: '8px' }}>
          Forge requests permission to {permission.type === 'file' ? 'write to / edit file:' : 'execute bash command:'}
        </p>

        <div
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '6px',
            padding: '10px 14px',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            color: 'var(--cyan)',
            wordBreak: 'break-all',
            marginBottom: '20px'
          }}
        >
          {permission.target}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button className="btn btn-danger" onClick={handleDeny}>
            Deny
          </button>
          <button className="btn" onClick={() => handleApprove('once')}>
            Allow Once
          </button>
          <button className="btn btn-primary" onClick={() => handleApprove('session')}>
            Allow Session
          </button>
        </div>
      </div>
    </div>
  );
};
