import { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { ForgeAdapter } from '../forge-adapter.js';

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
  adapter: ForgeAdapter
): Promise<boolean> {
  const pathname = parsedUrl.pathname;
  const method = req.method || 'GET';

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
    // GET /api/status
    if (pathname === '/api/status' && method === 'GET') {
      sendJson(res, 200, adapter.getStatus());
      return true;
    }

    // GET /api/session/current
    if (pathname === '/api/session/current' && method === 'GET') {
      const current = adapter.getCurrentSessionDetail();
      if (!current) {
        sendJson(res, 200, { message: 'No session active or found' });
      } else {
        sendJson(res, 200, current);
      }
      return true;
    }

    // GET /api/sessions
    if (pathname === '/api/sessions' && method === 'GET') {
      sendJson(res, 200, adapter.getSessions());
      return true;
    }

    // GET /api/sessions/:id
    if (pathname.startsWith('/api/sessions/') && method === 'GET') {
      const id = pathname.replace('/api/sessions/', '').trim();
      const detail = adapter.getSessionDetail(id);
      if (!detail) {
        sendError(res, 404, `Session not found: ${id}`);
      } else {
        sendJson(res, 200, detail);
      }
      return true;
    }

    // GET /api/activity
    if (pathname === '/api/activity' && method === 'GET') {
      const current = adapter.getCurrentSessionDetail();
      sendJson(res, 200, current?.activity || []);
      return true;
    }

    // GET /api/files
    if (pathname === '/api/files' && method === 'GET') {
      sendJson(res, 200, adapter.getFilesChanged());
      return true;
    }

    // GET /api/diff
    if (pathname === '/api/diff' && method === 'GET') {
      const file = parsedUrl.searchParams.get('file') || undefined;
      const diff = adapter.getDiff(file);
      sendJson(res, 200, { diff });
      return true;
    }

    // POST /api/files/revert
    if (pathname === '/api/files/revert' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.file) {
        sendError(res, 400, 'File path required');
        return true;
      }
      const result = adapter.revertFile(body.file);
      sendJson(res, 200, result);
      return true;
    }

    // POST /api/files/revert-forge and /api/files/revert-all
    if ((pathname === '/api/files/revert-forge' || pathname === '/api/files/revert-all') && method === 'POST') {
      const result = adapter.revertForgeChanges();
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
      adapter.pause();
      sendJson(res, 200, { success: true, status: adapter.getStatus() });
      return true;
    }

    // POST /api/agent/resume
    if (pathname === '/api/agent/resume' && method === 'POST') {
      adapter.resume();
      sendJson(res, 200, { success: true, status: adapter.getStatus() });
      return true;
    }

    // POST /api/agent/stop
    if (pathname === '/api/agent/stop' && method === 'POST') {
      adapter.stop();
      sendJson(res, 200, { success: true, status: adapter.getStatus() });
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
