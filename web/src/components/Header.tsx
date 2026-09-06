import React from 'react';
import { AgentStatusResponse } from '../types/index.js';
import { StatusBadge } from './StatusBadge.js';
import { formatTokens, getContextStatus } from '../lib/tokens.js';

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

  const utilizationPercent = status?.tokenUsage?.utilizationPercent ?? 0;
  const contextStatus = getContextStatus(utilizationPercent);
  const currentContext = status?.tokenUsage?.currentContextTokens ?? 0;
  const contextLimit = status?.tokenUsage?.modelContextLimit ?? 32768;

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
        {status?.isRunning && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 10px',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-mono)'
            }}
            title={`Step ${status.step}/${status.maxSteps || 30} — Context ${utilizationPercent}% (${formatTokens(currentContext)} / ${formatTokens(contextLimit)} tokens)`}
          >
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
              Step {status.step}/{status.maxSteps || 30}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>•</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span
                style={{
                  display: 'inline-block',
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  backgroundColor: contextStatus.color
                }}
              />
              <span style={{ color: contextStatus.color, fontWeight: 600 }}>
                Context {utilizationPercent}%
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {formatTokens(currentContext)} / {formatTokens(contextLimit)} tokens
              </span>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: connColor, fontWeight: 500 }}>
          <span>{connLabel}</span>
        </div>
        <StatusBadge status={status?.status} />
      </div>
    </header>
  );
};
