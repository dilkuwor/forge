import fs from 'node:fs';
import path from 'node:path';
import { exec, execSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface ToolContext {
  projectRoot: string;
  allowedFiles: Set<string>;
  confirmConfig: {
    edit: boolean;
    bash: boolean;
  };
  onConfirm?: (prompt: { type: 'file' | 'bash'; target: string }) => Promise<boolean>;
  todos?: string[];
  touchedFiles: Set<string>;
}

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

export function validateFilePath(filePath: string, projectRoot: string): string {
  const resolved = path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, resolved);

  // Deny path escape
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SecurityError(`Permission denied: path "${filePath}" escapes project root.`);
  }

  // Deny ~/.ssh, .env, *.pem
  const segments = relative.split(path.sep);
  if (segments.some((seg) => seg === '.ssh' || seg === '~/.ssh')) {
    throw new SecurityError(`Permission denied: access to .ssh paths is forbidden.`);
  }

  if (segments.some((seg) => seg === '.env' || seg.startsWith('.env.'))) {
    throw new SecurityError(`Permission denied: access to .env files is forbidden.`);
  }

  if (resolved.endsWith('.pem') || segments.some((seg) => seg.endsWith('.pem'))) {
    throw new SecurityError(`Permission denied: access to .pem files is forbidden.`);
  }

  return resolved;
}

export function isBashCommandDenied(cmd: string): boolean {
  const normalized = cmd.trim();

  // Deny sudo
  if (/\bsudo\b/i.test(normalized)) {
    return true;
  }

  // Deny rm -rf / or rm -r / etc
  if (/\brm\s+.*(-[a-zA-Z]*r[a-zA-Z]*).*\s+(\/|\/\*|~|\$HOME)(\s|$)/i.test(normalized)) {
    return true;
  }

  // Deny curl | sh or curl | bash or wget | sh
  if (/(curl|wget)\b[^|]*\|\s*(bash|sh|zsh)/i.test(normalized)) {
    return true;
  }

  // Deny secrets access
  if (
    normalized.includes('.env') ||
    normalized.includes('.ssh') ||
    normalized.includes('.pem')
  ) {
    return true;
  }

  return false;
}

export function isBashAllowlisted(cmd: string): boolean {
  const trimmed = cmd.trim();
  const allowlistPatterns = [
    /^ls(\s+.*)?$/,
    /^pwd$/,
    /^rg(\s+.*)?$/,
    /^git\s+status(\s+.*)?$/,
    /^git\s+diff(\s+.*)?$/,
    /^npm\s+test(\s+.*)?$/,
    /^npx\s+vitest(\s+.*)?$/
  ];

  return allowlistPatterns.some((pattern) => pattern.test(trimmed));
}

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

export async function executeTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<string> {
  switch (name) {
    case 'read_file': {
      const fullPath = validateFilePath(args.path, ctx.projectRoot);
      if (!fs.existsSync(fullPath)) {
        return `Error: File "${args.path}" does not exist.`;
      }
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        return `Error: "${args.path}" is a directory. Use list_dir instead.`;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      const start = typeof args.start === 'number' ? Math.max(1, args.start) : 1;
      const end = typeof args.end === 'number' ? Math.min(lines.length, args.end) : lines.length;

      if (start > lines.length) {
        return `File "${args.path}" has ${lines.length} lines. Start line ${start} is beyond end of file.`;
      }

      const slice = lines.slice(start - 1, end);
      const formatted = slice.map((line, idx) => `${start + idx}: ${line}`).join('\n');
      return `File: ${args.path} (lines ${start}-${end} of ${lines.length})\n\n${formatted}`;
    }

    case 'write_file': {
      const fullPath = validateFilePath(args.path, ctx.projectRoot);
      const relPath = path.relative(ctx.projectRoot, fullPath);

      if (ctx.confirmConfig.edit && !ctx.allowedFiles.has(relPath)) {
        if (ctx.onConfirm) {
          const ok = await ctx.onConfirm({ type: 'file', target: relPath });
          if (!ok) {
            throw new Error(`User rejected write_file for ${relPath}`);
          }
        }
        ctx.allowedFiles.add(relPath);
      }

      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
      fs.writeFileSync(fullPath, content, 'utf8');
      ctx.touchedFiles.add(relPath);
      return `Successfully wrote ${content.length} characters to ${relPath}.`;
    }

    case 'edit_file': {
      const fullPath = validateFilePath(args.path, ctx.projectRoot);
      const relPath = path.relative(ctx.projectRoot, fullPath);

      if (!fs.existsSync(fullPath)) {
        return `Error: File "${args.path}" does not exist.`;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      const oldStr = args.old;
      const newStr = args.new;

      if (typeof oldStr !== 'string' || oldStr.length === 0) {
        return `Error: 'old' string must be a non-empty string.`;
      }
      if (typeof newStr !== 'string') {
        return `Error: 'new' string must be provided.`;
      }

      // Count occurrences
      let count = 0;
      let pos = 0;
      while ((pos = content.indexOf(oldStr, pos)) !== -1) {
        count++;
        pos += oldStr.length;
      }

      if (count === 0) {
        return `Error: 'old' content not found in "${args.path}". Please use read_file to inspect the file and retry with exact matching content.`;
      }

      if (count > 1) {
        return `Error: 'old' content is not unique in "${args.path}" (found ${count} occurrences). Please include more surrounding context in 'old' to make it unique.`;
      }

      if (ctx.confirmConfig.edit && !ctx.allowedFiles.has(relPath)) {
        if (ctx.onConfirm) {
          const ok = await ctx.onConfirm({ type: 'file', target: relPath });
          if (!ok) {
            throw new Error(`User rejected edit_file for ${relPath}`);
          }
        }
        ctx.allowedFiles.add(relPath);
      }

      const updated = content.replace(oldStr, newStr);
      fs.writeFileSync(fullPath, updated, 'utf8');
      ctx.touchedFiles.add(relPath);
      return `Successfully edited ${relPath}.`;
    }

    case 'list_dir': {
      const target = args.path ? args.path : '.';
      const fullPath = validateFilePath(target, ctx.projectRoot);
      if (!fs.existsSync(fullPath)) {
        return `Error: Directory "${target}" does not exist.`;
      }
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) {
        return `Error: "${target}" is a file, not a directory.`;
      }

      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      const items = entries.map((e) => {
        const isDir = e.isDirectory();
        return `${isDir ? '[DIR] ' : '[FILE]'} ${e.name}`;
      });

      return `Directory listing for ${target}:\n${items.join('\n') || '(empty directory)'}`;
    }

    case 'glob': {
      const pattern = args.pattern;
      if (!pattern || typeof pattern !== 'string') {
        return `Error: pattern must be a non-empty string.`;
      }

      try {
        // Use fs.globSync (Node 22+)
        const matches = (fs as any).globSync(pattern, {
          cwd: ctx.projectRoot,
          exclude: (p: string) =>
            p.includes('node_modules') || p.includes('.git') || p.includes('.env') || p.endsWith('.pem')
        });
        const list = (matches as string[]).slice(0, 100);
        return `Found ${matches.length} files matching "${pattern}":\n${list.join('\n')}${
          matches.length > 100 ? '\n... (truncated)' : ''
        }`;
      } catch (err: any) {
        return `Error running glob: ${err.message}`;
      }
    }

    case 'grep': {
      const pattern = args.pattern;
      if (!pattern || typeof pattern !== 'string') {
        return `Error: pattern must be a non-empty string.`;
      }
      const globFilter = args.glob;

      if (hasRipgrep()) {
        try {
          const rgArgs = ['-n', '--no-heading', '--color=never', '-m', '100', pattern];
          if (globFilter) {
            rgArgs.push('-g', globFilter);
          }
          rgArgs.push('-g', '!.git');
          rgArgs.push('-g', '!node_modules');
          rgArgs.push('-g', '!.env*');
          rgArgs.push('-g', '!*.pem');

          const res = spawnSync('rg', rgArgs, {
            cwd: ctx.projectRoot,
            encoding: 'utf8',
            maxBuffer: 5 * 1024 * 1024
          });

          if (res.status === 0) {
            const lines = res.stdout.trim().split('\n');
            return `Grep matches for "${pattern}":\n${lines.slice(0, 100).join('\n')}`;
          } else if (res.status === 1) {
            return `No matches found for "${pattern}".`;
          } else {
            // fall through to node grep
          }
        } catch {
          // fall through to node search
        }
      }

      // Pure Node search fallback
      const results: string[] = [];
      function searchDir(dir: string) {
        if (results.length >= 100) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= 100) break;
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
            continue;
          }
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            searchDir(full);
          } else if (entry.isFile()) {
            if (entry.name.endsWith('.pem') || entry.name.startsWith('.env')) continue;
            try {
              const content = fs.readFileSync(full, 'utf8');
              const lines = content.split('\n');
              const rel = path.relative(ctx.projectRoot, full);
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(pattern)) {
                  results.push(`${rel}:${i + 1}:${lines[i]}`);
                  if (results.length >= 100) break;
                }
              }
            } catch {
              // ignore binary / unreadable files
            }
          }
        }
      }

      try {
        searchDir(ctx.projectRoot);
        if (results.length === 0) {
          return `No matches found for "${pattern}".`;
        }
        return `Grep matches for "${pattern}":\n${results.join('\n')}`;
      } catch (err: any) {
        return `Error during search: ${err.message}`;
      }
    }

    case 'bash': {
      const command = args.command;
      if (!command || typeof command !== 'string') {
        return `Error: command must be a non-empty string.`;
      }

      if (isBashCommandDenied(command)) {
        throw new SecurityError(`Permission denied: bash command "${command}" is blocked by security policy.`);
      }

      const isAllowlisted = isBashAllowlisted(command);

      if (ctx.confirmConfig.bash && !isAllowlisted) {
        if (ctx.onConfirm) {
          const ok = await ctx.onConfirm({ type: 'bash', target: command });
          if (!ok) {
            throw new Error(`User rejected permission to run bash command: ${command}`);
          }
        }
      }

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: ctx.projectRoot,
          timeout: 60000,
          maxBuffer: 10 * 1024 * 1024
        });

        const combined = (stdout + (stderr ? `\n[STDERR]\n${stderr}` : '')).trim();
        const lines = combined.split('\n');
        if (lines.length > 200 || combined.length > 15000) {
          const truncated = lines.slice(0, 200).join('\n').slice(0, 15000);
          return `${truncated}\n\n[... output truncated ...]`;
        }
        return combined || '(command completed with no output)';
      } catch (err: any) {
        const code = err.code ?? 1;
        const msg = (err.stdout || '') + '\n' + (err.stderr || err.message || '');
        return `Command failed with exit code ${code}:\n${msg.trim()}`;
      }
    }

    case 'todo': {
      const items = Array.isArray(args.items) ? args.items : [String(args.items ?? '')];
      ctx.todos = items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
      return `Updated todo list (${ctx.todos.length} items):\n${ctx.todos.map((t, idx) => `${idx + 1}. ${t}`).join('\n')}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
