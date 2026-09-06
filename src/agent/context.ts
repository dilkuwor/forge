import fs from 'node:fs';
import path from 'node:path';
import { getProjectMd } from '../config.js';

const IGNORED = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '__pycache__',
  'target',
  'vendor'
]);

export function buildRepoMap(projectRoot: string, maxFiles: number = 80, maxDepth: number = 4): string {
  const fileList: string[] = [];
  let truncated = false;

  function traverse(dir: string, depth: number) {
    if (fileList.length >= maxFiles || depth > maxDepth) {
      if (depth <= maxDepth) truncated = true;
      return;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (fileList.length >= maxFiles) {
        truncated = true;
        break;
      }
      const name = entry.name;
      if (IGNORED.has(name)) continue;
      // Keep dotfiles that matter for orientation; skip the rest.
      if (name.startsWith('.') && !['.forge', '.github', '.env.example'].includes(name)) continue;

      const fullPath = path.join(dir, name);
      const relPath = path.relative(projectRoot, fullPath).split(path.sep).join('/');

      if (entry.isDirectory()) {
        fileList.push(`${relPath}/`);
        traverse(fullPath, depth + 1);
      } else if (entry.isFile()) {
        fileList.push(relPath);
      }
    }
  }

  traverse(projectRoot, 0);

  if (fileList.length === 0) return '(empty directory)';
  return fileList.join('\n') + (truncated ? `\n... (listing truncated to ${maxFiles} entries; use list_dir/glob to explore)` : '');
}

export interface SystemPromptState {
  touchedFiles: Set<string>;
  todos?: string[];
  /** Human-readable summary of resumed session, if any. */
  resumedNote?: string;
}

/**
 * Caches the repository map for a short period. Re-walking the tree on every
 * agent step is wasteful and changes the system prompt prefix continuously,
 * which defeats provider-side prompt caching. The map is refreshed when the
 * TTL expires or when the agent modifies files.
 */
export class ContextBuilder {
  private repoMapCache?: { value: string; at: number; touchedCount: number };
  private readonly ttlMs: number;

  constructor(
    private readonly projectRoot: string,
    opts?: { ttlMs?: number }
  ) {
    this.ttlMs = opts?.ttlMs ?? 60_000;
  }

  public invalidate(): void {
    this.repoMapCache = undefined;
  }

  private getRepoMap(touchedCount: number): string {
    const now = Date.now();
    const c = this.repoMapCache;
    if (c && now - c.at < this.ttlMs && c.touchedCount === touchedCount) return c.value;
    const value = buildRepoMap(this.projectRoot);
    this.repoMapCache = { value, at: now, touchedCount };
    return value;
  }

  public build(state: SystemPromptState): string {
    const repoMap = this.getRepoMap(state.touchedFiles.size);
    const projectMd = getProjectMd(this.projectRoot);

    let prompt = `You are forge, an autonomous terminal coding agent.
Working directory: ${this.projectRoot}

CORE RULES:
1. Stay inside the project root at all times.
2. Read before edit: always inspect existing file content before modifying it.
3. Prefer exact edit_file over rewriting whole files with write_file.
4. edit_file requires the exact, unique 'old' string from the file. If edit_file fails because 'old' is not found or not unique, use read_file to inspect the file and retry once with exact context.
5. Run tests after code changes (e.g. npm test or npx vitest via bash).
6. Do not invent file contents or assumptions; verify with tools.
7. Never print or upload secrets from .env, keys, or pem files.
8. When planning complex tasks, use the todo tool and keep it updated.
9. If a tool result says the user denied an action, do not retry the same action; explain and propose an alternative or stop.
10. Be direct, helpful, and concise. Explain your actions cleanly. When the task is complete, summarize what changed.

REPOSITORY STRUCTURE:
${repoMap}
`;

    if (projectMd) {
      prompt += `\nPROJECT INSTRUCTIONS (.forge/project.md):\n${projectMd.trim()}\n`;
    }

    if (state.resumedNote) {
      prompt += `\nSESSION NOTE:\n${state.resumedNote}\n`;
    }

    if (state.todos && state.todos.length > 0) {
      prompt += `\nCURRENT TODO LIST:\n${state.todos.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`;
    }

    if (state.touchedFiles.size > 0) {
      prompt += `\nFILES TOUCHED IN THIS SESSION:\n${Array.from(state.touchedFiles)
        .map((f) => `- ${f}`)
        .join('\n')}\n`;
    }

    return prompt.trim();
  }
}

/** Stateless convenience wrapper kept for backwards compatibility. */
export function buildSystemPrompt(projectRoot: string, touchedFiles: Set<string>): string {
  return new ContextBuilder(projectRoot, { ttlMs: 0 }).build({ touchedFiles });
}
