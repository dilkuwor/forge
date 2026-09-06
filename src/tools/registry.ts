import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_BASH_TIMEOUT_MS } from '../config.js';
import {
  SecurityError,
  ToolDeniedError,
  bashDenyReason,
  isBashAllowlisted,
  isSensitiveRelativePath,
  validateFilePath
} from './security.js';
import { runBash, formatBashOutput } from './bash.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ConfirmRequest {
  type: 'file' | 'bash';
  /** File path (relative) or command line. */
  target: string;
  /** Tool that triggered the confirmation. */
  tool: string;
  /** Optional human-readable preview (diff snippet, content size, ...). */
  preview?: string;
}

export interface ToolContext {
  projectRoot: string;
  /** Files already approved for modification in this session. */
  allowedFiles: Set<string>;
  confirmConfig: { edit: boolean; bash: boolean };
  onConfirm?: (req: ConfirmRequest) => Promise<boolean>;
  /** Files created/modified in this session. */
  touchedFiles: Set<string>;
  /** Called when the agent updates its todo list. */
  onTodosUpdate?: (todos: string[]) => void;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  bashTimeoutMs?: number;
}

export interface ToolResult {
  content: string;
  /** True when the tool reports a failure the model should react to. */
  isError: boolean;
  /** True when the user explicitly denied the operation. */
  denied?: boolean;
}

export interface ToolSpec {
  definition: ToolDefinition;
  /** Whether this tool can mutate the workspace / run commands. */
  mutating: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  readFileMaxBytes: 2 * 1024 * 1024,
  readFileMaxChars: 60_000,
  readFileMaxLines: 1500,
  listDirMaxEntries: 300,
  globMaxResults: 200,
  grepMaxResults: 150,
  grepMaxLineChars: 300,
  bashMaxLines: 200,
  bashMaxChars: 15_000
};

const ok = (content: string): ToolResult => ({ content, isError: false });
const fail = (content: string): ToolResult => ({ content: `Error: ${content}`, isError: true });

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function int(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return undefined;
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  if (sample.includes(0)) return true;
  let nonText = 0;
  for (const b of sample) {
    if (b < 7 || (b > 14 && b < 32 && b !== 27)) nonText++;
  }
  return sample.length > 0 && nonText / sample.length > 0.3;
}

function buildEditPreview(oldStr: string, newStr: string): string {
  const clip = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + '…' : s);
  const oldLines = clip(oldStr).split('\n').map((l) => `- ${l}`);
  const newLines = clip(newStr).split('\n').map((l) => `+ ${l}`);
  return [...oldLines, ...newLines].slice(0, 30).join('\n');
}

async function requestFileConfirmation(
  ctx: ToolContext,
  tool: string,
  relPath: string,
  preview?: string
): Promise<void> {
  if (!ctx.confirmConfig.edit || ctx.allowedFiles.has(relPath)) return;
  if (ctx.onConfirm) {
    const approved = await ctx.onConfirm({ type: 'file', target: relPath, tool, preview });
    if (!approved) {
      throw new ToolDeniedError(`User denied ${tool} on ${relPath}.`);
    }
  }
  ctx.allowedFiles.add(relPath);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const readFile: ToolSpec = {
  mutating: false,
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read contents of a file within the project with line numbers. Supports optional 1-indexed line ranges. Large files are truncated; use start/end to page.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file from the project root.' },
          start: { type: 'integer', description: 'Optional 1-indexed start line number.' },
          end: { type: 'integer', description: 'Optional 1-indexed end line number (inclusive).' }
        },
        required: ['path']
      }
    }
  },
  async execute(args, ctx) {
    const { absolute, relative } = validateFilePath(args.path, ctx.projectRoot);
    if (!fs.existsSync(absolute)) return fail(`File "${relative}" does not exist.`);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) return fail(`"${relative}" is a directory. Use list_dir instead.`);
    if (stat.size > LIMITS.readFileMaxBytes) {
      return fail(
        `File "${relative}" is ${stat.size} bytes, which exceeds the ${LIMITS.readFileMaxBytes} byte limit. Use grep or bash (head/sed) to inspect parts of it.`
      );
    }

    const buf = fs.readFileSync(absolute);
    if (looksBinary(buf)) {
      return fail(`File "${relative}" appears to be binary (${stat.size} bytes). Not displaying.`);
    }
    const content = buf.toString('utf8');
    const lines = content.split('\n');
    const total = lines.length;

    let start = int(args.start) ?? 1;
    let end = int(args.end) ?? total;
    start = Math.max(1, start);
    end = Math.min(total, end);
    if (start > total) {
      return fail(`File "${relative}" has ${total} lines. Start line ${start} is beyond end of file.`);
    }
    if (end < start) end = start;

    let clipped = false;
    if (end - start + 1 > LIMITS.readFileMaxLines) {
      end = start + LIMITS.readFileMaxLines - 1;
      clipped = true;
    }

    const slice = lines.slice(start - 1, end);
    let formatted = slice.map((line, idx) => `${start + idx}: ${line}`).join('\n');
    if (formatted.length > LIMITS.readFileMaxChars) {
      formatted = formatted.slice(0, LIMITS.readFileMaxChars);
      clipped = true;
    }

    let header = `File: ${relative} (lines ${start}-${end} of ${total})`;
    if (clipped) header += ` [truncated — request a narrower range to see more]`;
    return ok(`${header}\n\n${formatted}`);
  }
};

const writeFile: ToolSpec = {
  mutating: true,
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write entire content to a file. Overwrites existing files or creates new files (and parent directories). Requires confirmation. Prefer edit_file for small changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file.' },
          content: { type: 'string', description: 'Full text content to write to the file.' }
        },
        required: ['path', 'content']
      }
    }
  },
  async execute(args, ctx) {
    const { absolute, relative } = validateFilePath(args.path, ctx.projectRoot);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      return fail(`"${relative}" is a directory.`);
    }
    const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
    const exists = fs.existsSync(absolute);
    const preview = `${exists ? 'Overwrite' : 'Create'} ${relative} (${content.length} chars, ${
      content.split('\n').length
    } lines)`;
    await requestFileConfirmation(ctx, 'write_file', relative, preview);

    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
    ctx.touchedFiles.add(relative);
    return ok(`Successfully wrote ${content.length} characters to ${relative}.`);
  }
};

const editFile: ToolSpec = {
  mutating: true,
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact, unique occurrence of `old` with `new` in a file. Fails if `old` is missing or appears more than once — include enough surrounding context to make it unique. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file.' },
          old: {
            type: 'string',
            description: 'The exact string to be replaced. Must appear exactly once in the file.'
          },
          new: { type: 'string', description: 'The replacement string.' }
        },
        required: ['path', 'old', 'new']
      }
    }
  },
  async execute(args, ctx) {
    const { absolute, relative } = validateFilePath(args.path, ctx.projectRoot);
    if (!fs.existsSync(absolute)) return fail(`File "${relative}" does not exist.`);
    if (fs.statSync(absolute).isDirectory()) return fail(`"${relative}" is a directory.`);

    const oldStr = args.old;
    const newStr = args.new;
    if (typeof oldStr !== 'string' || oldStr.length === 0) {
      return fail(`'old' must be a non-empty string.`);
    }
    if (typeof newStr !== 'string') return fail(`'new' must be a string.`);
    if (oldStr === newStr) return fail(`'old' and 'new' are identical; nothing to change.`);

    const content = fs.readFileSync(absolute, 'utf8');
    const first = content.indexOf(oldStr);
    if (first === -1) {
      return fail(
        `'old' content not found in "${relative}". Use read_file to inspect the file and retry with exact matching content (check whitespace and indentation).`
      );
    }
    const second = content.indexOf(oldStr, first + oldStr.length);
    if (second !== -1) {
      let count = 2;
      let pos = second + oldStr.length;
      while ((pos = content.indexOf(oldStr, pos)) !== -1) {
        count++;
        pos += oldStr.length;
      }
      return fail(
        `'old' content is not unique in "${relative}" (found ${count} occurrences). Include more surrounding context in 'old' to make it unique.`
      );
    }

    await requestFileConfirmation(ctx, 'edit_file', relative, buildEditPreview(oldStr, newStr));

    // Use slicing rather than String.replace so `$&`, `$1` etc. in `new` are literal.
    const updated = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
    fs.writeFileSync(absolute, updated, 'utf8');
    ctx.touchedFiles.add(relative);

    const lineNo = content.slice(0, first).split('\n').length;
    return ok(`Successfully edited ${relative} (at line ${lineNo}).`);
  }
};

const listDir: ToolSpec = {
  mutating: false,
  definition: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List contents of a directory (non-recursive).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to directory. Defaults to "." (project root).'
          }
        }
      }
    }
  },
  async execute(args, ctx) {
    const target = str(args.path) || '.';
    const { absolute, relative } = validateFilePath(target, ctx.projectRoot);
    const display = relative || '.';
    if (!fs.existsSync(absolute)) return fail(`Directory "${display}" does not exist.`);
    if (!fs.statSync(absolute).isDirectory()) return fail(`"${display}" is a file, not a directory.`);

    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const shown = entries.slice(0, LIMITS.listDirMaxEntries);
    const items = shown.map((e) => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`);
    let out = `Directory listing for ${display} (${entries.length} entries):\n${
      items.join('\n') || '(empty directory)'
    }`;
    if (entries.length > shown.length) {
      out += `\n... (${entries.length - shown.length} more entries not shown)`;
    }
    return ok(out);
  }
};

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', '.turbo', 'build', '.cache']);

const glob: ToolSpec = {
  mutating: false,
  definition: {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern relative to the project root (e.g. "**/*.ts", "src/**/*.js").',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to search for.' }
        },
        required: ['pattern']
      }
    }
  },
  async execute(args, ctx) {
    const pattern = str(args.pattern);
    if (!pattern) return fail('pattern must be a non-empty string.');
    if (path.isAbsolute(pattern) || pattern.startsWith('~') || pattern.split(/[\\/]/).includes('..')) {
      return fail('glob patterns must be relative to the project root and may not contain "..".');
    }

    try {
      const globSync = (fs as unknown as { globSync?: (p: string, o: unknown) => string[] }).globSync;
      if (!globSync) return fail('glob is not supported on this Node.js version (requires Node 22+).');
      const matches = globSync(pattern, {
        cwd: ctx.projectRoot,
        exclude: (p: string | { name: string }) => {
          const name = typeof p === 'string' ? p : p.name;
          const segs = name.split(/[\\/]/);
          return segs.some((s) => IGNORED_DIRS.has(s));
        }
      })
        .map((m) => m.split(path.sep).join('/'))
        .filter((m) => !m.startsWith('../') && !isSensitiveRelativePath(m))
        .sort();

      const list = matches.slice(0, LIMITS.globMaxResults);
      if (list.length === 0) return ok(`No files match "${pattern}".`);
      return ok(
        `Found ${matches.length} files matching "${pattern}":\n${list.join('\n')}${
          matches.length > list.length ? `\n... (${matches.length - list.length} more not shown)` : ''
        }`
      );
    } catch (err) {
      return fail(`glob failed: ${(err as Error).message}`);
    }
  }
};

let rgAvailableCache: boolean | null = null;
function hasRipgrep(): boolean {
  if (rgAvailableCache !== null) return rgAvailableCache;
  try {
    const res = spawnSync('rg', ['--version'], { stdio: 'ignore' });
    rgAvailableCache = res.status === 0;
  } catch {
    rgAvailableCache = false;
  }
  return rgAvailableCache;
}

const grep: ToolSpec = {
  mutating: false,
  definition: {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search for a regex pattern in project files (ripgrep if available, otherwise a native fallback). Returns file:line:text matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for.' },
          glob: { type: 'string', description: 'Optional glob to restrict search (e.g. "*.ts").' },
          path: { type: 'string', description: 'Optional subdirectory to search in.' }
        },
        required: ['pattern']
      }
    }
  },
  async execute(args, ctx) {
    const pattern = str(args.pattern);
    if (!pattern) return fail('pattern must be a non-empty string.');
    const globFilter = str(args.glob);
    const subPath = str(args.path);
    let searchRoot = ctx.projectRoot;
    let displayRoot = '.';
    if (subPath) {
      const v = validateFilePath(subPath, ctx.projectRoot);
      if (!fs.existsSync(v.absolute)) return fail(`Path "${v.relative}" does not exist.`);
      searchRoot = v.absolute;
      displayRoot = v.relative || '.';
    }

    if (hasRipgrep()) {
      const rgArgs = [
        '-n',
        '--no-heading',
        '--color=never',
        '--max-columns',
        String(LIMITS.grepMaxLineChars),
        '--max-count',
        '50'
      ];
      if (globFilter) rgArgs.push('-g', globFilter);
      for (const d of IGNORED_DIRS) rgArgs.push('-g', `!${d}`);
      rgArgs.push('-g', '!.env*', '-g', '!*.pem', '-g', '!*.key');
      rgArgs.push('-e', pattern, '--', '.');

      const res = spawnSync('rg', rgArgs, {
        cwd: searchRoot,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30_000
      });

      if (res.status === 0) {
        const prefix = displayRoot === '.' ? '' : `${displayRoot}/`;
        const lines = res.stdout
          .trimEnd()
          .split('\n')
          .map((l) => prefix + l.replace(/^\.\//, ''));
        const shown = lines.slice(0, LIMITS.grepMaxResults);
        return ok(
          `Grep matches for "${pattern}" (${lines.length}):\n${shown.join('\n')}${
            lines.length > shown.length ? `\n... (${lines.length - shown.length} more not shown)` : ''
          }`
        );
      }
      if (res.status === 1) return ok(`No matches found for "${pattern}".`);
      if (res.status === 2 && /regex parse error|error parsing/i.test(res.stderr || '')) {
        return fail(`Invalid regex pattern: ${res.stderr.trim().split('\n')[0]}`);
      }
      // otherwise fall through to native search
    }

    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return fail(`Invalid regex pattern: ${(err as Error).message}`);
    }
    const globRe = globFilter ? globToRegExp(globFilter) : null;
    const results: string[] = [];
    const walk = (dir: string) => {
      if (results.length >= LIMITS.grepMaxResults || ctx.signal?.aborted) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= LIMITS.grepMaxResults) break;
        if (IGNORED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(ctx.projectRoot, full).split(path.sep).join('/');
        if (isSensitiveRelativePath(rel)) continue;
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          if (globRe && !globRe.test(entry.name) && !globRe.test(rel)) continue;
          try {
            const st = fs.statSync(full);
            if (st.size > LIMITS.readFileMaxBytes) continue;
            const buf = fs.readFileSync(full);
            if (looksBinary(buf)) continue;
            const lines = buf.toString('utf8').split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                const text = lines[i].length > LIMITS.grepMaxLineChars ? lines[i].slice(0, LIMITS.grepMaxLineChars) + '…' : lines[i];
                results.push(`${rel}:${i + 1}:${text}`);
                if (results.length >= LIMITS.grepMaxResults) break;
              }
            }
          } catch {
            // unreadable
          }
        }
      }
    };
    walk(searchRoot);
    if (results.length === 0) return ok(`No matches found for "${pattern}".`);
    return ok(`Grep matches for "${pattern}" (${results.length}):\n${results.join('\n')}`);
  }
};

function globToRegExp(g: string): RegExp {
  const esc = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`);
}

const bash: ToolSpec = {
  mutating: true,
  definition: {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Execute a shell command in the project root (default 60-second timeout, output truncated). Read-only commands such as ls, cat, git status/diff/log, rg, npm test, and npx vitest are pre-approved; other commands require user confirmation. Dangerous commands are blocked.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command line to execute.' },
          timeout_ms: {
            type: 'integer',
            description: 'Optional timeout override in milliseconds (max 600000).'
          }
        },
        required: ['command']
      }
    }
  },
  async execute(args, ctx) {
    const command = str(args.command)?.trim();
    if (!command) return fail('command must be a non-empty string.');

    const denyReason = bashDenyReason(command);
    if (denyReason) {
      throw new SecurityError(`Permission denied: bash command blocked by security policy (${denyReason}).`);
    }

    if (ctx.confirmConfig.bash && !isBashAllowlisted(command)) {
      if (ctx.onConfirm) {
        const approved = await ctx.onConfirm({ type: 'bash', target: command, tool: 'bash' });
        if (!approved) throw new ToolDeniedError(`User denied permission to run: ${command}`);
      }
    }

    const requested = int(args.timeout_ms);
    const timeoutMs = Math.min(
      600_000,
      Math.max(1000, requested ?? ctx.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS)
    );

    const res = await runBash(command, { cwd: ctx.projectRoot, timeoutMs, signal: ctx.signal });
    const output = formatBashOutput(res, { maxLines: LIMITS.bashMaxLines, maxChars: LIMITS.bashMaxChars });

    if (res.aborted) {
      return { content: `Command cancelled by user.${output ? `\n${output}` : ''}`, isError: true };
    }
    if (res.timedOut) {
      return fail(`Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed.${output ? `\n${output}` : ''}`);
    }
    if (res.exitCode !== 0) {
      const how = res.exitCode === null ? `signal ${res.signal ?? 'unknown'}` : `exit code ${res.exitCode}`;
      return { content: `Command failed with ${how}:\n${output || '(no output)'}`, isError: true };
    }
    return ok(output || '(command completed with no output)');
  }
};

const todo: ToolSpec = {
  mutating: false,
  definition: {
    type: 'function',
    function: {
      name: 'todo',
      description:
        'Replace the working todo list for the current task. Use it to plan multi-step work and mark items done (prefix completed items with "[x]"). The list is shown to you in the system prompt.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Full list of todo items, e.g. ["[x] read config", "[ ] add tests"].'
          }
        },
        required: ['items']
      }
    }
  },
  async execute(args, ctx) {
    const raw = Array.isArray(args.items) ? args.items : [args.items];
    const items = raw
      .filter((i) => i !== undefined && i !== null)
      .map((i) => (typeof i === 'string' ? i : JSON.stringify(i)))
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 50);
    ctx.onTodosUpdate?.(items);
    if (items.length === 0) return ok('Todo list cleared.');
    return ok(`Updated todo list (${items.length} items):\n${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
  }
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOL_REGISTRY: ReadonlyMap<string, ToolSpec> = new Map<string, ToolSpec>([
  ['read_file', readFile],
  ['write_file', writeFile],
  ['edit_file', editFile],
  ['list_dir', listDir],
  ['glob', glob],
  ['grep', grep],
  ['bash', bash],
  ['todo', todo]
]);

export const TOOLS: ToolDefinition[] = Array.from(TOOL_REGISTRY.values()).map((t) => t.definition);

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_REGISTRY.get(name);
}

/** Validate presence and rough type of required arguments against the JSON schema. */
export function validateToolArgs(spec: ToolSpec, args: Record<string, unknown>): string | null {
  const params = spec.definition.function.parameters;
  for (const req of params.required || []) {
    if (args[req] === undefined || args[req] === null) {
      return `Missing required argument "${req}" for ${spec.definition.function.name}.`;
    }
  }
  for (const [key, schema] of Object.entries(params.properties)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    const type = (schema as { type?: string }).type;
    if (type === 'string' && typeof v !== 'string') {
      return `Argument "${key}" must be a string.`;
    }
    if (type === 'integer' && int(v) === undefined) {
      return `Argument "${key}" must be an integer.`;
    }
    if (type === 'array' && !Array.isArray(v)) {
      return `Argument "${key}" must be an array.`;
    }
  }
  return null;
}
