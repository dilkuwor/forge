import { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { ForgeAdapter } from '../forge-adapter.js';
import { SessionManager } from '../session-manager.js';

function parseJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err: any) {
        reject(new Error(`Invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, statusCode: number, message: string) {
  sendJson(res, statusCode, { error: message });
}

export async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  adapter: ForgeAdapter,
  sessionManager?: SessionManager
): Promise<boolean> {
  const pathname = parsedUrl.pathname;
  const method = req.method || 'GET';
  const sessionId = parsedUrl.searchParams.get('session') || undefined;

  if (!pathname.startsWith('/api/')) {
    return false;
  }

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return true;
  }

  try {
    // GET /api/health - Lightweight health probe for terminal registration
    if (pathname === '/api/health' && method === 'GET') {
      sendJson(res, 200, {
        status: 'ok',
        server: 'forge-ui',
        port: 4317,
        version: '0.1.0',
        activeSessionsCount: sessionManager ? sessionManager.getActiveSessions().length : 1
      });
      return true;
    }

    // GET /api/sessions/active - List all live registered terminal sessions
    if (pathname === '/api/sessions/active' && method === 'GET') {
      const active = sessionManager ? sessionManager.getActiveSessions() : [];
      sendJson(res, 200, active);
      return true;
    }

    // POST /api/sessions/register - Register a terminal session
    if (pathname === '/api/sessions/register' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.sessionId) {
        sendError(res, 400, 'sessionId is required');
        return true;
      }
      const session = sessionManager
        ? sessionManager.registerSession(body)
        : { sessionId: body.sessionId, status: 'IDLE' };
      sendJson(res, 200, { success: true, session });
      return true;
    }

    // POST /api/sessions/select - Switch selected session in UI
    if (pathname === '/api/sessions/select' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.sessionId) {
        sendError(res, 400, 'sessionId is required');
        return true;
      }
      const success = sessionManager ? sessionManager.selectSession(body.sessionId) : false;
      sendJson(res, 200, { success, selectedSessionId: body.sessionId });
      return true;
    }

    // POST /api/sessions/:id/update - Update session progress & events
    if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/update') && method === 'POST') {
      const id = pathname.replace('/api/sessions/', '').replace('/update', '').trim();
      const body = await parseJsonBody(req);
      if (sessionManager) {
        sessionManager.updateSession(id, body);
      }
      sendJson(res, 200, { success: true });
      return true;
    }

    // POST /api/sessions/:id/heartbeat
    if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/heartbeat') && method === 'POST') {
      const id = pathname.replace('/api/sessions/', '').replace('/heartbeat', '').trim();
      if (sessionManager) {
        sessionManager.recordHeartbeat(id);
      }
      sendJson(res, 200, { success: true });
      return true;
    }

    // POST /api/sessions/:id/unregister
    if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/unregister') && method === 'POST') {
      const id = pathname.replace('/api/sessions/', '').replace('/unregister', '').trim();
      if (sessionManager) {
        sessionManager.unregisterSession(id);
      }
      sendJson(res, 200, { success: true });
      return true;
    }

    // GET /api/status - Scoped to selected session
    if (pathname === '/api/status' && method === 'GET') {
      const statusData = sessionManager ? sessionManager.getStatus(sessionId) : adapter.getStatus();
      sendJson(res, 200, statusData);
      return true;
    }

    // GET /api/session/current - Scoped to selected session
    if (pathname === '/api/session/current' && method === 'GET') {
      const current = sessionManager
        ? sessionManager.getSessionDetail(sessionId)
        : adapter.getCurrentSessionDetail();
      if (!current || ('message' in current && !current.id)) {
        sendJson(res, 200, { message: 'No session active or found' });
      } else {
        sendJson(res, 200, current);
      }
      return true;
    }

    // GET /api/sessions - Historical sessions
    if (pathname === '/api/sessions' && method === 'GET') {
      sendJson(res, 200, adapter.getSessions());
      return true;
    }

    // GET /api/sessions/:id
    if (pathname.startsWith('/api/sessions/') && method === 'GET') {
      const id = pathname.replace('/api/sessions/', '').trim();
      const detail = sessionManager
        ? sessionManager.getSessionDetail(id)
        : adapter.getSessionDetail(id);
      if (!detail || ('message' in detail && !detail.id)) {
        sendError(res, 404, `Session not found: ${id}`);
      } else {
        sendJson(res, 200, detail);
      }
      return true;
    }

    // GET /api/activity - Scoped to selected session
    if (pathname === '/api/activity' && method === 'GET') {
      const act = sessionManager
        ? sessionManager.getActivity(sessionId)
        : adapter.getCurrentSessionDetail()?.activity || [];
      sendJson(res, 200, act);
      return true;
    }

    // GET /api/todos - Scoped to selected session
    if (pathname === '/api/todos' && method === 'GET') {
      const todos = sessionManager
        ? sessionManager.getTodos(sessionId)
        : adapter.getCurrentSessionDetail()?.todos || [];
      sendJson(res, 200, todos);
      return true;
    }

    // GET /api/terminal - Scoped to selected session
    if (pathname === '/api/terminal' && method === 'GET') {
      const output = sessionManager
        ? sessionManager.getTerminalOutput(sessionId)
        : adapter.getCurrentSessionDetail()?.terminalOutput || '';
      sendJson(res, 200, { output });
      return true;
    }

    // GET /api/files - Scoped to selected session's workspace
    if (pathname === '/api/files' && method === 'GET') {
      const files = sessionManager
        ? sessionManager.getFilesChanged(sessionId)
        : adapter.getFilesChanged();
      sendJson(res, 200, files);
      return true;
    }

    // GET /api/diff - Scoped to selected session's workspace
    if (pathname === '/api/diff' && method === 'GET') {
      const file = parsedUrl.searchParams.get('file') || undefined;
      const diff = sessionManager
        ? sessionManager.getDiff(sessionId, file)
        : { diff: adapter.getDiff(file) };
      sendJson(res, 200, diff);
      return true;
    }

    // POST /api/files/revert - Scoped to selected session's workspace
    if (pathname === '/api/files/revert' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.file) {
        sendError(res, 400, 'File path required');
        return true;
      }
      const targetSessionId = body.sessionId || sessionId;
      const result = sessionManager
        ? sessionManager.revertFile(targetSessionId, body.file)
        : adapter.revertFile(body.file);
      sendJson(res, 200, result);
      return true;
    }

    // POST /api/files/revert-forge and /api/files/revert-all
    if ((pathname === '/api/files/revert-forge' || pathname === '/api/files/revert-all') && method === 'POST') {
      const targetSessionId = sessionId;
      const result = sessionManager
        ? sessionManager.revertForgeChanges(targetSessionId)
        : adapter.revertForgeChanges();
      sendJson(res, 200, result);
      return true;
    }

    // GET /api/tests
    if (pathname === '/api/tests' && method === 'GET') {
      const summary = adapter.getTestSummary();
      sendJson(res, 200, summary || { message: 'No tests run yet', passed: 0, failed: 0, skipped: 0, total: 0 });
      return true;
    }

    // POST /api/tests/run
    if (pathname === '/api/tests/run' && method === 'POST') {
      const summary = await adapter.runTests();
      sendJson(res, 200, summary);
      return true;
    }

    // GET /api/models
    if (pathname === '/api/models' && method === 'GET') {
      sendJson(res, 200, adapter.getModelsData());
      return true;
    }

    // POST /api/models/select
    if (pathname === '/api/models/select' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.model) {
        sendError(res, 400, 'Model name required');
        return true;
      }
      const updated = adapter.selectDefaultModel(body.model, body.provider);
      sendJson(res, 200, { success: true, config: updated });
      return true;
    }

    // POST /api/models/fallback
    if (pathname === '/api/models/fallback' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!Array.isArray(body.fallbackModels)) {
        sendError(res, 400, 'fallbackModels array required');
        return true;
      }
      const updated = adapter.setFallbackModels(body.fallbackModels);
      sendJson(res, 200, { success: true, fallbackModels: updated.fallbackModels });
      return true;
    }

    // POST /api/models/refresh
    if (pathname === '/api/models/refresh' && method === 'POST') {
      const result = await adapter.refreshModels();
      sendJson(res, 200, { success: true, ...result });
      return true;
    }

    // GET /api/providers
    if (pathname === '/api/providers' && method === 'GET') {
      sendJson(res, 200, adapter.getProvidersData());
      return true;
    }

    // POST /api/providers/:provider/key or POST /api/providers/:provider
    if (
      pathname.startsWith('/api/providers/') &&
      !pathname.endsWith('/test') &&
      pathname !== '/api/providers' &&
      method === 'POST'
    ) {
      const parts = pathname.split('/');
      const provider = parts[3] as 'openrouter' | 'nvidia';
      const body = await parseJsonBody(req);
      if (!body.apiKey) {
        sendError(res, 400, 'apiKey is required');
        return true;
      }
      const result = adapter.setProviderKey(provider, body.apiKey);
      sendJson(res, 200, result);
      return true;
    }

    // POST /api/providers/:provider/test or POST /api/providers/test
    if (
      ((pathname.startsWith('/api/providers/') && pathname.endsWith('/test')) || pathname === '/api/providers/test') &&
      method === 'POST'
    ) {
      const body = await parseJsonBody(req);
      const parts = pathname.split('/');
      const provider = (parts[3] !== 'test' ? parts[3] : body.provider) as 'openrouter' | 'nvidia';
      if (!provider) {
        sendError(res, 400, 'provider is required');
        return true;
      }
      const result = await adapter.testProviderConnection(provider);
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
    }

    // GET /api/settings
    if (pathname === '/api/settings' && method === 'GET') {
      sendJson(res, 200, adapter.getSettings());
      return true;
    }

    // POST /api/settings
    if (pathname === '/api/settings' && method === 'POST') {
      const body = await parseJsonBody(req);
      const updated = adapter.updateSettings(body);
      sendJson(res, 200, { success: true, settings: adapter.getSettings(), config: updated });
      return true;
    }

    // GET /api/permissions
    if (pathname === '/api/permissions' && method === 'GET') {
      sendJson(res, 200, adapter.getPermissionsPolicy());
      return true;
    }

    // POST /api/permissions/approve
    if (pathname === '/api/permissions/approve' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.id) {
        sendError(res, 400, 'Permission request ID required');
        return true;
      }
      const success = adapter.approvePermission(body.id, body.mode || 'once');
      sendJson(res, 200, { success });
      return true;
    }

    // POST /api/permissions/deny
    if (pathname === '/api/permissions/deny' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.id) {
        sendError(res, 400, 'Permission request ID required');
        return true;
      }
      const success = adapter.denyPermission(body.id);
      sendJson(res, 200, { success });
      return true;
    }

    // POST /api/permissions/revoke
    if (pathname === '/api/permissions/revoke' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.file) {
        sendError(res, 400, 'File path required');
        return true;
      }
      const success = adapter.revokeSessionApproval(body.file);
      sendJson(res, 200, { success });
      return true;
    }

    // POST /api/agent/run
    if (pathname === '/api/agent/run' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.task || typeof body.task !== 'string') {
        sendError(res, 400, 'Task description required');
        return true;
      }
      // Start in background
      adapter.runTask(body.task, body.noConfirm).catch(() => {});
      sendJson(res, 202, { success: true, message: 'Agent loop started', task: body.task });
      return true;
    }

    // POST /api/agent/pause
    if (pathname === '/api/agent/pause' && method === 'POST') {
      const targetAdapter = sessionManager ? sessionManager.getAdapter(sessionId) : adapter;
      targetAdapter.pause();
      sendJson(res, 200, { success: true, status: targetAdapter.getStatus() });
      return true;
    }

    // POST /api/agent/resume
    if (pathname === '/api/agent/resume' && method === 'POST') {
      const targetAdapter = sessionManager ? sessionManager.getAdapter(sessionId) : adapter;
      targetAdapter.resume();
      sendJson(res, 200, { success: true, status: targetAdapter.getStatus() });
      return true;
    }

    // POST /api/agent/stop
    if (pathname === '/api/agent/stop' && method === 'POST') {
      const targetAdapter = sessionManager ? sessionManager.getAdapter(sessionId) : adapter;
      targetAdapter.stop();
      sendJson(res, 200, { success: true, status: targetAdapter.getStatus() });
      return true;
    }

    // POST /api/chat - Architecture ready for future separate Chat UI
    if (pathname === '/api/chat' && method === 'POST') {
      const body = await parseJsonBody(req);
      sendJson(res, 200, {
        success: true,
        message: 'Chat endpoint ready for future separate Chat UI.',
        sessionId: body.sessionId || sessionId || sessionManager?.getSelectedSessionId()
      });
      return true;
    }

    // Unknown API endpoint
    sendError(res, 404, `Endpoint not found: ${method} ${pathname}`);
    return true;
  } catch (err: any) {
    sendError(res, 500, `Internal error: ${err.message}`);
    return true;
  }
}
