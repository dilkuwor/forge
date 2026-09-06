import http, { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { exec } from 'node:child_process';

import { ForgeAdapter } from './forge-adapter.js';
import { WebSocketHandler } from './websocket/handler.js';
import { handleApiRoute } from './routes/api.js';
import { SessionManager } from './session-manager.js';

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
  sessionManager?: SessionManager;
  wsHandler: WebSocketHandler;
  isShared?: boolean;
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
    path.resolve(__dirname, '../../../web/dist'),
    path.resolve(path.dirname(process.execPath), '../web'),
    path.resolve(path.dirname(process.execPath), '../web/dist'),
    path.join(os.homedir(), '.forge', 'web'),
    path.join(os.homedir(), '.forge', 'web', 'dist')
  ];

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.existsSync(path.join(c, 'index.html'))) {
      return c;
    }
  }
  return '';
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

function checkServerRunning(host: string, port: number): Promise<{ isForge: boolean; data?: any }> {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/api/health`, { timeout: 800 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json && (json.service === 'forge-ui' || json.status === 'ok')) {
            resolve({ isForge: true, data: json });
            return;
          }
        } catch {
          // ignore
        }
        resolve({ isForge: false });
      });
    });
    req.on('error', () => resolve({ isForge: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ isForge: false });
    });
  });
}

export async function createServer(options?: ServerOptions): Promise<{
  server: HttpServer;
  adapter: ForgeAdapter;
  sessionManager: SessionManager;
  wsHandler: WebSocketHandler;
}> {
  const projectRoot = options?.projectRoot || process.cwd();
  const sessionManager = new SessionManager(projectRoot, { autoApprove: options?.autoApprove });
  const adapter = sessionManager.getDefaultAdapter();

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    // 1. API routes
    if (parsedUrl.pathname.startsWith('/api/')) {
      const handled = await handleApiRoute(req, res, parsedUrl, adapter, sessionManager);
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

  const wsHandler = new WebSocketHandler(server, adapter, sessionManager);

  return { server, adapter, sessionManager, wsHandler };
}

export async function startServer(options?: ServerOptions): Promise<RunningServer> {
  const host = options?.host || '127.0.0.1';
  let port = options?.port || 4317;

  // Check if server is already running on the target port (only for localhost/127.0.0.1)
  if (host === '127.0.0.1' || host === 'localhost') {
    const check = await checkServerRunning(host, port);
    if (check.isForge) {
      const url = `http://${host}:${port}`;
      console.log(`\nForge UI running at:\n${url} (connected to shared UI server)\n`);

      if (options?.openBrowser !== false) {
        openBrowserWindow(url);
      }

      const projectRoot = options?.projectRoot || process.cwd();
      const sessionManager = new SessionManager(projectRoot, { autoApprove: options?.autoApprove });
      const adapter = sessionManager.getDefaultAdapter();

      return {
        server: null as any,
        port,
        host,
        url,
        adapter,
        sessionManager,
        wsHandler: null as any,
        isShared: true,
        close: async () => {
          sessionManager.destroy();
        }
      };
    }
  }

  const { server, adapter, sessionManager, wsHandler } = await createServer(options);

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
          sessionManager,
          wsHandler,
          isShared: false,
          close: () =>
            new Promise((res) => {
              sessionManager.destroy();
              if (wsHandler) wsHandler.close();
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

export function getEmbeddedDashboardHtml(): string {
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
      min-width: 240px;
      background: #090d13;
      border-right: 1px solid var(--border);
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
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
    .brand-badge {
      font-size: 0.7rem;
      background: #21262d;
      color: var(--text-muted);
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: normal;
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
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      color: var(--text);
      text-decoration: none;
      border-radius: 6px;
      font-size: 0.9rem;
      cursor: pointer;
      margin-bottom: 2px;
      transition: background 0.15s, color 0.15s;
    }
    .nav-item:hover {
      background: #21262d;
      color: #fff;
    }
    .nav-item.active {
      background: #21262d;
      color: var(--cyan);
      font-weight: 600;
      border-left: 3px solid var(--cyan);
    }
    .ws-indicator {
      font-size: 0.75rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 4px;
      border-top: 1px solid var(--border);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-muted);
    }
    .dot.connected { background: var(--green); }
    .dot.reconnecting { background: var(--yellow); }

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
    .status-badge.awaiting, .status-badge.awaiting_approval { background: rgba(248, 81, 73, 0.2); color: var(--red); }
    .status-badge.error { background: rgba(248, 81, 73, 0.25); color: var(--red); }
    .status-badge.completed { background: rgba(63, 185, 80, 0.2); color: var(--green); }

    .tab-pane {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
    }
    .card h3 { font-size: 1rem; margin-bottom: 12px; color: #fff; display: flex; justify-content: space-between; align-items: center; }
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
    .metric-label { font-size: 0.75rem; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center; }
    .metric-value { font-size: 1.25rem; font-weight: bold; color: #fff; margin-top: 4px; }
    .controls-row { display: flex; gap: 10px; margin-top: 12px; align-items: center; }
    
    button {
      padding: 8px 16px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #21262d;
      color: #fff;
      cursor: pointer;
      font-weight: 500;
      font-size: 0.85rem;
      transition: background 0.15s, border-color 0.15s;
    }
    button:hover { background: #30363d; }
    button.primary { background: #238636; border-color: #2ea043; }
    button.primary:hover { background: #2ea043; }
    button.danger { background: #da3633; border-color: #f85149; }
    button.danger:hover { background: #b62324; }
    button.small { padding: 4px 10px; font-size: 0.75rem; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    input[type="text"], input[type="password"], input[type="number"], select, textarea {
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: #fff;
      padding: 8px 12px;
      font-size: 0.875rem;
      font-family: inherit;
      outline: none;
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--cyan);
    }

    /* Progress bar */
    .progress-bar-bg {
      background: #21262d;
      border-radius: 6px;
      height: 10px;
      overflow: hidden;
      width: 100%;
      margin: 8px 0;
    }
    .progress-bar-fill {
      height: 100%;
      background: var(--green);
      transition: width 0.3s ease, background 0.3s ease;
      border-radius: 6px;
    }
    .progress-bar-fill.warning { background: var(--yellow); }
    .progress-bar-fill.danger { background: var(--red); }

    /* Alert Banner */
    .alert-banner {
      border-radius: 8px;
      padding: 16px;
      border: 1px solid transparent;
    }
    .alert-banner.warning {
      background: rgba(210, 153, 34, 0.15);
      border-color: var(--yellow);
    }
    .alert-banner.danger {
      background: rgba(248, 81, 73, 0.15);
      border-color: var(--red);
    }
    .alert-banner.success {
      background: rgba(63, 185, 80, 0.15);
      border-color: var(--green);
    }

    pre {
      background: #090d13;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.85rem;
      max-height: 350px;
      line-height: 1.4;
    }

    /* Tables */
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      text-align: left;
    }
    table.data-table th {
      padding: 10px 12px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      font-weight: 600;
    }
    table.data-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #21262d;
    }
    table.data-table tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }

    /* Diff View */
    .diff-line-add { background: rgba(63, 185, 80, 0.15); color: #7ee787; display: block; }
    .diff-line-del { background: rgba(248, 81, 73, 0.15); color: #ffa198; display: block; }
    .diff-line-chunk { color: var(--cyan); background: rgba(88, 166, 255, 0.1); display: block; }

    .activity-list { list-style: none; max-height: 350px; overflow-y: auto; }
    .activity-item {
      padding: 8px 0;
      border-bottom: 1px solid #21262d;
      display: flex;
      gap: 10px;
      font-size: 0.875rem;
      align-items: flex-start;
    }
    .activity-item:last-child { border-bottom: none; }
    .activity-time { color: var(--text-muted); font-size: 0.75rem; min-width: 65px; }

    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-green { background: rgba(63, 185, 80, 0.2); color: var(--green); }
    .badge-gray { background: #21262d; color: var(--text-muted); }
    .badge-red { background: rgba(248, 81, 73, 0.2); color: var(--red); }
    .badge-cyan { background: rgba(88, 166, 255, 0.2); color: var(--cyan); }
  </style>
</head>
<body>
  <!-- Sidebar Navigation -->
  <div id="sidebar">
    <div>
      <div class="logo">
        <span>FORGE</span>
        <span style="color: var(--yellow)">⚡</span>
        <span class="brand-badge">v0.1.0</span>
      </div>
      <div class="nav-group">
        <div class="nav-label">Work</div>
        <div class="nav-item active" data-tab="dashboard" onclick="showTab('dashboard')">
          <span>📊</span><span>Dashboard</span>
        </div>
        <div class="nav-item" data-tab="sessions" onclick="showTab('sessions')">
          <span>🕒</span><span>Sessions</span>
        </div>
        <div class="nav-item" data-tab="activity" onclick="showTab('activity')">
          <span>📜</span><span>Activity</span>
        </div>
        <div class="nav-item" data-tab="diff" onclick="showTab('diff')">
          <span>📝</span><span>Files & Diff</span>
        </div>
      </div>
      <div class="nav-group">
        <div class="nav-label">Configuration</div>
        <div class="nav-item" data-tab="models" onclick="showTab('models')">
          <span>🤖</span><span>Models</span>
        </div>
        <div class="nav-item" data-tab="providers" onclick="showTab('providers')">
          <span>🔑</span><span>Providers</span>
        </div>
        <div class="nav-item" data-tab="settings" onclick="showTab('settings')">
          <span>⚙️</span><span>Settings</span>
        </div>
        <div class="nav-item" data-tab="permissions" onclick="showTab('permissions')">
          <span>🛡️</span><span>Permissions</span>
        </div>
      </div>
    </div>
    <div class="ws-indicator">
      <div class="dot connected" id="ws-dot"></div>
      <span id="ws-text">Connected</span>
    </div>
  </div>

  <!-- Main Content Area -->
  <div id="content">
    <!-- Top Header Bar -->
    <div class="header-bar">
      <div style="display: flex; align-items: center; gap: 20px;">
        <div>
          <h2 id="project-path" style="font-size: 1.1rem; color: #fff;">~/workspace</h2>
          <div style="font-size: 0.85rem; color: var(--text-muted);">
            Model: <span id="current-model" style="color: var(--green);">default</span> | Provider: <span id="current-provider">openrouter</span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; background: #161b22; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border);">
          <label for="session-select" style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); font-weight: 600;">Session:</label>
          <select id="session-select" onchange="onSessionSwitch(this.value)" style="font-size: 0.8rem; padding: 3px 6px; max-width: 260px;">
            <option value="">Default Session</option>
          </select>
        </div>
      </div>
      <div id="agent-status" class="status-badge idle">● IDLE</div>
    </div>

    <!-- TAB 1: DASHBOARD -->
    <div id="tab-dashboard" class="tab-pane">
      <div id="permission-container"></div>

      <!-- Missing API Key Alert Banner -->
      <div id="api-key-banner" class="alert-banner warning" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 1.2rem;">⚠️</span>
            <strong style="color: var(--yellow); font-size: 1rem;">API Key Required</strong>
          </div>
          <button class="small" onclick="showTab('providers')">Manage All Providers →</button>
        </div>
        <p id="api-key-banner-text" style="font-size: 0.85rem; color: var(--text); margin-bottom: 12px;">
          An API key is required to run tasks. Paste your key below to connect immediately:
        </p>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
          <select id="quick-provider" style="padding: 6px 10px;">
            <option value="openrouter">OpenRouter API</option>
            <option value="nvidia">NVIDIA NIM API</option>
          </select>
          <input id="quick-key-input" type="password" placeholder="Paste sk-or-v1-... or nvapi-... key" style="flex: 1; min-width: 260px; padding: 6px 12px;" />
          <button class="primary" onclick="quickSaveApiKey()">Save & Connect</button>
        </div>
        <div id="quick-key-feedback" style="margin-top: 8px; font-size: 0.8rem; font-weight: 500;"></div>
      </div>

      <!-- Active Task & Terminal Monitor Card -->
      <div class="card">
        <h3>
          <span>Active Task & Terminal Status</span>
          <span id="session-terminal-badge" class="badge badge-cyan">CLI Monitored</span>
        </h3>
        <div style="padding: 10px 0; font-size: 0.95rem; color: #fff;" id="active-task-display">
          <em>No active task running in selected terminal session.</em>
        </div>
        <div class="controls-row">
          <label style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--text-muted); cursor: pointer; margin-right: 12px;">
            <input type="checkbox" id="auto-approve-checkbox" />
            <span>Auto-approve file changes & bash commands (-y)</span>
          </label>
          <div style="flex: 1;"></div>
          <button onclick="pauseAgent()">Pause</button>
          <button onclick="resumeAgent()">Resume</button>
          <button class="danger" onclick="stopAgent()">Stop</button>
        </div>
      </div>

      <!-- Context & Token Usage Panel -->
      <div class="card">
        <h3>
          <span>Context & Token Usage</span>
          <span id="token-type-badge" class="badge badge-gray">ESTIMATED</span>
        </h3>
        <div>
          <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 4px;">
            <span id="context-bar-label">Context: 0%</span>
            <span id="context-bar-stats" style="color: var(--text-muted);">0 / 128K tokens</span>
          </div>
          <div class="progress-bar-bg">
            <div id="context-bar-fill" class="progress-bar-fill" style="width: 0%;"></div>
          </div>
        </div>
        <div class="metrics-grid" style="margin-top: 14px;">
          <div class="metric-box">
            <div class="metric-label">Input Tokens</div>
            <div class="metric-value" id="metric-tokens-in">0</div>
          </div>
          <div class="metric-box">
            <div class="metric-label">Output Tokens</div>
            <div class="metric-value" id="metric-tokens-out">0</div>
          </div>
          <div class="metric-box">
            <div class="metric-label">Total Tokens</div>
            <div class="metric-value" id="metric-tokens-total">0</div>
          </div>
          <div class="metric-box">
            <div class="metric-label">Remaining Context</div>
            <div class="metric-value" id="metric-tokens-remaining">128K</div>
          </div>
        </div>
        <div id="compaction-stats-row" style="margin-top: 12px; font-size: 0.8rem; color: var(--text-muted); display: none;">
          ⚡ <span id="compaction-stats-text">No compaction events yet</span>
        </div>
      </div>

      <!-- Metrics Grid -->
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

      <!-- Current Operation -->
      <div class="card" id="card-operation" style="border-left: 4px solid var(--cyan);">
        <div style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); font-weight: 600; margin-bottom: 4px;">CURRENT OPERATION</div>
        <div id="current-operation" style="color: var(--cyan); font-family: ui-monospace, monospace; font-size: 0.95rem;">Idle</div>
      </div>

      <!-- 2-Column Split: Activity and Terminal -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
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
    </div>

    <!-- TAB 2: SESSIONS -->
    <div id="tab-sessions" class="tab-pane" style="display: none;">
      <div class="card">
        <h3>
          <span>Active Terminal Sessions</span>
          <button class="small" onclick="loadActiveSessions()">Refresh</button>
        </h3>
        <div id="active-sessions-container">
          <div style="color: var(--text-muted); font-size: 0.85rem;">No active terminal sessions connected.</div>
        </div>
      </div>
      <div class="card">
        <h3>
          <span>Historical Sessions</span>
          <button class="small" onclick="loadSessions()">Refresh</button>
        </h3>
        <div id="sessions-container">
          <div style="color: var(--text-muted); font-size: 0.85rem;">Loading sessions...</div>
        </div>
      </div>
    </div>

    <!-- TAB 3: ACTIVITY -->
    <div id="tab-activity" class="tab-pane" style="display: none;">
      <div class="card">
        <h3>
          <span>Activity Timeline</span>
          <div style="display: flex; gap: 6px;">
            <button class="small active" onclick="filterActivity('all', this)">All</button>
            <button class="small" onclick="filterActivity('tool', this)">Tools</button>
            <button class="small" onclick="filterActivity('edit', this)">Edits</button>
            <button class="small" onclick="filterActivity('shell', this)">Shell</button>
          </div>
        </h3>
        <ul class="activity-list" id="full-activity-container" style="max-height: 600px;">
          <li style="color: var(--text-muted); font-size: 0.85rem;">Loading activity...</li>
        </ul>
      </div>
    </div>

    <!-- TAB 4: FILES & DIFF -->
    <div id="tab-diff" class="tab-pane" style="display: none;">
      <div class="card">
        <h3>
          <span>Changed Files</span>
          <div style="display: flex; gap: 8px;">
            <button class="small danger" onclick="revertAllForgeChanges()">Revert All Forge Changes</button>
            <button class="small" onclick="loadDiff()">Refresh</button>
          </div>
        </h3>
        <div id="files-list-container" style="margin-bottom: 16px;">
          <div style="color: var(--text-muted); font-size: 0.85rem;">No files modified in working directory.</div>
        </div>
        <div style="border-top: 1px solid var(--border); padding-top: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <strong id="diff-viewing-title" style="font-size: 0.9rem;">Unified Diff</strong>
            <span id="diff-stats-badge" class="badge badge-gray">HEAD vs Working Tree</span>
          </div>
          <pre id="diff-content" style="max-height: 500px;">// Diff content will appear here...</pre>
        </div>
      </div>
    </div>

    <!-- TAB 5: MODELS -->
    <div id="tab-models" class="tab-pane" style="display: none;">
      <div class="card">
        <h3>
          <span>Model Routing Configuration</span>
          <button class="small" onclick="refreshModelsCache()">Refresh Cache</button>
        </h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px;">
          <div class="metric-box">
            <div class="metric-label">Default Model</div>
            <div class="metric-value" id="models-default-name" style="font-size: 1rem; color: var(--green);">default</div>
          </div>
          <div class="metric-box">
            <div class="metric-label">Default Provider</div>
            <div class="metric-value" id="models-default-provider" style="font-size: 1rem; color: var(--cyan);">openrouter</div>
          </div>
        </div>
        <h4 style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase;">Fallback Chain</h4>
        <ul id="models-fallback-list" style="list-style: none; margin-bottom: 24px;">
          <li style="color: var(--text-muted); font-size: 0.85rem;">Loading fallbacks...</li>
        </ul>
        <h4 style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase;">Available Models</h4>
        <div id="models-table-container">
          <div style="color: var(--text-muted); font-size: 0.85rem;">Loading models...</div>
        </div>
      </div>
    </div>

    <!-- TAB 6: PROVIDERS -->
    <div id="tab-providers" class="tab-pane" style="display: none;">
      <div class="card">
        <h3>AI Providers & Credentials</h3>
        <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 20px;">
          Manage API keys for OpenRouter and NVIDIA NIM. Keys are saved securely to <code style="background:#090d13; padding:2px 6px; border-radius:4px;">~/.forge/auth.json</code> and never exposed in plain text.
        </p>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 20px;">
          <!-- OpenRouter Card -->
          <div class="card" style="background: #0d1117; border-color: var(--border);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h4 style="font-size: 1.05rem; color: #fff;">OpenRouter API</h4>
              <span id="provider-badge-openrouter" class="badge badge-gray">○ Not Configured</span>
            </div>
            <div style="margin-bottom: 12px; font-size: 0.8rem; color: var(--text-muted);">
              Current Key: <span id="provider-key-openrouter" style="font-family: monospace; color: var(--text);">Not set</span>
            </div>
            <div style="margin-bottom: 12px;">
              <input id="key-input-openrouter" type="password" placeholder="Paste sk-or-v1-... key" style="width: 100%; margin-bottom: 8px;" />
              <div style="display: flex; gap: 8px;">
                <button class="primary small" onclick="saveProviderKey('openrouter')">Save Key</button>
                <button class="small" onclick="testProvider('openrouter')">Test Connection</button>
                <button class="small" onclick="toggleKeyVisibility('key-input-openrouter')">Show/Hide</button>
              </div>
            </div>
            <div id="provider-feedback-openrouter" style="font-size: 0.8rem; min-height: 20px;"></div>
          </div>

          <!-- NVIDIA NIM Card -->
          <div class="card" style="background: #0d1117; border-color: var(--border);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h4 style="font-size: 1.05rem; color: #fff;">NVIDIA NIM API</h4>
              <span id="provider-badge-nvidia" class="badge badge-gray">○ Not Configured</span>
            </div>
            <div style="margin-bottom: 12px; font-size: 0.8rem; color: var(--text-muted);">
              Current Key: <span id="provider-key-nvidia" style="font-family: monospace; color: var(--text);">Not set</span>
            </div>
            <div style="margin-bottom: 12px;">
              <input id="key-input-nvidia" type="password" placeholder="Paste nvapi-... key" style="width: 100%; margin-bottom: 8px;" />
              <div style="display: flex; gap: 8px;">
                <button class="primary small" onclick="saveProviderKey('nvidia')">Save Key</button>
                <button class="small" onclick="testProvider('nvidia')">Test Connection</button>
                <button class="small" onclick="toggleKeyVisibility('key-input-nvidia')">Show/Hide</button>
              </div>
            </div>
            <div id="provider-feedback-nvidia" style="font-size: 0.8rem; min-height: 20px;"></div>
          </div>
        </div>

        <div style="margin-top: 20px; padding: 12px; background: rgba(88, 166, 255, 0.08); border-radius: 6px; border: 1px solid rgba(88, 166, 255, 0.2); font-size: 0.8rem; color: var(--text-muted);">
          💡 <strong>Tip:</strong> You can also set keys via environment variables: <code style="color:var(--cyan);">export OPENROUTER_API_KEY="..."</code> or <code style="color:var(--cyan);">export NVIDIA_API_KEY="..."</code> in your shell profile.
        </div>
      </div>
    </div>

    <!-- TAB 7: SETTINGS -->
    <div id="tab-settings" class="tab-pane" style="display: none;">
      <div class="card">
        <h3>Agent Settings</h3>
        <form onsubmit="saveSettings(event)" style="display: flex; flex-direction: column; gap: 16px; max-width: 600px;">
          <div>
            <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 6px;">Maximum Steps per Task</label>
            <input type="number" id="setting-max-steps" min="1" max="100" value="30" style="width: 120px;" />
          </div>
          <div>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 0.9rem; cursor: pointer;">
              <input type="checkbox" id="setting-confirm-edit" />
              <span>Require confirmation before editing files</span>
            </label>
          </div>
          <div>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 0.9rem; cursor: pointer;">
              <input type="checkbox" id="setting-confirm-bash" />
              <span>Require confirmation before executing shell commands</span>
            </label>
          </div>
          <div>
            <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 6px;">Bash Execution Timeout (seconds)</label>
            <input type="number" id="setting-bash-timeout" min="5" max="300" value="60" style="width: 120px;" />
          </div>
          <div>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 0.9rem; cursor: pointer;">
              <input type="checkbox" id="setting-guard-root" checked />
              <span>Project Root Guard (prevent edits outside workspace)</span>
            </label>
          </div>
          <div>
            <button type="submit" class="primary">Save Settings</button>
            <span id="settings-feedback" style="margin-left: 12px; font-size: 0.85rem;"></span>
          </div>
        </form>
      </div>
    </div>

    <!-- TAB 8: PERMISSIONS -->
    <div id="tab-permissions" class="tab-pane" style="display: none;">
      <div class="card">
        <h3>Permissions & Security Guardrails</h3>
        <div id="permissions-pending-container" style="margin-bottom: 20px;">
          <div style="color: var(--text-muted); font-size: 0.85rem;">No permissions currently awaiting approval.</div>
        </div>

        <h4 style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 10px; text-transform: uppercase;">Session-Approved Files</h4>
        <div id="session-approved-container" style="margin-bottom: 20px;">
          <div style="color: var(--text-muted); font-size: 0.85rem;">No files permanently approved for this session.</div>
        </div>

        <h4 style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 10px; text-transform: uppercase;">Active Security Policies</h4>
        <div style="display: flex; flex-direction: column; gap: 8px; font-size: 0.85rem;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="badge badge-green">✓ ACTIVE</span>
            <span><strong>Project Root Boundary:</strong> Operations outside project workspace directory are blocked.</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="badge badge-green">✓ ACTIVE</span>
            <span><strong>Sensitive Files:</strong> Access to .env, credentials, and secret files is denied.</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="badge badge-green">✓ ACTIVE</span>
            <span><strong>SSH & Keys:</strong> Access to ~/.ssh, ~/.gnupg, and auth tokens is protected.</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let ws;
    let currentTab = 'dashboard';
    let cachedActivity = [];
    let lastStatus = null;

    function formatK(n) {
      if (n === null || n === undefined) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\\.0$/, '') + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'K';
      return String(n);
    }

    function showTab(tab) {
      currentTab = tab;
      window.location.hash = tab;

      // Update active nav item
      document.querySelectorAll('.nav-item').forEach(el => {
        if (el.getAttribute('data-tab') === tab) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });

      // Toggle tab pane visibility
      document.querySelectorAll('.tab-pane').forEach(el => {
        el.style.display = 'none';
      });
      const targetPane = document.getElementById('tab-' + tab);
      if (targetPane) {
        targetPane.style.display = 'flex';
      }

      // Trigger data loaders
      if (tab === 'sessions') loadSessions();
      else if (tab === 'activity') loadActivity();
      else if (tab === 'diff') loadDiff();
      else if (tab === 'models') loadModels();
      else if (tab === 'providers') loadProviders();
      else if (tab === 'settings') loadSettings();
      else if (tab === 'permissions') loadPermissions();
    }

    window.addEventListener('DOMContentLoaded', () => {
      const hash = window.location.hash.replace('#', '');
      const validTabs = ['dashboard', 'sessions', 'activity', 'diff', 'models', 'providers', 'settings', 'permissions'];
      if (validTabs.includes(hash)) {
        showTab(hash);
      } else {
        showTab('dashboard');
      }
    });

    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace('#', '');
      if (hash && hash !== currentTab) {
        showTab(hash);
      }
    });

    function connectWs() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws');

      ws.onopen = () => {
        const d = document.getElementById('ws-dot');
        const t = document.getElementById('ws-text');
        if (d) d.className = 'dot connected';
        if (t) t.innerText = 'Connected';
        loadActiveSessions();
      };

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
          } else if (msg.type === 'sessions_changed' || msg.type === 'selected_session_changed' || msg.type === 'session_updated') {
            loadActiveSessions();
            refreshStatus();
          }
        } catch (err) {}
      };

      ws.onclose = () => {
        const d = document.getElementById('ws-dot');
        const t = document.getElementById('ws-text');
        if (d) d.className = 'dot reconnecting';
        if (t) t.innerText = 'Reconnecting...';
        setTimeout(connectWs, 2000);
      };
    }

    function updateStatus(st) {
      if (!st) return;
      lastStatus = st;

      const pPath = document.getElementById('project-path');
      if (pPath) pPath.innerText = st.projectRoot || '~/';
      const cMod = document.getElementById('current-model');
      if (cMod) cMod.innerText = st.currentModel || 'default';
      const cProv = document.getElementById('current-provider');
      if (cProv) cProv.innerText = st.currentProvider || 'openrouter';

      const statusEl = document.getElementById('agent-status');
      if (statusEl) {
        statusEl.innerText = '● ' + st.status;
        statusEl.className = 'status-badge ' + (st.status ? st.status.toLowerCase() : 'idle');
      }

      const activeTaskEl = document.getElementById('active-task-display');
      if (activeTaskEl) {
        activeTaskEl.innerHTML = st.task ? ('<strong>' + escapeHtml(st.task) + '</strong>') : '<em>No active task running in selected terminal session.</em>';
      }
      const termBadge = document.getElementById('session-terminal-badge');
      if (termBadge) {
        termBadge.innerText = (st.workspaceName || 'CLI') + (st.terminalId ? ' (' + st.terminalId + ')' : '');
      }

      const mStep = document.getElementById('metric-step');
      if (mStep) mStep.innerText = st.step + ' / ' + st.maxSteps;
      const mTools = document.getElementById('metric-tools');
      if (mTools) mTools.innerText = st.toolCount;
      const mFiles = document.getElementById('metric-files');
      if (mFiles) mFiles.innerText = st.filesChangedCount;

      const seconds = Math.floor((st.elapsedTimeMs || 0) / 1000);
      const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
      const secs = String(seconds % 60).padStart(2, '0');
      const mTime = document.getElementById('metric-time');
      if (mTime) mTime.innerText = mins + ':' + secs;

      const opEl = document.getElementById('current-operation');
      if (opEl) opEl.innerText = st.currentOperation || 'Idle';
      const opCard = document.getElementById('card-operation');
      if (opCard && opEl) {
        if (st.status === 'ERROR') {
          opCard.style.borderLeftColor = 'var(--red)';
          opEl.style.color = 'var(--red)';
        } else if (st.status === 'COMPLETED') {
          opCard.style.borderLeftColor = 'var(--green)';
          opEl.style.color = 'var(--green)';
        } else {
          opCard.style.borderLeftColor = 'var(--cyan)';
          opEl.style.color = 'var(--cyan)';
        }
      }

      // Check for missing API Key banner
      const banner = document.getElementById('api-key-banner');
      const isApiKeyError = st.currentOperation && (
        st.currentOperation.toLowerCase().includes('api key not found') ||
        st.currentOperation.toLowerCase().includes('openrouter api key')
      );
      if (banner) {
        if (isApiKeyError) {
          banner.style.display = 'block';
          const bannerText = document.getElementById('api-key-banner-text');
          if (bannerText) bannerText.innerText = st.currentOperation;
        } else {
          banner.style.display = 'none';
        }
      }

      // Token Usage
      if (st.tokenUsage) {
        const tu = st.tokenUsage;
        const pct = Math.min(100, Math.max(0, tu.utilizationPercent || 0));
        const cLabel = document.getElementById('context-bar-label');
        if (cLabel) cLabel.innerText = 'Context: ' + pct + '%';
        const cStats = document.getElementById('context-bar-stats');
        if (cStats) {
          cStats.innerText = formatK(tu.currentContextTokens) + ' / ' + formatK(tu.modelLimitTokens) + ' tokens';
        }

        const fill = document.getElementById('context-bar-fill');
        if (fill) {
          fill.style.width = pct + '%';
          fill.className = 'progress-bar-fill ' + (pct > 85 ? 'danger' : pct > 65 ? 'warning' : '');
        }

        const tIn = document.getElementById('metric-tokens-in');
        if (tIn) tIn.innerText = formatK(tu.inputTokens);
        const tOut = document.getElementById('metric-tokens-out');
        if (tOut) tOut.innerText = formatK(tu.outputTokens);
        const tTot = document.getElementById('metric-tokens-total');
        if (tTot) tTot.innerText = formatK(tu.totalTokens);
        const tRem = document.getElementById('metric-tokens-remaining');
        if (tRem) tRem.innerText = formatK(tu.remainingContextTokens);

        const typeBadge = document.getElementById('token-type-badge');
        if (typeBadge) {
          typeBadge.innerText = tu.isActual ? 'ACTUAL' : 'ESTIMATED';
          typeBadge.className = 'badge ' + (tu.isActual ? 'badge-green' : 'badge-gray');
        }
      }

      // Compactions
      if (st.compactions && st.compactions.count > 0) {
        const cr = document.getElementById('compaction-stats-row');
        if (cr) {
          cr.style.display = 'block';
          const c = st.compactions;
          const cText = document.getElementById('compaction-stats-text');
          if (cText) {
            cText.innerText =
              'Compacted ' + c.count + ' time' + (c.count > 1 ? 's' : '') +
              ' — freed ' + formatK(c.totalTokensFreed) + ' tokens total' +
              (c.lastTokensBefore ? ' (last: ' + formatK(c.lastTokensBefore) + ' → ' + formatK(c.lastTokensAfter) + ')' : '');
          }
        }
      }

      // Permissions
      if (st.pendingPermission) {
        showPermission(st.pendingPermission);
      } else {
        const pCont = document.getElementById('permission-container');
        if (pCont) pCont.innerHTML = '';
      }
    }

    function showPermission(perm) {
      const el = document.getElementById('permission-container');
      if (!el) return;
      el.innerHTML = \`
        <div class="alert-banner warning" style="margin-bottom: 16px;">
          <h4 style="color: var(--yellow); margin-bottom: 6px;">Permission Required</h4>
          <p style="margin-bottom: 10px;">Forge requests permission to \${perm.type === 'file' ? 'edit/write file' : 'execute command'}: <code style="background:#090d13; padding:2px 6px; border-radius:4px; color:#fff;">\${perm.target}</code></p>
          <div style="display: flex; gap: 8px;">
            <button class="primary small" onclick="resolvePermission('\${perm.id}', 'once')">Allow Once</button>
            <button class="small" onclick="resolvePermission('\${perm.id}', 'session')">Allow for Session</button>
            <button class="danger small" onclick="denyPermission('\${perm.id}')">Deny</button>
          </div>
        </div>
      \`;
    }

    function resolvePermission(id, mode) {
      fetch('/api/permissions/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, mode })
      }).then(() => refreshStatus());
    }

    function denyPermission(id) {
      fetch('/api/permissions/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      }).then(() => refreshStatus());
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    let activeSessionsList = [];
    async function loadActiveSessions() {
      try {
        const res = await fetch('/api/sessions/active');
        activeSessionsList = await res.json();
        
        // Update session switcher dropdown
        const sel = document.getElementById('session-select');
        if (sel) {
          let optionsHtml = '';
          activeSessionsList.forEach(s => {
            const isSel = s.isSelected ? 'selected' : '';
            optionsHtml += \`<option value="\${s.id}" \${isSel}>\${escapeHtml(s.workspaceName || 'Workspace')} (\${s.terminalId || s.id.slice(0, 8)}) - \${s.status}</option>\`;
          });
          if (activeSessionsList.length === 0) {
            optionsHtml = '<option value="">Default Session</option>';
          }
          sel.innerHTML = optionsHtml;
        }

        // Update active sessions container in Sessions Tab
        const c = document.getElementById('active-sessions-container');
        if (c) {
          if (!activeSessionsList || activeSessionsList.length === 0) {
            c.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No active terminal sessions connected.</div>';
          } else {
            let html = '<table class="data-table"><thead><tr>' +
              '<th>Workspace</th><th>Session ID</th><th>Terminal / PID</th><th>Model</th><th>Status</th><th>Action</th>' +
              '</tr></thead><tbody>';
            activeSessionsList.forEach(s => {
              const statusClass = s.status === 'RUNNING' ? 'badge-cyan' : s.status === 'ERROR' ? 'badge-red' : 'badge-green';
              html += \`<tr>
                <td><strong>\${escapeHtml(s.workspaceName || 'workspace')}</strong><br><small style="color:var(--text-muted);">\${escapeHtml(s.workspacePath || '')}</small></td>
                <td><code style="background:#090d13; padding:2px 6px; border-radius:4px;">\${s.id.slice(0, 8)}</code></td>
                <td>\${escapeHtml(s.terminalId || '-')}\${s.pid ? ' (PID ' + s.pid + ')' : ''}</td>
                <td>\${escapeHtml(s.model || 'default')}</td>
                <td><span class="badge \${statusClass}">\${s.status}</span></td>
                <td>
                  \${s.isSelected
                    ? '<span class="badge badge-green">✓ Selected</span>'
                    : \`<button class="small primary" onclick="onSessionSwitch('\${s.id}')">Switch to Session</button>\`
                  }
                </td>
              </tr>\`;
            });
            html += '</tbody></table>';
            c.innerHTML = html;
          }
        }
      } catch (err) {}
    }

    async function onSessionSwitch(sessionId) {
      if (!sessionId) return;
      try {
        await fetch('/api/sessions/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
        await loadActiveSessions();
        refreshStatus();
      } catch (err) {}
    }

    function pauseAgent() { fetch('/api/agent/pause', { method: 'POST' }).then(() => refreshStatus()); }
    function resumeAgent() { fetch('/api/agent/resume', { method: 'POST' }).then(() => refreshStatus()); }
    function stopAgent() { fetch('/api/agent/stop', { method: 'POST' }).then(() => refreshStatus()); }

    function addActivity(item) {
      cachedActivity.unshift(item);
      const c = document.getElementById('activity-container');
      if (c) {
        const li = document.createElement('li');
        li.className = 'activity-item';
        li.innerHTML = \`<span class="activity-time">\${item.timestamp}</span><span>\${item.title}</span>\`;
        c.prepend(li);
      }

      if (currentTab === 'activity') {
        renderFullActivity(cachedActivity);
      }
    }

    function appendTerminal(chunk) {
      const t = document.getElementById('terminal-output');
      if (t) {
        t.innerText += chunk;
        t.scrollTop = t.scrollHeight;
      }
    }

    function refreshStatus() {
      fetch('/api/status').then(r => r.json()).then(updateStatus);
    }

    // --- Provider Actions ---
    async function loadProviders() {
      try {
        const res = await fetch('/api/providers');
        const list = await res.json();
        list.forEach(p => {
          const badge = document.getElementById('provider-badge-' + p.provider);
          const keyEl = document.getElementById('provider-key-' + p.provider);
          if (badge) {
            badge.innerText = p.configured ? '● Connected' : '○ Not Configured';
            badge.className = 'badge ' + (p.configured ? 'badge-green' : 'badge-gray');
          }
          if (keyEl) {
            keyEl.innerText = p.keyMasked || 'Not set';
          }
        });
      } catch (err) {}
    }

    async function saveProviderKey(provider) {
      const input = document.getElementById('key-input-' + provider);
      const feedback = document.getElementById('provider-feedback-' + provider);
      const key = input ? input.value.trim() : '';
      if (!key) {
        if (feedback) feedback.innerHTML = '<span style="color:var(--red);">Please enter an API key.</span>';
        return;
      }
      if (feedback) feedback.innerHTML = '<span style="color:var(--text-muted);">Saving key...</span>';
      try {
        const res = await fetch('/api/providers/' + provider + '/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key })
        });
        const data = await res.json();
        if (data.success) {
          if (feedback) feedback.innerHTML = '<span style="color:var(--green);">✓ API key saved successfully!</span>';
          if (input) input.value = '';
          await loadProviders();
          refreshStatus();
          setTimeout(() => { if (feedback) feedback.innerHTML = ''; }, 4000);
        } else {
          if (feedback) feedback.innerHTML = '<span style="color:var(--red);">Failed: ' + (data.error || 'Unknown error') + '</span>';
        }
      } catch (err) {
        if (feedback) feedback.innerHTML = '<span style="color:var(--red);">Error: ' + err.message + '</span>';
      }
    }

    async function quickSaveApiKey() {
      const pSel = document.getElementById('quick-provider');
      const provider = pSel ? pSel.value : 'openrouter';
      const kIn = document.getElementById('quick-key-input');
      const key = kIn ? kIn.value.trim() : '';
      const feedback = document.getElementById('quick-key-feedback');
      if (!key) {
        if (feedback) feedback.innerHTML = '<span style="color:var(--red);">Please enter an API key.</span>';
        return;
      }
      if (feedback) feedback.innerHTML = '<span style="color:var(--text-muted);">Connecting...</span>';
      try {
        const res = await fetch('/api/providers/' + provider + '/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key })
        });
        const data = await res.json();
        if (data.success) {
          if (feedback) feedback.innerHTML = '<span style="color:var(--green);">✓ Key saved! Agent is ready.</span>';
          if (kIn) kIn.value = '';
          await loadProviders();
          refreshStatus();
          setTimeout(() => {
            if (feedback) feedback.innerHTML = '';
            const b = document.getElementById('api-key-banner');
            if (b) b.style.display = 'none';
          }, 3000);
        } else {
          if (feedback) feedback.innerHTML = '<span style="color:var(--red);">' + (data.error || 'Failed to save') + '</span>';
        }
      } catch (err) {
        if (feedback) feedback.innerHTML = '<span style="color:var(--red);">' + err.message + '</span>';
      }
    }

    async function testProvider(provider) {
      const feedback = document.getElementById('provider-feedback-' + provider);
      if (feedback) feedback.innerHTML = '<span style="color:var(--text-muted);">Testing connection...</span>';
      try {
        const res = await fetch('/api/providers/' + provider + '/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider })
        });
        const data = await res.json();
        if (data.ok) {
          if (feedback) feedback.innerHTML = '<span style="color:var(--green);">✓ ' + data.message + '</span>';
        } else {
          if (feedback) feedback.innerHTML = '<span style="color:var(--red);">✗ ' + (data.message || 'Connection test failed') + '</span>';
        }
      } catch (err) {
        if (feedback) feedback.innerHTML = '<span style="color:var(--red);">✗ Connection error: ' + err.message + '</span>';
      }
    }

    function toggleKeyVisibility(id) {
      const input = document.getElementById(id);
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    }

    // --- Sessions Tab ---
    async function loadSessions() {
      const c = document.getElementById('sessions-container');
      if (!c) return;
      try {
        const res = await fetch('/api/sessions');
        const list = await res.json();
        if (!list || list.length === 0) {
          c.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No session history found.</div>';
          return;
        }
        let html = '<table class="data-table"><thead><tr>' +
          '<th>Session ID</th><th>Date</th><th>Task</th><th>Status</th><th>Tokens</th><th>Compactions</th>' +
          '</tr></thead><tbody>';
        list.forEach(s => {
          const date = new Date(s.createdAt).toLocaleString();
          const statusClass = s.status === 'COMPLETED' ? 'badge-green' : s.status === 'ERROR' ? 'badge-red' : 'badge-cyan';
          html += \`<tr>
            <td><code style="background:#090d13; padding:2px 6px; border-radius:4px;">\${s.id.slice(0, 8)}</code></td>
            <td style="color:var(--text-muted);">\${date}</td>
            <td style="font-weight:500;">\${s.task || 'Interactive session'}</td>
            <td><span class="badge \${statusClass}">\${s.status}</span></td>
            <td>\${s.tokenUsage ? formatK(s.tokenUsage.totalTokens) : '-'}</td>
            <td>\${s.compactions?.count || 0}</td>
          </tr>\`;
        });
        html += '</tbody></table>';
        c.innerHTML = html;
      } catch (err) {
        c.innerHTML = '<div style="color:var(--red);">Error loading sessions: ' + err.message + '</div>';
      }
    }

    // --- Activity Tab ---
    async function loadActivity() {
      try {
        const res = await fetch('/api/activity');
        const list = await res.json();
        cachedActivity = list || [];
        renderFullActivity(cachedActivity);
      } catch (err) {}
    }

    function renderFullActivity(items) {
      const c = document.getElementById('full-activity-container');
      if (!c) return;
      if (!items || items.length === 0) {
        c.innerHTML = '<li style="color: var(--text-muted); font-size: 0.85rem;">No activity items logged.</li>';
        return;
      }
      c.innerHTML = items.map(item => {
        const typeClass = item.type === 'error' ? 'badge-red' : item.type === 'edit' ? 'badge-cyan' : 'badge-gray';
        return \`<li class="activity-item">
          <span class="activity-time">\${item.timestamp}</span>
          <span class="badge \${typeClass}" style="text-transform:uppercase; font-size:0.7rem;">\${item.type}</span>
          <span style="flex:1;">\${item.title}</span>
        </li>\`;
      }).join('');
    }

    function filterActivity(type, btn) {
      document.querySelectorAll('#tab-activity button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (type === 'all') {
        renderFullActivity(cachedActivity);
      } else {
        renderFullActivity(cachedActivity.filter(a => a.type === type));
      }
    }

    // --- Files & Diff Tab ---
    async function loadDiff(specificFile) {
      try {
        const filesRes = await fetch('/api/files');
        const files = await filesRes.json();
        const fc = document.getElementById('files-list-container');
        if (fc) {
          if (!files || files.length === 0) {
            fc.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">Clean working tree. No files modified.</div>';
          } else {
            fc.innerHTML = '<div style="display: flex; flex-direction: column; gap: 6px;">' +
              files.map(f => \`
                <div style="display: flex; justify-content: space-between; align-items: center; background:#0d1117; padding:8px 12px; border-radius:6px; border:1px solid var(--border);">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="badge \${f.status === 'M' ? 'badge-cyan' : f.status === 'D' ? 'badge-red' : 'badge-green'}">\${f.status}</span>
                    <span style="font-family:monospace; font-size:0.85rem; cursor:pointer;" onclick="loadDiff('\${f.path}')">\${f.path}</span>
                  </div>
                  <button class="small" onclick="revertSingleFile('\${f.path}')">Revert</button>
                </div>
              \`).join('') + '</div>';
          }
        }

        const diffUrl = specificFile ? '/api/diff?file=' + encodeURIComponent(specificFile) : '/api/diff';
        const diffRes = await fetch(diffUrl);
        const diffData = await diffRes.json();
        const dTitle = document.getElementById('diff-viewing-title');
        if (dTitle) dTitle.innerText = specificFile ? 'Diff: ' + specificFile : 'All Workspace Changes';

        const diffEl = document.getElementById('diff-content');
        if (diffEl) {
          if (!diffData.diff || !diffData.diff.trim()) {
            diffEl.innerText = '// No diffs available.';
          } else {
            const lines = diffData.diff.split('\\n');
            diffEl.innerHTML = lines.map(l => {
              if (l.startsWith('+')) return '<span class="diff-line-add">' + escapeHtml(l) + '</span>';
              if (l.startsWith('-')) return '<span class="diff-line-del">' + escapeHtml(l) + '</span>';
              if (l.startsWith('@@')) return '<span class="diff-line-chunk">' + escapeHtml(l) + '</span>';
              return '<span>' + escapeHtml(l) + '</span>';
            }).join('');
          }
        }
      } catch (err) {}
    }

    async function revertSingleFile(file) {
      if (!confirm('Revert changes to ' + file + '?')) return;
      await fetch('/api/files/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file })
      });
      loadDiff();
      refreshStatus();
    }

    async function revertAllForgeChanges() {
      if (!confirm('Revert ALL changes made during this session?')) return;
      await fetch('/api/files/revert-all', { method: 'POST' });
      loadDiff();
      refreshStatus();
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // --- Models Tab ---
    async function loadModels() {
      try {
        const res = await fetch('/api/models');
        const data = await res.json();
        const dName = document.getElementById('models-default-name');
        if (dName) dName.innerText = data.defaultModel || 'default';
        const dProv = document.getElementById('models-default-provider');
        if (dProv) dProv.innerText = data.defaultProvider || 'openrouter';

        const fl = document.getElementById('models-fallback-list');
        if (fl) {
          if (data.fallbackModels && data.fallbackModels.length > 0) {
            fl.innerHTML = data.fallbackModels.map((m, idx) =>
              \`<li style="padding: 4px 0; font-family: monospace; font-size: 0.85rem;">\${idx + 1}. \${m}</li>\`
            ).join('');
          } else {
            fl.innerHTML = '<li style="color:var(--text-muted); font-size:0.85rem;">No fallback models configured.</li>';
          }
        }

        const tc = document.getElementById('models-table-container');
        if (tc) {
          const models = (data.openrouter || []).concat(data.nvidia || []);
          if (models.length === 0) {
            tc.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">No models in cache. Click Refresh Cache above.</div>';
            return;
          }

          let html = '<table class="data-table"><thead><tr>' +
            '<th>Model ID</th><th>Provider</th><th>Context</th><th>Action</th>' +
            '</tr></thead><tbody>';
          models.slice(0, 30).forEach(m => {
            const isCurrent = m.id === data.defaultModel;
            html += \`<tr>
              <td style="font-family:monospace; font-weight:\${isCurrent ? 'bold' : 'normal'}; color:\${isCurrent ? 'var(--cyan)' : 'var(--text)'};">\${m.name || m.id}</td>
              <td><span class="badge badge-gray">\${m.provider || 'openrouter'}</span></td>
              <td>\${m.contextLength ? formatK(m.contextLength) : '-'}</td>
              <td>
                <button class="small \${isCurrent ? '' : 'primary'}" \${isCurrent ? 'disabled' : ''} onclick="selectDefaultModel('\${m.id}', '\${m.provider}')">
                  \${isCurrent ? 'Active' : 'Select'}
                </button>
              </td>
            </tr>\`;
          });
          html += '</tbody></table>';
          tc.innerHTML = html;
        }
      } catch (err) {}
    }

    async function selectDefaultModel(model, provider) {
      await fetch('/api/models/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, provider })
      });
      loadModels();
      refreshStatus();
    }

    async function refreshModelsCache() {
      await fetch('/api/models/refresh', { method: 'POST' });
      loadModels();
    }

    // --- Settings Tab ---
    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        const s = await res.json();
        const mSteps = document.getElementById('setting-max-steps');
        if (mSteps) mSteps.value = s.maxSteps || 30;
        const cEdit = document.getElementById('setting-confirm-edit');
        if (cEdit) cEdit.checked = s.confirm?.edit !== false;
        const cBash = document.getElementById('setting-confirm-bash');
        if (cBash) cBash.checked = s.confirm?.bash !== false;
        const bTimeout = document.getElementById('setting-bash-timeout');
        if (bTimeout) bTimeout.value = s.bashTimeout || 60;
        const gRoot = document.getElementById('setting-guard-root');
        if (gRoot) gRoot.checked = s.security?.projectRootGuard !== false;
      } catch (err) {}
    }

    async function saveSettings(e) {
      e.preventDefault();
      const feedback = document.getElementById('settings-feedback');
      if (feedback) feedback.innerText = 'Saving...';
      try {
        const body = {
          maxSteps: parseInt(document.getElementById('setting-max-steps').value, 10),
          confirm: {
            edit: document.getElementById('setting-confirm-edit').checked,
            bash: document.getElementById('setting-confirm-bash').checked
          },
          bashTimeout: parseInt(document.getElementById('setting-bash-timeout').value, 10),
          security: {
            projectRootGuard: document.getElementById('setting-guard-root').checked
          }
        };
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (feedback) {
          feedback.innerHTML = '<span style="color:var(--green);">✓ Settings saved!</span>';
          setTimeout(() => { feedback.innerText = ''; }, 3000);
        }
      } catch (err) {
        if (feedback) feedback.innerHTML = '<span style="color:var(--red);">Error: ' + err.message + '</span>';
      }
    }

    // --- Permissions Tab ---
    async function loadPermissions() {
      try {
        const res = await fetch('/api/permissions');
        const p = await res.json();

        // Pending permissions
        const pc = document.getElementById('permissions-pending-container');
        if (pc) {
          if (lastStatus && lastStatus.pendingPermission) {
            const perm = lastStatus.pendingPermission;
            pc.innerHTML = \`
              <div class="alert-banner warning">
                <h4 style="color:var(--yellow); margin-bottom:6px;">Approval Requested</h4>
                <p style="margin-bottom:10px;">Forge wants to \${perm.type === 'file' ? 'edit file' : 'run shell command'}: <code style="background:#090d13; padding:2px 6px; border-radius:4px; color:#fff;">\${perm.target}</code></p>
                <div style="display:flex; gap:8px;">
                  <button class="primary small" onclick="resolvePermission('\${perm.id}', 'once')">Allow Once</button>
                  <button class="small" onclick="resolvePermission('\${perm.id}', 'session')">Allow for Session</button>
                  <button class="danger small" onclick="denyPermission('\${perm.id}')">Deny</button>
                </div>
              </div>
            \`;
          } else {
            pc.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">No permissions currently awaiting approval.</div>';
          }
        }

        // Session approved
        const sc = document.getElementById('session-approved-container');
        if (sc) {
          if (p.sessionApprovedFiles && p.sessionApprovedFiles.length > 0) {
            sc.innerHTML = '<div style="display:flex; flex-direction:column; gap:6px;">' +
              p.sessionApprovedFiles.map(file => \`
                <div style="display:flex; justify-content:space-between; align-items:center; background:#0d1117; padding:6px 12px; border-radius:6px; border:1px solid var(--border);">
                  <code style="font-size:0.85rem;">\${file}</code>
                  <button class="small danger" onclick="revokePermission('\${file}')">Revoke</button>
                </div>
              \`).join('') + '</div>';
          } else {
            sc.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">No files approved for this session.</div>';
          }
        }
      } catch (err) {}
    }

    async function revokePermission(file) {
      await fetch('/api/permissions/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file })
      });
      loadPermissions();
    }

    connectWs();
    refreshStatus();
  </script>
</body>
</html>`;
}
