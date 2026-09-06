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
  private retryTimer: NodeJS.Timeout | null = null;
  private currentStatus: string = 'IDLE';
  private currentTask: string = '';
  private currentOperation: string = 'Ready';
  private pendingUpdate: Record<string, any> = {};

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
    const success = await this.tryConnect();
    if (!success) {
      this.startReconnectLoop();
    }
    return success;
  }

  private async tryConnect(): Promise<boolean> {
    try {
      const isAlive = await this.probe();
      if (!isAlive) {
        this.isConnected = false;
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
        status: this.currentStatus
      });

      this.isConnected = true;
      if (this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
      }

      this.startHeartbeat();

      // Flush any pending updates
      if (Object.keys(this.pendingUpdate).length > 0) {
        const update = { ...this.pendingUpdate };
        this.pendingUpdate = {};
        this.post(`/api/sessions/${encodeURIComponent(this.sessionId)}/update`, update).catch(() => {});
      }

      // Register cleanup handlers
      process.once('exit', () => this.syncUnregister());
      return true;
    } catch {
      this.isConnected = false;
      return false;
    }
  }

  private startReconnectLoop(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(async () => {
      if (this.isConnected) {
        if (this.retryTimer) {
          clearInterval(this.retryTimer);
          this.retryTimer = null;
        }
        return;
      }
      await this.tryConnect();
    }, 2000);
    if (this.retryTimer.unref) {
      this.retryTimer.unref();
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
            timeout: 600
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                resolve(Boolean(json && (json.status === 'ok' || json.service === 'forge-ui')));
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
    if (data.status) this.currentStatus = data.status;
    if (data.currentTask) this.currentTask = data.currentTask;
    if (data.currentOperation) this.currentOperation = data.currentOperation;
    if (data.model) this.model = data.model;
    if (data.provider) this.provider = data.provider;

    if (!this.isConnected) {
      Object.assign(this.pendingUpdate, data);
      return;
    }

    this.post(`/api/sessions/${encodeURIComponent(this.sessionId)}/update`, data).catch(() => {
      // If update fails, server might have dropped
      this.isConnected = false;
      this.startReconnectLoop();
    });
  }

  public sendActivity(title: string, type: string = 'info', detail?: string): void {
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
    this.heartbeatTimer = setInterval(async () => {
      if (!this.isConnected) return;
      try {
        await this.post(`/api/sessions/${encodeURIComponent(this.sessionId)}/heartbeat`, {});
      } catch {
        this.isConnected = false;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.startReconnectLoop();
      }
    }, 4000);
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  public async unregister(): Promise<void> {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.isConnected) return;
    this.isConnected = false;
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
            timeout: 1500
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                return;
              }
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
