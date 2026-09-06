import fs from 'node:fs';
import path from 'node:path';

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

export class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDeniedError';
  }
}

// ---------------------------------------------------------------------------
// Sensitive file policy
// ---------------------------------------------------------------------------

/**
 * Filename / path-segment patterns that must never be read or written by the
 * agent regardless of user confirmation. Matching is done on each path segment
 * of the project-relative path (after symlink resolution).
 */
const SENSITIVE_SEGMENT_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i, // .env, .env.local — but not .env.example (handled below)
  /^\.ssh$/i,
  /^\.gnupg$/i,
  /^\.aws$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^credentials(\.json)?$/i,
  /^service[-_]?account.*\.json$/i
];

const SENSITIVE_ALLOWLIST: RegExp[] = [/^\.env\.(example|sample|template|dist)$/i];

export function isSensitiveRelativePath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (SENSITIVE_ALLOWLIST.some((re) => re.test(seg))) continue;
    if (SENSITIVE_SEGMENT_PATTERNS.some((re) => re.test(seg))) return true;
    // Forge's own credential store, wherever FORGE_HOME points inside the root.
    if (seg === '.forge' && segments[i + 1] === 'auth.json') return true;
  }
  return false;
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Resolve the deepest existing ancestor via realpath, then re-append the
 * non-existent tail. This lets us validate paths for files that will be
 * created while still resolving symlinked directories.
 */
function resolveWithRealAncestor(absPath: string): string {
  if (fs.existsSync(absPath)) return realpathSafe(absPath);
  const tail: string[] = [];
  let cur = absPath;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSafe(cur), ...tail);
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface ValidatedPath {
  /** Absolute, symlink-resolved path. */
  absolute: string;
  /** Path relative to the (resolved) project root, using forward slashes. */
  relative: string;
}

/**
 * Validate that a model-supplied path stays within the project root, even via
 * symlinks, and does not touch sensitive files.
 */
export function validateFilePath(filePath: unknown, projectRoot: string): ValidatedPath {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new SecurityError('Permission denied: path must be a non-empty string.');
  }
  if (filePath.includes('\0')) {
    throw new SecurityError('Permission denied: path contains a null byte.');
  }

  const realRoot = realpathSafe(path.resolve(projectRoot));
  const requested = path.resolve(realRoot, filePath);

  // Lexical check first (cheap, catches obvious ../ escapes)
  if (!isInside(realRoot, requested)) {
    throw new SecurityError(`Permission denied: path "${filePath}" escapes project root.`);
  }

  // Symlink-aware check
  const resolved = resolveWithRealAncestor(requested);
  if (!isInside(realRoot, resolved)) {
    throw new SecurityError(
      `Permission denied: path "${filePath}" resolves outside the project root (symlink).`
    );
  }

  const relative = path.relative(realRoot, resolved).split(path.sep).join('/');
  if (isSensitiveRelativePath(relative) || isSensitiveRelativePath(filePath)) {
    throw new SecurityError(`Permission denied: access to sensitive file "${filePath}" is forbidden.`);
  }

  return { absolute: resolved, relative };
}

// ---------------------------------------------------------------------------
// Bash policy
// ---------------------------------------------------------------------------

/**
 * Hard deny-list: commands that are never allowed, even with auto-approve.
 * This is defense-in-depth; the primary safety boundary is the confirmation
 * prompt. Patterns are intentionally specific to avoid blocking normal work.
 */
const DENY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[\s;&|(`])sudo(\s|$)/i, reason: 'sudo is not permitted' },
  { re: /(^|[\s;&|(`])su(\s+-|\s+root|\s*$)/i, reason: 'su is not permitted' },
  { re: /(^|[\s;&|(`])doas(\s|$)/i, reason: 'doas is not permitted' },
  {
    // rm with a recursive flag targeting / , /*, ~, $HOME, or a parent directory
    re: /(^|[\s;&|(`])rm\s+(?:-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(?:-[a-z]*\s+)*(?:\/(?:\*|\s|$)|~(?:\/?\s|\/?$)|\$HOME(?:\/?\s|\/?$)|\.\.(?:\/|\s|$))/i,
    reason: 'recursive delete of root/home/parent directory'
  },
  { re: /(^|[\s;&|(`])rm\s+(?:-[a-z]*\s+)*(?:\/|~|\$HOME)\s*$/i, reason: 'delete of root/home' },
  { re: /(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k|c)?sh\b/i, reason: 'piping downloads into a shell' },
  { re: /(^|[\s;&|(`])(mkfs|fdisk|parted|dd)\b/i, reason: 'disk-level operations' },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)/i, reason: 'writing to block devices' },
  { re: /(^|[\s;&|(`])(shutdown|reboot|halt|poweroff|init\s+[06])\b/i, reason: 'system power operations' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: 'fork bomb' },
  { re: /(^|[\s;&|(`])chmod\s+(-[a-z]*\s+)*[0-7]*777\s+\/(\s|$)/i, reason: 'chmod 777 on /' },
  { re: /(^|[\s;&|(`])chown\s+(-[a-z]*\s+)*\S+\s+\/(\s|$)/i, reason: 'chown on /' },
  { re: /(^|[\s;&|(`])git\s+push\b.*(--force\b|-f\b|\+[^\s]+:)/i, reason: 'force push' },
  { re: /(^|[\s;&|(`])git\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.)\b/i, reason: 'destructive git operation' },
  { re: /(^|[\s;&|(`])history\s+-c\b/i, reason: 'clearing shell history' },
  { re: /(^|[\s;&|(`])(crontab\s+-r|launchctl\s+(load|unload|bootstrap))\b/i, reason: 'scheduler modification' },
  { re: /(^|[\s;&|(`])(nc|ncat|netcat)\s+.*-e\b/i, reason: 'reverse shell' },
  { re: /\.(ssh|gnupg|aws)\//i, reason: 'access to credential directories' },
  { re: /(^|[\s/])\.env(\.(?!example|sample|template|dist)[\w.-]+)?(\s|$)/i, reason: 'access to .env files' },
  { re: /\.(pem|key|p12|pfx)(\s|$)/i, reason: 'access to private keys' },
  { re: /(^|[\s/])id_(rsa|dsa|ecdsa|ed25519)\b/i, reason: 'access to SSH keys' },
  { re: /(^|[\s/~])\.(netrc|npmrc|pypirc|git-credentials)(\s|$)/i, reason: 'access to credential files' },
  { re: /(^|[\s;&|(`])(export\s+)?(OPENROUTER_API_KEY|NVIDIA_API_KEY)\s*=/i, reason: 'modifying API key environment' },
  { re: /~?\/?\.forge\/auth\.json/i, reason: 'access to Forge credentials' },
  { re: /(^|[\s;&|(`])(eval|exec)\s+"?\$\(/i, reason: 'evaluating command substitution' },
  { re: /base64\s+(-d|--decode)[^|]*\|\s*(ba|z|da)?sh\b/i, reason: 'decoding and executing payloads' }
];

export function bashDenyReason(cmd: string): string | null {
  const normalized = cmd.replace(/\s+/g, ' ').trim();
  for (const { re, reason } of DENY_PATTERNS) {
    if (re.test(normalized)) return reason;
  }
  return null;
}

export function isBashCommandDenied(cmd: string): boolean {
  return bashDenyReason(cmd) !== null;
}

/**
 * Read-only / safe commands that run without confirmation. A command is only
 * allowlisted if the *entire* command line is a single simple invocation:
 * no pipes, redirections, command substitution, or chaining.
 */
const ALLOWLIST_PATTERNS: RegExp[] = [
  /^ls(\s+-[a-zA-Z1]+)*(\s+[\w./~-]+)*$/,
  /^pwd$/,
  /^echo(\s+[^$`;&|<>]*)?$/,
  /^cat(\s+-[a-zA-Z]+)*(\s+[\w./-]+)+$/,
  /^head(\s+-\w+(\s+\d+)?)*(\s+[\w./-]+)+$/,
  /^tail(\s+-\w+(\s+\d+)?)*(\s+[\w./-]+)+$/,
  /^wc(\s+-[a-zA-Z]+)*(\s+[\w./-]+)*$/,
  /^rg(\s+.*)?$/,
  /^grep(\s+.*)?$/,
  /^find(\s+.*)?$/,
  /^which(\s+[\w.-]+)+$/,
  /^git\s+(status|diff|log|show|branch|remote|rev-parse|ls-files|blame|stash\s+list)(\s+.*)?$/,
  /^npm\s+(test|run\s+test|run\s+lint|run\s+typecheck|run\s+build|ls|outdated|view)(\s+.*)?$/,
  /^npx\s+(vitest|jest|tsc|eslint|prettier\s+--check)(\s+.*)?$/,
  /^(node|bun|python3?|ruby|go|cargo|rustc|java|javac|tsc)\s+--version$/,
  /^(yarn|pnpm)\s+(test|lint|typecheck|build)(\s+.*)?$/,
  /^cargo\s+(test|check|build|clippy)(\s+.*)?$/,
  /^go\s+(test|vet|build)(\s+.*)?$/,
  /^(pytest|python3?\s+-m\s+pytest)(\s+.*)?$/,
  /^make\s+(test|lint|check|build)$/
];

const COMPOUND_RE = /[|;&`$<>()]|\bxargs\b|\bexec\b/;
// Arguments that reach outside the project root (absolute, home, or parent paths).
const OUTSIDE_ROOT_ARG_RE = /(^|\s)(\/|~|\.\.(\/|\s|$))/;

export function isBashAllowlisted(cmd: string): boolean {
  const trimmed = cmd.replace(/\s+/g, ' ').trim();
  if (!trimmed) return false;
  // find -exec / -delete can mutate the filesystem
  if (/^find\b/.test(trimmed) && /-(exec|execdir|delete|ok|okdir)\b/.test(trimmed)) return false;
  // No shell compounding for allowlisted commands
  if (COMPOUND_RE.test(trimmed)) return false;
  // Read-only commands are only pre-approved when they stay inside the project
  if (OUTSIDE_ROOT_ARG_RE.test(trimmed)) return false;
  return ALLOWLIST_PATTERNS.some((re) => re.test(trimmed));
}
