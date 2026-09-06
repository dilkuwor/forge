import React from 'react';
import { AgentStatusResponse } from '../types/index.js';
import { StatusBadge } from './StatusBadge.js';

interface HeaderProps {
  status: AgentStatusResponse | null;
  connected: boolean;
  connectionState?: 'connected' | 'reconnecting' | 'disconnected';
}

export const Header: React.FC<HeaderProps> = ({ status, connectionState = 'reconnecting' }) => {
  let connColor = 'var(--yellow)';
  let connLabel = '⚠ Reconnecting...';
  if (connectionState === 'connected') {
    connColor = 'var(--green)';
    connLabel = '● Connected';
  } else if (connectionState === 'disconnected') {
    connColor = 'var(--red)';
    connLabel = '○ Disconnected';
  }

  return (
    <header className="top-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.95rem' }}>
            {status?.projectRoot || '~/workspace'}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', gap: '8px' }}>
            <span>Model: <strong style={{ color: 'var(--green)' }}>{status?.currentModel || 'openrouter/free'}</strong></span>
            <span>•</span>
            <span>Provider: <strong>{status?.currentProvider || 'openrouter'}</strong></span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: connColor, fontWeight: 500 }}>
          <span>{connLabel}</span>
        </div>
        <StatusBadge status={status?.status} />
      </div>
    </header>
  );
};
