import http, { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { exec } from 'node:child_process';

import { ForgeAdapter } from './forge-adapter.js';
import { WebSocketHandler } from './websocket/handler.js';
import { handleApiRoute } from './routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerOptions {
  port?: number;
  host?: string;
  projectRoot?: string;
  openBrowser?: boolean;
  autoApprove?: boolean;
}

export interface RunningServer {
  server: HttpServer;
  port: number;
  host: string;
  url: string;
  adapter: ForgeAdapter;
  wsHandler: WebSocketHandler;
  close: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function getWebDistPath(): string {
  // Check multiple likely paths for web/dist
  const candidates = [
    path.resolve(__dirname, '../../web/dist'),
    path.resolve(__dirname, '../web/dist'),
    path.resolve(process.cwd(), 'web/dist'),
    path.resolve(__dirname, '../../../web/dist')
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return path.resolve(__dirname, '../../web/dist');
}

function serveStaticFile(res: ServerResponse, filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache'
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  return true;
}

export async function createServer(options?: ServerOptions): Promise<{
  server: HttpServer;
  adapter: ForgeAdapter;
  wsHandler: WebSocketHandler;
}> {
  const projectRoot = options?.projectRoot || process.cwd();
  const adapter = new ForgeAdapter(projectRoot, { autoApprove: options?.autoApprove });

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    // 1. API routes
    if (parsedUrl.pathname.startsWith('/api/')) {
      const handled = await handleApiRoute(req, res, parsedUrl, adapter);
      if (handled) return;
    }

    // 2. Static files from web/dist
    const webDist = getWebDistPath();
    if (fs.existsSync(webDist)) {
      let candidate = path.join(webDist, parsedUrl.pathname);
      if (candidate.endsWith('/') || !path.extname(candidate)) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          candidate = path.join(candidate, 'index.html');
        }
      }

      if (serveStaticFile(res, candidate)) {
        return;
      }

      // SPA fallback
      const indexPath = path.join(webDist, 'index.html');
      if (serveStaticFile(res, indexPath)) {
        return;
      }
    }

    // 3. Fallback: lightweight embedded UI dashboard if web/dist has not been built yet
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getEmbeddedDashboardHtml());
  });

  const wsHandler = new WebSocketHandler(server, adapter);

  return { server, adapter, wsHandler };
}

export async function startServer(options?: ServerOptions): Promise<RunningServer> {
  const host = options?.host || '127.0.0.1';
  let port = options?.port || 4317;

  const { server, adapter, wsHandler } = await createServer(options);

  return new Promise((resolve, reject) => {
    const tryListen = (currentPort: number) => {
      server.removeAllListeners('error');

      server.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`Port ${currentPort} in use, trying ${currentPort + 1}...`);
          tryListen(currentPort + 1);
        } else {
          reject(err);
        }
      });

      server.listen(currentPort, host, () => {
        port = currentPort;
        const url = `http://${host}:${port}`;
        console.log(`\nForge UI running at:\n${url}\n`);

        if (options?.openBrowser !== false) {
          openBrowserWindow(url);
        }

        resolve({
          server,
          port,
          host,
          url,
          adapter,
          wsHandler,
          close: () =>
            new Promise((res) => {
              wsHandler.close();
              server.close(() => res());
            })
        });
      });
    };

    tryListen(port);
  });
}

function openBrowserWindow(url: string) {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
      ? `start "${url}"`
      : `xdg-open "${url}"`;

  exec(cmd, () => {
    // Ignore errors in headless / ssh environments
  });
}

function getEmbeddedDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Forge Dashboard</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --cyan: #58a6ff;
      --magenta: #bc8cff;
      --green: #3fb950;
      --yellow: #d29922;
      --red: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    #sidebar {
      width: 240px;
      background: #090d13;
      border-right: 1px solid var(--border);
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
    }
    .logo {
      font-weight: bold;
      font-size: 1.25rem;
      letter-spacing: 1px;
      color: var(--cyan);
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nav-group { margin-bottom: 20px; }
    .nav-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--text-muted);
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      padding-left: 8px;
    }
    .nav-item {
      display: block;
      padding: 8px 12px;
      color: var(--text);
      text-decoration: none;
      border-radius: 6px;
      font-size: 0.9rem;
      cursor: pointer;
      margin-bottom: 2px;
    }
    .nav-item:hover, .nav-item.active {
      background: #21262d;
      color: #fff;
    }
    #content {
      flex: 1;
      overflow-y: auto;
      padding: 24px 32px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 0.8rem;
      font-weight: 600;
      background: #21262d;
    }
    .status-badge.working { background: rgba(56, 139, 253, 0.2); color: var(--cyan); }
    .status-badge.idle { background: rgba(139, 148, 158, 0.2); color: var(--text-muted); }
    .status-badge.paused { background: rgba(210, 153, 34, 0.2); color: var(--yellow); }
    .status-badge.awaiting { background: rgba(248, 81, 73, 0.2); color: var(--red); }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
    }
    .card h3 { font-size: 1rem; margin-bottom: 12px; color: #fff; }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 16px;
    }
    .metric-box {
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
    }
    .metric-label { font-size: 0.75rem; color: var(--text-muted); }
    .metric-value { font-size: 1.25rem; font-weight: bold; color: #fff; margin-top: 4px; }
    .controls-row { display: flex; gap: 10px; margin-top: 12px; }
    button {
      padding: 8px 16px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #21262d;
      color: #fff;
      cursor: pointer;
      font-weight: 500;
      transition: background 0.15s;
    }
    button:hover { background: #30363d; }
    button.primary { background: #238636; border-color: #2ea043; }
    button.primary:hover { background: #2ea043; }
    button.danger { background: #da3633; border-color: #f85149; }
    button.danger:hover { background: #b62324; }
    pre {
      background: #090d13;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      overflow-x: auto;
      font-family: monospace;
      font-size: 0.85rem;
      max-height: 250px;
    }
    .permission-banner {
      background: rgba(210, 153, 34, 0.15);
      border: 1px solid var(--yellow);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .activity-list { list-style: none; }
    .activity-item {
      padding: 8px 0;
      border-bottom: 1px solid #21262d;
      display: flex;
      gap: 10px;
      font-size: 0.875rem;
    }
    .activity-item:last-child { border-bottom: none; }
    .activity-time { color: var(--text-muted); font-size: 0.75rem; min-width: 65px; }
  </style>
</head>
<body>
  <div id="sidebar">
    <div class="logo">FORGE ⚡</div>
    <div class="nav-group">
      <div class="nav-label">Work</div>
      <div class="nav-item active" onclick="showTab('dashboard')">Dashboard</div>
      <div class="nav-item" onclick="showTab('sessions')">Sessions</div>
      <div class="nav-item" onclick="showTab('activity')">Activity</div>
      <div class="nav-item" onclick="showTab('diff')">Files & Diff</div>
    </div>
    <div class="nav-group">
      <div class="nav-label">Configuration</div>
      <div class="nav-item" onclick="showTab('models')">Models</div>
      <div class="nav-item" onclick="showTab('providers')">Providers</div>
      <div class="nav-item" onclick="showTab('settings')">Settings</div>
      <div class="nav-item" onclick="showTab('permissions')">Permissions</div>
    </div>
  </div>

  <div id="content">
    <div class="header-bar">
      <div>
        <h2 id="project-path" style="font-size: 1.1rem; color: #fff;">~/workspace</h2>
        <div style="font-size: 0.85rem; color: var(--text-muted);">
          Model: <span id="current-model" style="color: var(--green);">openrouter/free</span> | Provider: <span id="current-provider">openrouter</span>
        </div>
      </div>
      <div id="agent-status" class="status-badge idle">● IDLE</div>
    </div>

    <div id="permission-container"></div>

    <div class="card">
      <h3>Active Task</h3>
      <div style="display: flex; gap: 8px;">
        <input id="task-input" type="text" placeholder="Enter task (e.g. Add OAuth authentication or fix failing tests)..." style="flex: 1; padding: 10px 14px; background: #0d1117; border: 1px solid var(--border); border-radius: 6px; color: #fff;" />
        <button class="primary" onclick="startTask()">Run Task</button>
      </div>
      <div class="controls-row">
        <button onclick="pauseAgent()">Pause</button>
        <button onclick="resumeAgent()">Resume</button>
        <button class="danger" onclick="stopAgent()">Stop</button>
      </div>
    </div>

    <div class="metrics-grid">
      <div class="metric-box">
        <div class="metric-label">Step</div>
        <div class="metric-value" id="metric-step">0 / 30</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Tool Calls</div>
        <div class="metric-value" id="metric-tools">0</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Elapsed Time</div>
        <div class="metric-value" id="metric-time">00:00</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Files Changed</div>
        <div class="metric-value" id="metric-files">0</div>
      </div>
    </div>

    <div class="card">
      <h3>Current Operation</h3>
      <div id="current-operation" style="color: var(--cyan); font-family: monospace;">Idle</div>
    </div>

    <div class="card">
      <h3>Live Activity</h3>
      <ul class="activity-list" id="activity-container">
        <li style="color: var(--text-muted); font-size: 0.85rem;">No activity yet.</li>
      </ul>
    </div>

    <div class="card">
      <h3>Terminal Output</h3>
      <pre id="terminal-output">// Terminal stream will appear here...</pre>
    </div>
  </div>

  <script>
    let ws;
    function connectWs() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws');

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'init' || msg.type === 'status_update') {
            updateStatus(msg.status);
          } else if (msg.type === 'activity_item') {
            addActivity(msg.item);
          } else if (msg.type === 'terminal_chunk') {
            appendTerminal(msg.chunk);
          } else if (msg.type === 'permission_required') {
            showPermission(msg.permission);
          }
        } catch (err) {}
      };

      ws.onclose = () => {
        setTimeout(connectWs, 2000);
      };
    }

    function updateStatus(st) {
      if (!st) return;
      document.getElementById('project-path').innerText = st.projectRoot || '~/';
      document.getElementById('current-model').innerText = st.currentModel || 'default';
      document.getElementById('current-provider').innerText = st.currentProvider || 'openrouter';

      const statusEl = document.getElementById('agent-status');
      statusEl.innerText = '● ' + st.status;
      statusEl.className = 'status-badge ' + st.status.toLowerCase();

      document.getElementById('metric-step').innerText = st.step + ' / ' + st.maxSteps;
      document.getElementById('metric-tools').innerText = st.toolCount;
      document.getElementById('metric-files').innerText = st.filesChangedCount;

      const seconds = Math.floor((st.elapsedTimeMs || 0) / 1000);
      const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
      const secs = String(seconds % 60).padStart(2, '0');
      document.getElementById('metric-time').innerText = mins + ':' + secs;

      document.getElementById('current-operation').innerText = st.currentOperation || 'Idle';

      if (st.pendingPermission) {
        showPermission(st.pendingPermission);
      } else {
        document.getElementById('permission-container').innerHTML = '';
      }
    }

    function showPermission(perm) {
      const el = document.getElementById('permission-container');
      el.innerHTML = \`
        <div class="permission-banner">
          <h4 style="color: var(--yellow); margin-bottom: 6px;">Permission Required</h4>
          <p style="margin-bottom: 10px;">Forge wants to \${perm.type === 'file' ? 'edit/write to' : 'execute'}: <code style="background:#090d13; padding:2px 6px; border-radius:4px;">\${perm.target}</code></p>
          <div style="display: flex; gap: 8px;">
            <button class="primary" onclick="resolvePermission('\${perm.id}', 'once')">Allow Once</button>
            <button onclick="resolvePermission('\${perm.id}', 'session')">Allow Session</button>
            <button class="danger" onclick="denyPermission('\${perm.id}')">Deny</button>
          </div>
        </div>
      \`;
    }

    function resolvePermission(id, mode) {
      fetch('/api/permissions/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, mode })
      });
    }

    function denyPermission(id) {
      fetch('/api/permissions/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
    }

    function startTask() {
      const task = document.getElementById('task-input').value;
      if (!task.trim()) return;
      fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task })
      });
    }

    function pauseAgent() { fetch('/api/agent/pause', { method: 'POST' }); }
    function resumeAgent() { fetch('/api/agent/resume', { method: 'POST' }); }
    function stopAgent() { fetch('/api/agent/stop', { method: 'POST' }); }

    function addActivity(item) {
      const c = document.getElementById('activity-container');
      const li = document.createElement('li');
      li.className = 'activity-item';
      li.innerHTML = \`<span class="activity-time">\${item.timestamp}</span><span>\${item.title}</span>\`;
      c.prepend(li);
    }

    function appendTerminal(chunk) {
      const t = document.getElementById('terminal-output');
      t.innerText += chunk;
      t.scrollTop = t.scrollHeight;
    }

    function showTab(tab) {
      // In SPA mode, routes are handled via history or tab views
      window.location.hash = tab;
    }

    connectWs();
    fetch('/api/status').then(r => r.json()).then(updateStatus);
  </script>
</body>
</html>`;
}
