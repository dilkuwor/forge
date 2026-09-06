import {
  loadConfig,
  loadModelsCache,
  saveModelsCache,
  getNvidiaKey,
  getOpenRouterKey,
  DeadModelEntry,
  ProviderName
} from '../config.js';
import { OpenRouterProvider } from './openrouter.js';
import { NvidiaProvider, RETIRED_NVIDIA_MODELS } from './nvidia.js';
import { ChatOptions, ChatResponse, ProviderClient } from './types.js';
import { classifyError, ClassifiedError, ModelExhaustedError } from './errors.js';

export interface ModelRouterOptions {
  openrouter?: ProviderClient;
  nvidia?: ProviderClient;
  /** Permanently dead models (overrides the on-disk cache when provided). */
  deadModels?: Set<string>;
  /** Max retries for transient errors (429/5xx/network) on the same model. */
  maxRetries?: number;
  /** Base backoff in ms (doubles per retry). */
  baseDelayMs?: number;
  /** Cooldown applied to models that return 404 / tools-unsupported. */
  cooldownMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** When false, cooldown/dead changes are not persisted to disk. */
  persist?: boolean;
}

export interface RoutedChatResponse extends ChatResponse {
  finalModel: string;
}

export class RoutingError extends Error {
  public readonly classified: ClassifiedError;
  public readonly model: string;
  constructor(model: string, classified: ClassifiedError) {
    super(classified.message);
    this.name = 'RoutingError';
    this.model = model;
    this.classified = classified;
  }
}

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortErr());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortErr());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortErr(): Error {
  const e = new Error('Operation cancelled');
  e.name = 'AbortError';
  return e;
}

export class ModelRouter {
  public openrouter: ProviderClient;
  public nvidia: ProviderClient;
  private deadModels: Set<string>;
  private cooldowns: Map<string, DeadModelEntry>;
  private readonly isCustomOpenRouter: boolean;
  private readonly isCustomNvidia: boolean;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly cooldownMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly persist: boolean;

  constructor(options?: ModelRouterOptions) {
    this.openrouter = options?.openrouter || new OpenRouterProvider();
    this.nvidia = options?.nvidia || new NvidiaProvider();
    this.isCustomOpenRouter = Boolean(options?.openrouter);
    this.isCustomNvidia = Boolean(options?.nvidia);
    this.maxRetries = options?.maxRetries ?? 2;
    this.baseDelayMs = options?.baseDelayMs ?? 1000;
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.sleep = options?.sleep || defaultSleep;
    this.persist = options?.persist ?? !options?.deadModels;

    const cache = loadModelsCache();
    if (options?.deadModels) {
      this.deadModels = new Set(options.deadModels);
      this.cooldowns = new Map();
    } else {
      this.deadModels = new Set([...RETIRED_NVIDIA_MODELS, ...(cache.deadModels || [])]);
      this.cooldowns = new Map(Object.entries(cache.cooldowns || {}));
      this.pruneCooldowns();
    }
  }

  // ---------------------------------------------------------------------
  // Availability bookkeeping
  // ---------------------------------------------------------------------

  private pruneCooldowns(): boolean {
    const now = Date.now();
    let changed = false;
    for (const [model, entry] of this.cooldowns) {
      if (Date.parse(entry.until) <= now) {
        this.cooldowns.delete(model);
        changed = true;
      }
    }
    return changed;
  }

  private persistAvailability(): void {
    if (!this.persist) return;
    try {
      saveModelsCache({
        deadModels: Array.from(this.deadModels),
        cooldowns: Object.fromEntries(this.cooldowns)
      });
    } catch {
      // Best-effort; availability state is a cache.
    }
  }

  /** Models that are currently unavailable: permanently dead + in cooldown. */
  public getDeadModels(): Set<string> {
    this.pruneCooldowns();
    return new Set([...this.deadModels, ...this.cooldowns.keys()]);
  }

  public isModelAvailable(model: string): boolean {
    return !this.getDeadModels().has(model);
  }

  public markModelDead(model: string, reason?: string): void {
    this.deadModels.add(model);
    this.cooldowns.delete(model);
    this.persistAvailability();
    void reason;
  }

  public markModelCooldown(model: string, reason?: string, ms: number = this.cooldownMs): void {
    if (this.deadModels.has(model)) return;
    this.cooldowns.set(model, { until: new Date(Date.now() + ms).toISOString(), reason });
    this.persistAvailability();
  }

  public clearModelStatus(model: string): void {
    const had = this.deadModels.delete(model) || this.cooldowns.delete(model);
    if (had) this.persistAvailability();
  }

  // ---------------------------------------------------------------------
  // Provider resolution
  // ---------------------------------------------------------------------

  private hasCredentials(provider: ProviderName): boolean {
    if (provider === 'openrouter') return this.isCustomOpenRouter || Boolean(getOpenRouterKey());
    return this.isCustomNvidia || Boolean(getNvidiaKey());
  }

  public resolveProviderForModel(model: string): ProviderClient {
    // 1. Explicit OpenRouter models
    if (model.startsWith('openrouter/') || model.includes(':free')) {
      return this.openrouter;
    }

    // 2. Explicit NVIDIA NIM namespaces
    if (model.startsWith('nvidia/') || model.startsWith('meta/') || model.startsWith('deepseek-ai/')) {
      return this.nvidia;
    }

    // 3. Known in exactly one cached model list
    const cache = loadModelsCache();
    const inNvidia = cache.nvidia.some((m) => m.id === model);
    const inOpenRouter = cache.openrouter.some((m) => m.id === model);
    if (inNvidia && !inOpenRouter) return this.nvidia;
    if (inOpenRouter && !inNvidia) return this.openrouter;

    // 4. Default provider if it has credentials, else whichever does.
    const config = loadConfig();
    const hasNv = this.hasCredentials('nvidia');
    const hasOr = this.hasCredentials('openrouter');
    if (config.defaultProvider === 'nvidia' && (hasNv || !hasOr)) return this.nvidia;
    if (hasOr) return this.openrouter;
    if (hasNv) return this.nvidia;
    return this.openrouter;
  }

  // ---------------------------------------------------------------------
  // Candidate selection
  // ---------------------------------------------------------------------

  private buildCandidates(initialModel: string): string[] {
    const config = loadConfig();
    const unavailable = this.getDeadModels();
    const ordered = Array.from(new Set([initialModel, ...(config.fallbackModels || [])]));
    let candidates = ordered.filter((m) => !unavailable.has(m));

    if (candidates.length === 0) {
      // Dynamic recovery from the cached model lists.
      const cache = loadModelsCache();
      const dynamic: string[] = [];
      if (this.hasCredentials('nvidia')) {
        const live = cache.nvidia
          .filter((m) => m.supportsTools !== false && !unavailable.has(m.id))
          .map((m) => m.id);
        dynamic.push(...(live.length > 0 ? live.slice(0, 3) : ['nvidia/nemotron-3-super-120b-a12b']));
      }
      if (this.hasCredentials('openrouter')) {
        const live = cache.openrouter
          .filter((m) => m.supportsTools !== false && !unavailable.has(m.id))
          .map((m) => m.id);
        dynamic.push(...(live.length > 0 ? live.slice(0, 3) : ['openrouter/free']));
      }
      candidates = dynamic.filter((m) => !this.deadModels.has(m));

      if (candidates.length === 0) {
        // Last resort: give the user's chosen model one more chance, clearing
        // a stale cooldown but never a permanent retirement.
        if (!this.deadModels.has(initialModel)) {
          this.cooldowns.delete(initialModel);
          candidates = [initialModel];
        }
      }
    }

    // Drop candidates whose provider has no credentials.
    return candidates.filter((m) => this.hasCredentials(this.resolveProviderForModel(m).name));
  }

  // ---------------------------------------------------------------------
  // Chat with fallback
  // ---------------------------------------------------------------------

  public async chat(options: ChatOptions): Promise<RoutedChatResponse> {
    const config = loadConfig();
    const initialModel = options.model || config.defaultModel;
    const candidates = this.buildCandidates(initialModel);

    if (candidates.length === 0) {
      const anyCreds = this.hasCredentials('openrouter') || this.hasCredentials('nvidia');
      if (!anyCreds) {
        throw new RoutingError(initialModel, {
          kind: 'auth',
          message:
            'No API key configured. Set OPENROUTER_API_KEY / NVIDIA_API_KEY or run `forge setup`.',
          retryable: false
        });
      }
      throw new ModelExhaustedError([
        {
          model: initialModel,
          error: {
            kind: 'model_unavailable',
            message: 'No available candidate models (all configured models are unavailable).',
            retryable: false
          }
        }
      ]);
    }

    const attempts: Array<{ model: string; error: ClassifiedError }> = [];
    const notify = (message: string) => options.onEvent?.({ type: 'status', message });

    for (let ci = 0; ci < candidates.length; ci++) {
      const model = candidates[ci];
      const provider = this.resolveProviderForModel(model);

      let retries = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (options.signal?.aborted) throw abortErr();

        // Track whether this attempt streamed anything so we can tell the UI
        // to discard partial output before switching models.
        let streamedSomething = false;
        const wrappedOnEvent: ChatOptions['onEvent'] = (ev) => {
          if (ev.type === 'text' || ev.type === 'thinking') streamedSomething = true;
          options.onEvent?.(ev);
        };

        try {
          const resp = await provider.chat({ ...options, model, onEvent: wrappedOnEvent });
          if (this.cooldowns.has(model)) {
            this.cooldowns.delete(model);
            this.persistAvailability();
          }
          return { ...resp, finalModel: model };
        } catch (err) {
          const classified = classifyError(err);

          // User cancellation: stop everything immediately.
          if (classified.kind === 'abort') throw err;

          // Oversized prompt: a different model will not help; the agent loop
          // owns compaction, so surface this without falling back.
          if (classified.kind === 'context_length') {
            throw new RoutingError(model, classified);
          }

          attempts.push({ model, error: classified });

          // Transient: retry same model with backoff.
          if (classified.retryable && retries < this.maxRetries) {
            const delay = classified.retryAfterMs ?? this.baseDelayMs * 2 ** retries;
            retries++;
            notify(
              `${model}: ${classified.kind === 'rate_limit' ? 'rate limited' : classified.kind} — retrying in ${Math.round(
                delay / 1000
              )}s (${retries}/${this.maxRetries})`
            );
            await this.sleep(delay, options.signal);
            continue;
          }

          if (classified.kind === 'model_unavailable') {
            if (classified.status === 410) {
              this.markModelDead(model, classified.message);
            } else {
              this.markModelCooldown(model, classified.message);
            }
          } else if (classified.kind === 'tools_unsupported' && options.tools?.length) {
            this.markModelCooldown(model, classified.message);
          }

          const hasNext = ci < candidates.length - 1;
          if (hasNext) {
            if (streamedSomething) options.onEvent?.({ type: 'reset' });
            notify(`${model} failed (${classified.kind}: ${truncate(classified.message, 120)}). Trying ${candidates[ci + 1]}...`);
          }
          break; // next candidate
        }
      }
    }

    // Prefer surfacing an auth error verbatim: it is actionable.
    const authAttempt = attempts.find((a) => a.error.kind === 'auth');
    if (authAttempt && attempts.every((a) => a.error.kind === 'auth')) {
      throw new RoutingError(authAttempt.model, authAttempt.error);
    }
    throw new ModelExhaustedError(attempts);
  }

  public async initBootCache(): Promise<void> {
    const promises: Promise<unknown>[] = [];
    if (getOpenRouterKey()) promises.push(this.openrouter.fetchModels().catch(() => []));
    if (getNvidiaKey()) promises.push(this.nvidia.fetchModels().catch(() => []));
    await Promise.all(promises);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
