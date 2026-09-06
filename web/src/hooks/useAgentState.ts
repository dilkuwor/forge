import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useAgentSocket, WebSocketMessage } from './useAgentSocket.js';
import {
  AgentStatusResponse,
  ActivityItem,
  TodoItem,
  PendingPermission,
  TestSummary
} from '../types/index.js';

export function useAgentState() {
  const [status, setStatus] = useState<AgentStatusResponse | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [terminalOutput, setTerminalOutput] = useState<string>('');
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [testSummary, setTestSummary] = useState<TestSummary | null>(null);
  const [loading, setLoading] = useState(true);

  // Initial fetch
  const refresh = useCallback(async () => {
    try {
      const st = await api.getStatus();
      setStatus(st);
      setPendingPermission(st.pendingPermission);

      const sess = await api.getCurrentSession();
      if ('activity' in sess) {
        setActivity(sess.activity || []);
        setTodos(sess.todos || []);
        setTerminalOutput(sess.terminalOutput || '');
        setTestSummary(sess.testSummary || null);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Handle WebSocket live messages
  const handleSocketMessage = useCallback((msg: WebSocketMessage) => {
    if (msg.type === 'init') {
      if (msg.status) {
        setStatus(msg.status);
        setPendingPermission(msg.status.pendingPermission);
      }
      if (msg.session) {
        setActivity(msg.session.activity || []);
        setTodos(msg.session.todos || []);
        setTerminalOutput(msg.session.terminalOutput || '');
        setTestSummary(msg.session.testSummary || null);
      }
    } else if (msg.type === 'status_update') {
      setStatus(msg.status);
      setPendingPermission(msg.status.pendingPermission);
    } else if (msg.type === 'activity_item') {
      setActivity((prev) => [msg.item, ...prev]);
    } else if (msg.type === 'terminal_chunk') {
      setTerminalOutput((prev) => (prev + msg.chunk).slice(-50000));
    } else if (msg.type === 'todos_update') {
      setTodos(msg.todos);
    } else if (msg.type === 'permission_required') {
      setPendingPermission(msg.permission);
    } else if (msg.type === 'test_summary') {
      setTestSummary(msg.testSummary);
    }
  }, []);

  const { connected, connectionState, send } = useAgentSocket(handleSocketMessage);

  return {
    status,
    activity,
    todos,
    terminalOutput,
    pendingPermission,
    testSummary,
    connected,
    connectionState,
    loading,
    refresh,
    send
  };
}
