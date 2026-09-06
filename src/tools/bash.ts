import { spawn } from 'node:child_process';

export interface BashRunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Cap on captured bytes for stdout+stderr combined. */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BashRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

const KILL_GRACE_MS = 2000;

/**
 * Run a shell command in its own process group so that timeouts and user
 * cancellation kill the whole tree (not just the top-level shell). Output is
 * capped to avoid unbounded memory growth from chatty commands.
 */
export function runBash(command: string, opts: BashRunOptions): Promise<BashRunResult> {
  const maxBytes = opts.maxOutputBytes ?? 2 * 1024 * 1024;
  const started = Date.now();

  return new Promise<BashRunResult>((resolve) => {
    if (opts.signal?.aborted) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: true,
        truncated: false,
        durationMs: 0
      });
      return;
    }

    const isWin = process.platform === 'win32';
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: isWin ? true : '/bin/sh',
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...opts.env,
        // Discourage interactive/pager behaviour from tools the agent runs.
        CI: process.env.CI ?? '1',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        FORCE_COLOR: '0',
        NO_COLOR: '1'
      }
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const append = (which: 'out' | 'err', chunk: Buffer) => {
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - bytes;
      let text = chunk.toString('utf8');
      if (chunk.length > remaining) {
        text = chunk.subarray(0, remaining).toString('utf8');
        truncated = true;
      }
      bytes += Math.min(chunk.length, remaining);
      if (which === 'out') stdout += text;
      else stderr += text;
    };

    child.stdout?.on('data', (c: Buffer) => append('out', c));
    child.stderr?.on('data', (c: Buffer) => append('err', c));

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (!isWin) {
          // Negative pid → whole process group.
          process.kill(-child.pid, sig);
        } else {
          child.kill(sig);
        }
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };

    let graceTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      killTree('SIGTERM');
      graceTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        aborted,
        truncated,
        durationMs: Date.now() - started
      });
    };

    child.on('error', (err) => {
      stderr += (stderr ? '\n' : '') + `spawn error: ${err.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** Trim command output for inclusion in model context. */
export function formatBashOutput(
  res: BashRunResult,
  limits: { maxLines: number; maxChars: number } = { maxLines: 200, maxChars: 15000 }
): string {
  const parts: string[] = [];
  if (res.stdout.trim()) parts.push(res.stdout.trimEnd());
  if (res.stderr.trim()) parts.push(`[STDERR]\n${res.stderr.trimEnd()}`);
  let combined = parts.join('\n').trim();

  const lines = combined.split('\n');
  let clipped = false;
  if (lines.length > limits.maxLines) {
    combined = lines.slice(0, limits.maxLines).join('\n');
    clipped = true;
  }
  if (combined.length > limits.maxChars) {
    combined = combined.slice(0, limits.maxChars);
    clipped = true;
  }
  if (clipped || res.truncated) {
    combined += `\n\n[... output truncated (${lines.length} lines total) ...]`;
  }
  return combined;
}
