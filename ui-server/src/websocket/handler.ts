import { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { ForgeAdapter } from '../forge-adapter.js';

export class WebSocketHandler {
  private wss: WebSocketServer;
  private adapter: ForgeAdapter;

  constructor(server: HttpServer, adapter: ForgeAdapter) {
    this.adapter = adapter;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.setupAdapterListeners();
    this.setupServer();
  }

  private setupServer() {
    this.wss.on('connection', (ws: WebSocket) => {
      // Send initial state immediately upon connection
      ws.send(
        JSON.stringify({
          type: 'init',
          status: this.adapter.getStatus(),
          session: this.adapter.getCurrentSessionDetail()
        })
      );

      ws.on('message', async (raw: Buffer | string) => {
        try {
          const message = JSON.parse(raw.toString());
          await this.handleClientMessage(ws, message);
        } catch (err: any) {
          ws.send(
            JSON.stringify({
              type: 'error',
              error: `Invalid message format: ${err.message}`
            })
          );
        }
      });
    });
  }

  private async handleClientMessage(ws: WebSocket, msg: any) {
    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'approve_permission': {
        const approved = this.adapter.approvePermission(msg.id, msg.mode || 'once');
        ws.send(JSON.stringify({ type: 'permission_result', id: msg.id, success: approved }));
        break;
      }

      case 'deny_permission': {
        const denied = this.adapter.denyPermission(msg.id);
        ws.send(JSON.stringify({ type: 'permission_result', id: msg.id, success: denied }));
        break;
      }

      case 'pause':
        this.adapter.pause();
        break;

      case 'resume':
        this.adapter.resume();
        break;

      case 'stop':
        this.adapter.stop();
        break;

      case 'run_task':
        if (!msg.task || typeof msg.task !== 'string') {
          ws.send(JSON.stringify({ type: 'error', error: 'Task string required' }));
          return;
        }
        // Launch in background
        this.adapter.runTask(msg.task, msg.noConfirm).catch(() => {});
        break;

      default:
        ws.send(JSON.stringify({ type: 'unknown_command', command: msg.type }));
    }
  }

  private setupAdapterListeners() {
    this.adapter.on('status_update', (status) => {
      this.broadcast({ type: 'status_update', status });
    });

    this.adapter.on('step_start', (data) => {
      this.broadcast({ type: 'step_start', data });
    });

    this.adapter.on('activity_item', (item) => {
      this.broadcast({ type: 'activity_item', item });
    });

    this.adapter.on('tool_result', (data) => {
      this.broadcast({ type: 'tool_result', data });
    });

    this.adapter.on('text_chunk', (text) => {
      this.broadcast({ type: 'text_chunk', text });
    });

    this.adapter.on('terminal_chunk', (chunk) => {
      this.broadcast({ type: 'terminal_chunk', chunk });
    });

    this.adapter.on('todos_update', (todos) => {
      this.broadcast({ type: 'todos_update', todos });
    });

    this.adapter.on('permission_required', (permission) => {
      this.broadcast({ type: 'permission_required', permission });
    });

    this.adapter.on('test_summary', (testSummary) => {
      this.broadcast({ type: 'test_summary', testSummary });
    });
  }

  public broadcast(payload: any) {
    const raw = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  public close() {
    this.wss.close();
  }
}
