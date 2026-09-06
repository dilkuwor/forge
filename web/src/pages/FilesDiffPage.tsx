import React from 'react';
import { DiffViewer } from '../components/DiffViewer.js';

export const FilesDiffPage: React.FC = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="forge-card">
        <h2 style={{ fontSize: '1.2rem', color: 'var(--text-primary)', marginBottom: '6px' }}>
          Workspace Files & Git Diff
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Inspect uncommitted modifications made by Forge. Review changes line by line or safely revert individual files.
        </p>
      </div>

      <DiffViewer />
    </div>
  );
};
