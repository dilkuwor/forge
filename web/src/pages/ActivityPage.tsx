import React from 'react';
import { ActivityItem } from '../types/index.js';
import { ActivityTimeline } from '../components/ActivityTimeline.js';

interface ActivityPageProps {
  activity: ActivityItem[];
}

export const ActivityPage: React.FC<ActivityPageProps> = ({ activity }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="forge-card">
        <h2 style={{ fontSize: '1.2rem', color: 'var(--text-primary)', marginBottom: '6px' }}>
          Chronological Agent Activity
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Live chronological audit log of observable agent actions, tool calls, and status events during this session.
        </p>
      </div>

      <ActivityTimeline activity={activity} />
    </div>
  );
};
