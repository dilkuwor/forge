import React, { useState, useEffect } from 'react';
import { Navigation, PageTab } from './components/Navigation.js';
import { Header } from './components/Header.js';
import { useAgentState } from './hooks/useAgentState.js';

import { DashboardPage } from './pages/DashboardPage.js';
import { SessionsPage } from './pages/SessionsPage.js';
import { ActivityPage } from './pages/ActivityPage.js';
import { FilesDiffPage } from './pages/FilesDiffPage.js';
import { ModelsPage } from './pages/ModelsPage.js';
import { ProvidersPage } from './pages/ProvidersPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { PermissionsPage } from './pages/PermissionsPage.js';

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<PageTab>('dashboard');

  const {
    status,
    activeSessions,
    selectedSessionId,
    activity,
    todos,
    terminalOutput,
    pendingPermission,
    testSummary,
    connected,
    connectionState,
    refresh,
    switchSession
  } = useAgentState();

  // Hash-based routing
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '') as PageTab;
      const validTabs: PageTab[] = [
        'dashboard',
        'sessions',
        'activity',
        'diff',
        'models',
        'providers',
        'settings',
        'permissions'
      ];
      if (validTabs.includes(hash)) {
        setCurrentTab(hash);
      }
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleSelectTab = (tab: PageTab) => {
    setCurrentTab(tab);
    window.location.hash = tab;
  };

  return (
    <>
      <Navigation currentTab={currentTab} onSelectTab={handleSelectTab} />

      <div className="app-main">
        <Header
          status={status}
          connected={connected}
          connectionState={connectionState}
          activeSessions={activeSessions}
          selectedSessionId={selectedSessionId}
          onSelectSession={switchSession}
        />

        <main className="content-scrollable">
          {currentTab === 'dashboard' && (
            <DashboardPage
              status={status}
              activity={activity}
              todos={todos}
              terminalOutput={terminalOutput}
              pendingPermission={pendingPermission}
              onRefresh={refresh}
              onNavigate={handleSelectTab}
              selectedSessionId={selectedSessionId}
            />
          )}

          {currentTab === 'sessions' && (
            <SessionsPage
              activeSessions={activeSessions}
              selectedSessionId={selectedSessionId}
              onSelectSession={switchSession}
            />
          )}

          {currentTab === 'activity' && <ActivityPage activity={activity} />}

          {currentTab === 'diff' && <FilesDiffPage sessionId={selectedSessionId} />}

          {currentTab === 'models' && <ModelsPage />}

          {currentTab === 'providers' && <ProvidersPage />}

          {currentTab === 'settings' && <SettingsPage />}

          {currentTab === 'permissions' && <PermissionsPage />}
        </main>
      </div>
    </>
  );
};
