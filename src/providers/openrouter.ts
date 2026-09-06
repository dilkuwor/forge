import { getOpenRouterKey, saveModelsCache, ModelInfo } from '../config.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export const OPENROUTER_FALLBACK_MODELS = [
  'openrouter/free',
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-r1:free'
];

interface OpenRouterModel {
  id: string;
  name?: string;
  pricing?: { prompt?: number | string; completion?: number | string };
  context_length?: number;
  supported_parameters?: string[];
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      name: 'openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
      getApiKey: getOpenRouterKey,
      missingKeyHint:
        'OpenRouter API key not found. Set OPENROUTER_API_KEY or run `forge login openrouter`.',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/dilkuwor/forge',
        'X-Title': 'forge'
      }
    });
  }

  protected parseModelList(data: unknown): ModelInfo[] {
    const list = (data as { data?: OpenRouterModel[] } | undefined)?.data;
    if (!Array.isArray(list)) return [];

    const models: ModelInfo[] = [];
    for (const m of list) {
      if (!m || typeof m.id !== 'string') continue;
      const promptPrice = m.pricing?.prompt;
      const completionPrice = m.pricing?.completion;
      const isFreePrice =
        (promptPrice === 0 || promptPrice === '0') &&
        (completionPrice === 0 || completionPrice === '0');
      const isFreeName = m.id.endsWith(':free') || m.id.includes('/free');
      const params = m.supported_parameters;
      const supportsTools = Array.isArray(params) ? params.includes('tools') : true;

      if ((isFreePrice || isFreeName) && supportsTools) {
        models.push({
          id: m.id,
          name: m.name || m.id,
          provider: 'openrouter',
          pricing: { prompt: promptPrice, completion: completionPrice },
          contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
          supportsTools: true
        });
      }
    }
    return models;
  }

  protected persistModelInfos(models: ModelInfo[]): void {
    saveModelsCache({ openrouter: models, updatedAt: new Date().toISOString() });
  }

  protected fallbackModelIds(): string[] {
    return OPENROUTER_FALLBACK_MODELS;
  }
}
