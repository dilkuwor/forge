import React, { useState } from 'react';
import { ActivityItem } from '../types/index.js';

interface ActivityTimelineProps {
  activity: ActivityItem[];
}

export const ActivityTimeline: React.FC<ActivityTimelineProps> = ({ activity }) => {
  const [filter, setFilter] = useState<'all' | 'edit' | 'shell' | 'read' | 'error'>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = activity.filter((item) => {
    if (filter === 'all') return true;
    return item.type === filter;
  });

  return (
    <div className="forge-card">
      <div className="card-title">
        <span>Agent Activity Timeline</span>
        <div style={{ display: 'flex', gap: '6px' }}>
          {(['all', 'edit', 'shell', 'read', 'error'] as const).map((f) => (
            <button
              key={f}
              className={`btn btn-sm ${filter === f ? 'btn-primary' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: '16px 0', fontSize: '0.85rem' }}>
          No activities recorded yet.
        </div>
      ) : (
        <ul className="timeline">
          {filtered.map((item) => {
            const isExpanded = expandedIds.has(item.id);
            let icon = '●';
            let iconClass = 'running';
            if (item.status === 'done') {
              icon = '✓';
              iconClass = 'done';
            } else if (item.status === 'failed') {
              icon = '✗';
              iconClass = 'failed';
            }

            return (
              <li
                key={item.id}
                className="timeline-item"
                style={{ cursor: item.detail || item.toolResult || item.diff ? 'pointer' : 'default' }}
                onClick={() => (item.detail || item.toolResult || item.diff) && toggleExpand(item.id)}
              >
                <span className="timeline-time">{item.timestamp}</span>
                <span className={`timeline-icon ${iconClass}`}>{icon}</span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{item.title}</span>
                    {(item.detail || item.toolResult || item.diff) && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {isExpanded ? '▲ Hide' : '▼ Details'}
                      </span>
                    )}
                  </div>

                  {isExpanded && (
                    <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {item.diff && (
                        <div className="diff-container" style={{ maxHeight: '180px' }}>
                          {item.diff.split('\n').map((line, idx) => {
                            let cls = '';
                            if (line.startsWith('+')) cls = 'diff-line-add';
                            else if (line.startsWith('-')) cls = 'diff-line-del';
                            else if (line.startsWith('@')) cls = 'diff-line-info';
                            return (
                              <span key={idx} className={cls}>
                                {line}
                              </span>
                            );
                          })}
                        </div>
                      )}

                      {item.toolResult && (
                        <div
                          style={{
                            background: '#090d13',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: '4px',
                            padding: '8px',
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.75rem',
                            maxHeight: '140px',
                            overflowY: 'auto',
                            color: 'var(--text-secondary)'
                          }}
                        >
                          {item.toolResult}
                        </div>
                      )}

                      {item.detail && !item.toolResult && !item.diff && (
                        <div
                          style={{
                            background: '#090d13',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: '4px',
                            padding: '8px',
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)'
                          }}
                        >
                          {item.detail}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
