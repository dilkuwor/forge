import http from 'node:http';
import path from 'node:path';

export interface UIClientOptions {
  baseUrl?: string;
  sessionId: string;
  workspace?: string;
  model?: string;
  provider?: string;
  terminalId?: string;
}

export class UIClient {
  public baseUrl: string;
  public sessionId: string;
  public terminalId: string;
  public pid: number;
  public workspace: string;
  public workspaceName: string;
  public model: string;
  public provider: string;
  public isConnected: boolean = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: UIClientOptions) {
    this.baseUrl = options.baseUrl || 'http://127.0.0.1:4317';
    this.sessionId = options.sessionId;
    this.pid = process.pid;
    this.terminalId = options.terminalId || `term-${this.pid}`;
    this.workspace = options.workspace || process.cwd();
    this.workspaceName = path.basename(this.workspace);
    this.model = options.model || 'default';
    this.provider = options.provider || 'openrouter';
  }

  public async connect(): Promise<boolean> {
    try {
      const isAlive = await this.probe();
      if (!isAlive) {
        return false;
      }

      // Register session
      await this.post('/api/sessions/register', {
        sessionId: this.sessionId,
        terminalId: this.terminalId,
        pid: this.pid,
        workspace: this.workspace,
        workspaceName: this.workspaceName,
        model: this.model,
        provider: this.provider,
        status: 'IDLE'
      });

      this.isConnected = true;
      this.startHeartbeat();

      // Register cleanup handlers
      process.once('exit', () => this.syncUnregister());
      return true;
    } catch {
      this.isConnected = false;
      return false;
    }
  }

  public async probe(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const u = new URL(this.baseUrl);
        const req = http.get(
          {
            hostname: u.hostname,
            port: u.port || 80,
            path: '/api/health',
            timeout: 500
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                resolve(json && json.status === 'ok');
              } catch {
                resolve(false);
              }
            });
          }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      } catch {
        resolve(false);
      }
    });
  }

  public update(data: any): void {
    if (!this.isConnected) return;
    this.post(`/api/sessions/${encodeURIComponent(this.sessionId)}/update`, data).catch(() => {});
  }

  public sendActivity(title: string, type: string = 'info', detail?: string): void {
    if (!this.isConnected) return;
    this.update({
      activityItem: {
        id: String(Date.now()),
        timestamp: new Date().toLocaleTimeString(),
        type,
        status: 'done',
        title,
        detail
      }
    });
  }

  public sendTerminalChunk(chunk: string): void {
    if (!this.isConnected) return;
    this.update({ terminalChunk: chunk });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) return;
      this.post(`/api/sessions/${encodeURIComponent(this.sessionId)}/heartbeat`, {}).catch(() => {});
    }, 5000);
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  public async unregister(): Promise<void> {
    if (!this.isConnected) return;
    this.isConnected = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.post(`/api/sessions/${encodeURIComponent(this.sessionId)}/unregister`, {}).catch(() => {});
  }

  private syncUnregister(): void {
    try {
      this.post(`/api/sessions/${encodeURIComponent(this.sessionId)}/unregister`, {}).catch(() => {});
    } catch {}
  }

  private post(path: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const u = new URL(this.baseUrl);
        const postData = JSON.stringify(body);
        const req = http.request(
          {
            hostname: u.hostname,
            port: u.port || 80,
            path,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 1000
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve({ raw: data });
              }
            });
          }
        );
        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
        req.write(postData);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}
