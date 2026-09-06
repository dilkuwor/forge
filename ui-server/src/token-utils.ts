import { loadModelsCache } from '../../src/config.js';
import { estimateTokenCount, estimateHistoryTokens } from '../../src/agent/compact.js';
import { TokenUsageStats, CompactionStats } from './types/index.js';

export { estimateTokenCount, estimateHistoryTokens };

const KNOWN_MODEL_LIMITS: Record<string, number> = {
  'openrouter/free': 131072,
  'nvidia/nemotron-3-super-120b-a12b': 131072,
  'nvidia/nemotron-3-ultra-550b-a55b': 131072,
  'deepseek-ai/deepseek-v4-flash-0731': 131072,
  'deepseek/deepseek-chat': 65536,
  'openai/gpt-oss-120b:free': 131072,
  'meta-llama/llama-3.3-70b-instruct': 131072,
  'meta-llama/llama-3.1-8b-instruct': 131072,
  'meta/llama-3.1-8b-instruct': 131072,
  'meta/llama-3.3-70b-instruct': 131072,
  'anthropic/claude-3.5-sonnet': 200000,
  'openai/gpt-4o': 128000,
  'openai/gpt-4o-mini': 128000
};

export function resolveModelContextLimit(modelId?: string): number {
  if (!modelId) return 32768;

  if (KNOWN_MODEL_LIMITS[modelId]) {
    return KNOWN_MODEL_LIMITS[modelId];
  }
  const shortId = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
  for (const [key, val] of Object.entries(KNOWN_MODEL_LIMITS)) {
    if (key.endsWith(shortId)) return val;
  }

  try {
    const cache = loadModelsCache();
    const all = [...(cache.openrouter || []), ...(cache.nvidia || [])];
    const found = all.find((m) => m.id === modelId || m.id === shortId);
    if (found && found.contextLength && found.contextLength > 0) {
      return found.contextLength;
    }
  } catch {
    // ignore
  }

  return 32768;
}

export function formatTokens(count: number): string {
  if (count == null || isNaN(count)) return '0';
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1000) {
    const k = count / 1000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(count);
}

export function calculateTokenUsageStats(params: {
  inputTokens: number;
  outputTokens: number;
  currentContextTokens: number;
  model: string;
  isActual: boolean;
}): TokenUsageStats {
  const modelContextLimit = resolveModelContextLimit(params.model);
  const currentContextTokens = params.currentContextTokens;
  const utilizationPercent = Math.min(100, Math.round((currentContextTokens / modelContextLimit) * 100));
  const estimatedRemainingTokens = Math.max(0, modelContextLimit - currentContextTokens);

  return {
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    totalTokens: params.inputTokens + params.outputTokens,
    currentContextTokens,
    modelContextLimit,
    utilizationPercent,
    estimatedRemainingTokens,
    isActual: params.isActual
  };
}

export function computeSessionTokenStats(
  records: Array<{ timestamp: string; type: string; data: any }>,
  model: string
): { tokenUsage: TokenUsageStats; compactions: CompactionStats } {
  let compactionCount = 0;
  let totalTokensFreed = 0;
  let lastTokensBefore: number | undefined;
  let lastTokensAfter: number | undefined;
  let lastTokensFreed: number | undefined;

  let peakContext = 0;
  let currentContext = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let isActual = false;

  const hasMessages = records.some((r) => r.type === 'user' || r.type === 'assistant');
  if (!hasMessages) {
    const modelLimit = resolveModelContextLimit(model);
    return {
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        currentContextTokens: 0,
        modelContextLimit: modelLimit,
        utilizationPercent: 0,
        estimatedRemainingTokens: modelLimit,
        isActual: false
      },
      compactions: {
        count: 0,
        totalTokensFreed: 0
      }
    };
  }

  // Baseline prompt estimate (~1200 tokens for system prompt)
  let runningContext = 1200;

  for (const rec of records) {
    if (rec.type === 'user') {
      const tokens = estimateTokenCount(rec.data?.content || '');
      runningContext += tokens;
      if (runningContext > peakContext) peakContext = runningContext;
    } else if (rec.type === 'assistant') {
      if (rec.data?.usage && (rec.data.usage.promptTokens || rec.data.usage.prompt_tokens)) {
        isActual = true;
        const pTokens = rec.data.usage.promptTokens || rec.data.usage.prompt_tokens || 0;
        const cTokens = rec.data.usage.completionTokens || rec.data.usage.completion_tokens || 0;
        totalInputTokens += pTokens;
        totalOutputTokens += cTokens;
        runningContext = pTokens + cTokens;
      } else {
        totalInputTokens += runningContext;
        const outText = rec.data?.text || '';
        const thinking = rec.data?.thinking || '';
        const toolCalls = rec.data?.toolCalls ? JSON.stringify(rec.data.toolCalls) : '';
        const stepOutTokens =
          estimateTokenCount(outText) + estimateTokenCount(thinking) + estimateTokenCount(toolCalls);
        totalOutputTokens += stepOutTokens;
        runningContext += stepOutTokens;
      }
      if (runningContext > peakContext) peakContext = runningContext;
    } else if (rec.type === 'tool_result') {
      const resText = rec.data?.result || '';
      const toolResTokens = estimateTokenCount(resText);
      runningContext += toolResTokens;
      if (runningContext > peakContext) peakContext = runningContext;
    } else if (rec.type === 'system' && rec.data?.action === 'compact') {
      compactionCount++;
      const before = rec.data.tokensBefore || 0;
      const after = rec.data.tokensAfter || 0;
      const freed = Math.max(0, before - after);
      totalTokensFreed += freed;
      lastTokensBefore = before;
      lastTokensAfter = after;
      lastTokensFreed = freed;
      if (before > peakContext) peakContext = before;
      runningContext = after;
    }
  }

  currentContext = runningContext;
  if (currentContext > peakContext) peakContext = currentContext;

  const modelLimit = resolveModelContextLimit(model);
  const utilizationPercent = Math.min(100, Math.round((peakContext / modelLimit) * 100));
  const estimatedRemainingTokens = Math.max(0, modelLimit - currentContext);

  return {
    tokenUsage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      currentContextTokens: currentContext,
      modelContextLimit: modelLimit,
      utilizationPercent,
      estimatedRemainingTokens,
      isActual
    },
    compactions: {
      count: compactionCount,
      lastTokensBefore,
      lastTokensAfter,
      lastTokensFreed,
      totalTokensFreed
    }
  };
}

