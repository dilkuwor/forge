import React from 'react';

export type PageTab =
  | 'dashboard'
  | 'sessions'
  | 'activity'
  | 'diff'
  | 'models'
  | 'providers'
  | 'settings'
  | 'permissions';

interface NavigationProps {
  currentTab: PageTab;
  onSelectTab: (tab: PageTab) => void;
}

export const Navigation: React.FC<NavigationProps> = ({ currentTab, onSelectTab }) => {
  return (
    <aside className="app-sidebar">
      <div className="brand-logo">
        <span>FORGE</span>
        <span style={{ color: 'var(--yellow)' }}>⚡</span>
        <span className="brand-badge">v0.1.0</span>
      </div>

      <div className="nav-section">
        <div className="nav-section-title">Work</div>
        <div
          className={`nav-link ${currentTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => onSelectTab('dashboard')}
        >
          <span>📊</span>
          <span>Dashboard</span>
        </div>
        <div
          className={`nav-link ${currentTab === 'sessions' ? 'active' : ''}`}
          onClick={() => onSelectTab('sessions')}
        >
          <span>🕒</span>
          <span>Sessions</span>
        </div>
        <div
          className={`nav-link ${currentTab === 'activity' ? 'active' : ''}`}
          onClick={() => onSelectTab('activity')}
        >
          <span>📜</span>
          <span>Activity</span>
        </div>
        <div
          className={`nav-link ${currentTab === 'diff' ? 'active' : ''}`}
          onClick={() => onSelectTab('diff')}
        >
          <span>📝</span>
          <span>Files & Diff</span>
        </div>
      </div>

      <div className="nav-section">
        <div className="nav-section-title">Configuration</div>
        <div
          className={`nav-link ${currentTab === 'models' ? 'active' : ''}`}
          onClick={() => onSelectTab('models')}
        >
          <span>🤖</span>
          <span>Models</span>
        </div>
        <div
          className={`nav-link ${currentTab === 'providers' ? 'active' : ''}`}
          onClick={() => onSelectTab('providers')}
        >
          <span>🔑</span>
          <span>Providers</span>
        </div>
        <div
          className={`nav-link ${currentTab === 'settings' ? 'active' : ''}`}
          onClick={() => onSelectTab('settings')}
        >
          <span>⚙️</span>
          <span>Settings</span>
        </div>
        <div
          className={`nav-link ${currentTab === 'permissions' ? 'active' : ''}`}
          onClick={() => onSelectTab('permissions')}
        >
          <span>🛡️</span>
          <span>Permissions</span>
        </div>
      </div>
    </aside>
  );
};
