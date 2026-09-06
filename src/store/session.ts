import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSessionsDir } from '../config.js';
import type { ChatMessage, ToolCallData } from '../providers/types.js';
import { repairToolPairing } from '../agent/compact.js';

export interface SessionMeta {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  provider: string;
  /** Populated by listSessions() from the first user message, if any. */
  title?: string;
  updatedAt?: string;
}

export type SessionRecordType =
  | 'meta'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'system';

export interface SessionRecord {
  timestamp: string;
  type: SessionRecordType;
  data: any;
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export function generateSessionId(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomStr = crypto.randomBytes(4).toString('hex');
  return `${dateStr}-${randomStr}`;
}

/**
 * Append-only JSONL session log.
 *
 * The file is created lazily on first append so that opening the TUI and
 * quitting without sending anything leaves no empty session behind.
 */
export class SessionStore {
  public readonly id: string;
  public readonly filePath: string;
  private pendingMeta?: SessionRecord;
  private created: boolean;

  constructor(id?: string, meta?: { cwd: string; model: string; provider: string }) {
    if (id !== undefined && !isValidSessionId(id)) {
      throw new Error(`Invalid session id "${id}".`);
    }
    this.id = id || generateSessionId();
    this.filePath = path.join(getSessionsDir(), `${this.id}.jsonl`);
    this.created = fs.existsSync(this.filePath);

    if (meta && !this.created) {
      this.pendingMeta = {
        timestamp: new Date().toISOString(),
        type: 'meta',
        data: { id: this.id, createdAt: new Date().toISOString(), ...meta }
      };
    }
  }

  /** True once anything has been written to disk. */
  public exists(): boolean {
    return this.created;
  }

  public append(record: SessionRecord): void {
    let payload = '';
    if (this.pendingMeta) {
      payload += JSON.stringify(this.pendingMeta) + '\n';
      this.pendingMeta = undefined;
    }
    payload += JSON.stringify(record) + '\n';
    try {
      fs.appendFileSync(this.filePath, payload, { encoding: 'utf8', mode: 0o600 });
      this.created = true;
    } catch {
      // Session logging is best-effort; never fail the agent because of it.
    }
  }

  public readAll(): SessionRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const records: SessionRecord[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // Skip a torn/corrupt line rather than losing the whole session.
      }
    }
    return records;
  }

  public getMeta(): SessionMeta | undefined {
    const first = this.readAll().find((r) => r.type === 'meta');
    return first?.data as SessionMeta | undefined;
  }

  /**
   * Rebuild the chat transcript (excluding the system prompt) from the log so
   * a session can be resumed. Tool-call pairing is repaired for sessions that
   * were interrupted mid-turn.
   */
  public toMessages(): ChatMessage[] {
    const records = this.readAll();
    const messages: ChatMessage[] = [];

    for (const rec of records) {
      switch (rec.type) {
        case 'user': {
          const content = typeof rec.data?.content === 'string' ? rec.data.content : '';
          if (content) messages.push({ role: 'user', content });
          break;
        }
        case 'assistant': {
          const text = typeof rec.data?.text === 'string' ? rec.data.text : '';
          const toolCalls: ToolCallData[] = Array.isArray(rec.data?.toolCalls) ? rec.data.toolCalls : [];
          if (!text && toolCalls.length === 0) break;
          messages.push({
            role: 'assistant',
            content: text || null,
            tool_calls:
              toolCalls.length > 0
                ? toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: { name: tc.name, arguments: tc.arguments ?? '' }
                  }))
                : undefined
          });
          break;
        }
        case 'tool_result': {
          if (typeof rec.data?.id !== 'string') break;
          messages.push({
            role: 'tool',
            tool_call_id: rec.data.id,
            name: typeof rec.data.name === 'string' ? rec.data.name : undefined,
            content: typeof rec.data.result === 'string' ? rec.data.result : ''
          });
          break;
        }
        case 'system': {
          // Compaction events replace history; represent them as the summary they produced.
          if (rec.data?.action === 'compact' && typeof rec.data?.summary === 'string') {
            // Summaries are informational; the full transcript is still in the log.
          }
          break;
        }
        default:
          break;
      }
    }

    return repairToolPairing(messages);
  }

  /** Files touched, reconstructed from successful write/edit tool results. */
  public getTouchedFiles(): Set<string> {
    const touched = new Set<string>();
    for (const rec of this.readAll()) {
      if (rec.type !== 'tool_result' || rec.data?.error) continue;
      const name = rec.data?.name;
      const p = rec.data?.args?.path;
      if ((name === 'write_file' || name === 'edit_file') && typeof p === 'string') {
        touched.add(p);
      }
    }
    return touched;
  }

  public static load(id: string): SessionStore | null {
    if (!isValidSessionId(id)) return null;
    const filePath = path.join(getSessionsDir(), `${id}.jsonl`);
    if (!fs.existsSync(filePath)) return null;
    return new SessionStore(id);
  }
}

function readHead(filePath: string, bytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function listSessions(limit?: number): SessionMeta[] {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const sessions: SessionMeta[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const id = path.basename(file, '.jsonl');
    let meta: SessionMeta = { id, createdAt: '', cwd: '', model: '', provider: '' };
    try {
      const head = readHead(filePath, 16 * 1024);
      const lines = head.split('\n').filter((l) => l.trim());
      for (const line of lines.slice(0, 5)) {
        let rec: SessionRecord;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === 'meta' && rec.data) {
          meta = { ...meta, ...rec.data, id };
        } else if (rec.type === 'user' && !meta.title && typeof rec.data?.content === 'string') {
          const t = rec.data.content.trim().split('\n')[0];
          meta.title = t.length > 80 ? t.slice(0, 79) + '…' : t;
        }
      }
      meta.updatedAt = fs.statSync(filePath).mtime.toISOString();
    } catch {
      // ignore unreadable file
    }
    sessions.push(meta);
  }

  sessions.sort((a, b) => {
    const tA = Date.parse(a.updatedAt || a.createdAt) || 0;
    const tB = Date.parse(b.updatedAt || b.createdAt) || 0;
    if (tA !== tB) return tB - tA;
    return b.id.localeCompare(a.id);
  });

  return typeof limit === 'number' ? sessions.slice(0, limit) : sessions;
}
