import {
  loadConfig,
  loadModelsCache,
  saveModelsCache,
  getNvidiaKey,
  getOpenRouterKey
} from '../config.js';
import { OpenRouterProvider } from './openrouter.js';
import { NvidiaProvider, RETIRED_NVIDIA_MODELS } from './nvidia.js';
import { ChatOptions, ChatResponse, ProviderClient, ProviderEvent } from './types.js';

export interface ModelRouterOptions {
  openrouter?: ProviderClient;
  nvidia?: ProviderClient;
  deadModels?: Set<string>;
}

export class ModelRouter {
  public openrouter: ProviderClient;
  public nvidia: ProviderClient;
  private deadModels: Set<string>;

  constructor(options?: ModelRouterOptions) {
    this.openrouter = options?.openrouter || new OpenRouterProvider();
    this.nvidia = options?.nvidia || new NvidiaProvider();
    if (options?.deadModels) {
      this.deadModels = new Set(options.deadModels);
    } else {
      const cache = loadModelsCache();
      this.deadModels = new Set([...RETIRED_NVIDIA_MODELS, ...(cache.deadModels || [])]);
    }
  }

  public getDeadModels(): Set<string> {
    return this.deadModels;
  }

  public markModelDead(model: string): void {
    this.deadModels.add(model);
    saveModelsCache({ deadModels: Array.from(this.deadModels) });
  }

  public resolveProviderForModel(model: string): ProviderClient {
    const config = loadConfig();
    const hasNvidiaKey = Boolean(getNvidiaKey());
    const hasOpenRouterKey = Boolean(getOpenRouterKey());

    // If model explicitly belongs to NVIDIA NIM ecosystem
    const isNvidiaModel =
      model.startsWith('nvidia/') ||
      model.startsWith('meta/llama') ||
      model.startsWith('deepseek-ai/');

    if (isNvidiaModel) {
      return this.nvidia;
    }

    if (config.defaultProvider === 'nvidia' && (hasNvidiaKey || !hasOpenRouterKey)) {
      return this.nvidia;
    }

    if (hasOpenRouterKey) {
      return this.openrouter;
    }

    if (hasNvidiaKey) {
      return this.nvidia;
    }

    // Default to openrouter client
    return this.openrouter;
  }

  public isToolCallUnsupportedError(err: any): boolean {
    const msg = (err?.message || '').toLowerCase();
    const code = err?.code || '';
    return (
      msg.includes('tool') ||
      msg.includes('function') ||
      msg.includes('not supported') ||
      msg.includes('unsupported parameter') ||
      code === 'tools_not_supported'
    );
  }

  public isDeadModelError(err: any): boolean {
    const status = err?.status || err?.statusCode || err?.response?.status;
    const msg = (err?.message || '').toLowerCase();

    // Do NOT treat missing API key or auth errors as dead models
    if (
      msg.includes('api key') ||
      msg.includes('key not found') ||
      msg.includes('unauthorized') ||
      status === 401 ||
      status === 403
    ) {
      return false;
    }

    return (
      status === 404 ||
      status === 410 ||
      msg.includes('404') ||
      msg.includes('410') ||
      msg.includes('model not found') ||
      msg.includes('model is retired') ||
      msg.includes('model is decommissioned') ||
      msg.includes('decommissioned') ||
      msg.includes('retired')
    );
  }

  public isRateLimitError(err: any): boolean {
    const status = err?.status || err?.statusCode || err?.response?.status;
    const msg = (err?.message || '').toLowerCase();
    return status === 429 || msg.includes('429') || msg.includes('rate limit');
  }

  public async chat(options: ChatOptions): Promise<ChatResponse & { finalModel: string }> {
    const config = loadConfig();
    const initialModel = options.model || config.defaultModel;

    // User-selected model first, then live fallbacks
    const fallbacks = (config.fallbackModels || []).filter((m) => !this.deadModels.has(m));
    const candidateModels = Array.from(new Set([initialModel, ...fallbacks]));

    if (candidateModels.length === 0) {
      throw new Error('No available candidate models. All configured fallback models are dead.');
    }

    let lastError: any = null;

    for (const model of candidateModels) {
      if (this.deadModels.has(model)) {
        continue;
      }

      const provider = this.resolveProviderForModel(model);

      // Retry up to 2 times on 429
      let retries = 2;
      let delayMs = 1000;

      while (retries >= 0) {
        try {
          const resp = await provider.chat({
            ...options,
            model
          });
          return { ...resp, finalModel: model };
        } catch (err: any) {
          lastError = err;

          // Check if dead model (404/410)
          if (this.isDeadModelError(err)) {
            this.markModelDead(model);
            if (options.onEvent) {
              options.onEvent({
                type: 'text',
                text: `\n[Router] Model ${model} is dead (404/410). Falling back to next model...\n`
              });
            }
            break; // break retry loop, move to next fallback model
          }

          // Check if tool call unsupported
          if (options.tools && options.tools.length > 0 && this.isToolCallUnsupportedError(err)) {
            if (options.onEvent) {
              options.onEvent({
                type: 'text',
                text: `\n[Router] Model ${model} does not support tool calling. Skipping to next model...\n`
              });
            }
            break; // break retry loop, move to next fallback model
          }

          // Check if 429 rate limit
          if (this.isRateLimitError(err) && retries > 0) {
            retries--;
            if (options.onEvent) {
              options.onEvent({
                type: 'text',
                text: `\n[Router] Rate limited (429) on ${model}. Retrying in ${delayMs}ms...\n`
              });
            }
            await new Promise((r) => setTimeout(r, delayMs));
            delayMs *= 2;
            continue;
          }

          // If it's another error or retries exhausted for 429, fall through to next candidate
          if (options.onEvent) {
            options.onEvent({
              type: 'text',
              text: `\n[Router] Error on ${model}: ${err.message}. Trying next fallback...\n`
            });
          }
          break;
        }
      }
    }

    throw lastError || new Error('All candidate models failed.');
  }

  public async initBootCache(): Promise<void> {
    const promises: Promise<any>[] = [];
    if (getOpenRouterKey()) {
      promises.push(this.openrouter.fetchModels().catch(() => []));
    }
    if (getNvidiaKey()) {
      promises.push(this.nvidia.fetchModels().catch(() => []));
    }
    await Promise.all(promises);
  }
}
