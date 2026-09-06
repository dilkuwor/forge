/**
 * Provider error classification.
 *
 * Every OpenAI-compatible provider surfaces failures slightly differently
 * (SDK APIError with `.status`, raw fetch failures, aborted signals, ...).
 * The router needs one stable vocabulary to decide between: retry, fall back,
 * compact-and-retry, or surface to the user. Classification prefers structured
 * information (status codes, error names) over message heuristics, and message
 * heuristics are deliberately narrow to avoid mis-marking healthy models.
 */

export type ErrorKind =
  | 'abort'
  | 'auth'
  | 'rate_limit'
  | 'model_unavailable'
  | 'tools_unsupported'
  | 'context_length'
  | 'bad_request'
  | 'network'
  | 'server'
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  status?: number;
  message: string;
  /** Milliseconds to wait before retrying, if the provider told us. */
  retryAfterMs?: number;
  /** Whether trying the same model again could plausibly succeed. */
  retryable: boolean;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return true;
  if (e.name === 'APIUserAbortError') return true; // openai sdk
  if (typeof e.message === 'string' && /request was aborted|operation was aborted/i.test(e.message)) {
    return true;
  }
  if (e.cause) return isAbortError(e.cause);
  return false;
}

function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode']) {
    const v = e[key];
    if (typeof v === 'number' && v >= 100 && v < 600) return v;
  }
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp && typeof resp.status === 'number') return resp.status;
  return undefined;
}

function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const headers = (e.headers ?? (e.response as Record<string, unknown> | undefined)?.headers) as
    | Record<string, string>
    | { get?: (k: string) => string | null }
    | undefined;
  if (!headers) return undefined;
  let raw: string | null | undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    raw = (headers as { get: (k: string) => string | null }).get('retry-after');
  } else {
    const h = headers as Record<string, string>;
    raw = h['retry-after'] ?? h['Retry-After'];
  }
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return undefined;
}

function extractMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    // openai sdk nests the provider's error body under `error`
    const nested = e.error as Record<string, unknown> | undefined;
    if (nested && typeof nested.message === 'string') return nested.message;
    if (typeof e.message === 'string') return e.message;
  }
  return String(err);
}

function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError') return true;
  const code = e.code || (e.cause as { code?: string } | undefined)?.code;
  if (
    code &&
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(
      code
    )
  ) {
    return true;
  }
  if (typeof e.message === 'string' && /^fetch failed|network error|socket hang up/i.test(e.message)) {
    return true;
  }
  return false;
}

export function classifyError(err: unknown): ClassifiedError {
  const message = extractMessage(err);
  const lower = message.toLowerCase();
  const status = extractStatus(err);

  if (isAbortError(err)) {
    return { kind: 'abort', status, message, retryable: false };
  }

  if (status === 401 || status === 403) {
    return { kind: 'auth', status, message, retryable: false };
  }
  if (!status && /api key not found|invalid api key|unauthorized|authentication/i.test(lower)) {
    return { kind: 'auth', status, message, retryable: false };
  }

  if (status === 429) {
    return {
      kind: 'rate_limit',
      status,
      message,
      retryAfterMs: extractRetryAfterMs(err),
      retryable: true
    };
  }

  if (isNetworkError(err)) {
    return { kind: 'network', status, message, retryable: true };
  }

  // Context-length overflow is a 400 from most providers; detect via wording.
  if (
    /context[_ ]length|maximum context|context window|too many tokens|prompt is too long|exceeds the limit|input is too long|max_tokens.*exceed|token limit/i.test(
      lower
    )
  ) {
    return { kind: 'context_length', status, message, retryable: false };
  }

  if (status === 404 || status === 410) {
    return { kind: 'model_unavailable', status, message, retryable: false };
  }
  if (
    /model .* (not found|does not exist|is not available)|no such model|model is (retired|decommissioned|deprecated)|model_not_found|no endpoints found/i.test(
      lower
    )
  ) {
    return { kind: 'model_unavailable', status, message, retryable: false };
  }

  if (
    /(tool|function)[ _-]?(calling|calls|use)? (is |are )?(not|un)supported|does not support (tools|function calling)|unsupported parameter.*tool|tools are not supported|no endpoints found that support tool/i.test(
      lower
    )
  ) {
    return { kind: 'tools_unsupported', status, message, retryable: false };
  }

  if (status !== undefined && status >= 500) {
    return { kind: 'server', status, message, retryable: true };
  }

  if (status !== undefined && status >= 400) {
    return { kind: 'bad_request', status, message, retryable: false };
  }

  return { kind: 'unknown', status, message, retryable: false };
}

export class ForgeAbortError extends Error {
  constructor(message: string = 'Operation cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export class ModelExhaustedError extends Error {
  public readonly attempts: Array<{ model: string; error: ClassifiedError }>;
  constructor(attempts: Array<{ model: string; error: ClassifiedError }>) {
    const lines = attempts.map((a) => `  - ${a.model}: [${a.error.kind}] ${a.error.message}`);
    super(
      `All candidate models failed:\n${lines.join('\n')}\nRun 'forge setup' or '/model <name>' to select an active model.`
    );
    this.name = 'ModelExhaustedError';
    this.attempts = attempts;
  }
}
