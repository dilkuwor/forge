import React from 'react';
import { AgentStatusType } from '../types/index.js';

interface StatusBadgeProps {
  status?: AgentStatusType;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status = 'IDLE' }) => {
  const className = `status-pill ${status.toLowerCase()}`;

  let dotColor = 'var(--text-muted)';
  if (status === 'WORKING') dotColor = 'var(--cyan)';
  else if (status === 'PAUSED') dotColor = 'var(--yellow)';
  else if (status === 'AWAITING_APPROVAL') dotColor = 'var(--red)';
  else if (status === 'COMPLETED') dotColor = 'var(--green)';
  else if (status === 'ERROR') dotColor = 'var(--red)';

  return (
    <span className={className}>
      <span style={{ color: dotColor }}>●</span>
      <span>{status.replace('_', ' ')}</span>
    </span>
  );
};
