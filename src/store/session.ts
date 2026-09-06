import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSessionsDir } from '../config.js';

export interface SessionMeta {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  provider: string;
}

export interface SessionRecord {
  timestamp: string;
  type: 'meta' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error' | 'system';
  data: any;
}

export class SessionStore {
  public readonly id: string;
  public readonly filePath: string;
  private writeStream?: fs.WriteStream;

  constructor(id?: string, meta?: { cwd: string; model: string; provider: string }) {
    if (id) {
      this.id = id;
    } else {
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randomStr = crypto.randomBytes(4).toString('hex');
      this.id = `${dateStr}-${randomStr}`;
    }

    this.filePath = path.join(getSessionsDir(), `${this.id}.jsonl`);

    if (meta && !fs.existsSync(this.filePath)) {
      this.append({
        timestamp: new Date().toISOString(),
        type: 'meta',
        data: {
          id: this.id,
          createdAt: new Date().toISOString(),
          ...meta
        }
      });
    }
  }

  public append(record: SessionRecord): void {
    const line = JSON.stringify(record) + '\n';
    try {
      fs.appendFileSync(this.filePath, line, 'utf8');
    } catch (err) {
      // ignore or log
    }
  }

  public readAll(): SessionRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}

export function listSessions(): SessionMeta[] {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const sessions: SessionMeta[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
      if (firstLine) {
        const record = JSON.parse(firstLine);
        if (record.type === 'meta') {
          sessions.push(record.data);
          continue;
        }
      }
    } catch {
      // ignore
    }
    const id = path.basename(file, '.jsonl');
    sessions.push({
      id,
      createdAt: '',
      cwd: '',
      model: '',
      provider: ''
    });
  }

  return sessions.sort((a, b) => {
    const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (tA && tB && tA !== tB) return tB - tA;
    return b.id.localeCompare(a.id);
  });
}
