import { getNvidiaKey, saveModelsCache, ModelInfo } from '../config.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export const RETIRED_NVIDIA_MODELS = ['deepseek-ai/deepseek-v4-flash'];

export const PREFERRED_NVIDIA_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'deepseek-ai/deepseek-v4-flash-0731'
];

interface NvidiaModel {
  id: string;
  name?: string;
  context_length?: number;
  max_model_len?: number;
}

export class NvidiaProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      name: 'nvidia',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      getApiKey: getNvidiaKey,
      missingKeyHint: 'NVIDIA API key not found. Set NVIDIA_API_KEY or run `forge login nvidia`.',
      retiredModels: RETIRED_NVIDIA_MODELS
    });
  }

  protected parseModelList(data: unknown): ModelInfo[] {
    const list = (data as { data?: NvidiaModel[] } | undefined)?.data;
    if (!Array.isArray(list)) return [];
    const models: ModelInfo[] = [];
    for (const m of list) {
      if (!m || typeof m.id !== 'string') continue;
      const ctx = m.context_length ?? m.max_model_len;
      models.push({
        id: m.id,
        name: m.name || m.id,
        provider: 'nvidia',
        contextLength: typeof ctx === 'number' ? ctx : undefined,
        supportsTools: true
      });
    }
    return models;
  }

  protected persistModelInfos(models: ModelInfo[]): void {
    saveModelsCache({
      nvidia: models,
      deadModels: RETIRED_NVIDIA_MODELS,
      updatedAt: new Date().toISOString()
    });
  }

  protected fallbackModelIds(): string[] {
    return PREFERRED_NVIDIA_MODELS;
  }
}
