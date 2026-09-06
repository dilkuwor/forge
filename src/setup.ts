import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  ForgeConfig,
  AuthConfig,
  DEFAULT_CONFIG,
  getConfigPath,
  getAuthPath,
  getModelsCachePath,
  loadConfig,
  saveConfig,
  loadAuth,
  saveAuth,
  saveModelsCache,
  getOpenRouterKey,
  getNvidiaKey
} from './config.js';
import { RETIRED_NVIDIA_MODELS, PREFERRED_NVIDIA_MODELS } from './providers/nvidia.js';

export type ConfigStatusType =
  | 'VALID'
  | 'FIRST_RUN'
  | 'MISSING_KEY'
  | 'INVALID_KEY'
  | 'MISSING_MODEL';

export interface ConfigStatus {
  status: ConfigStatusType;
  provider?: 'openrouter' | 'nvidia';
  model?: string;
  apiKey?: string;
  error?: string;
  isFirstRun?: boolean;
}

export interface SetupOptions {
  force?: boolean;
  isHeadless?: boolean;
  configPath?: string;
  authPath?: string;
  modelsCachePath?: string;
  promptFn?: (query: string) => Promise<string>;
  maskedPromptFn?: (query: string) => Promise<string>;
  validateKeyFn?: (
    provider: 'openrouter' | 'nvidia',
    key: string
  ) => Promise<{ valid: boolean; error?: string; isNetworkError?: boolean }>;
  fetchModelsFn?: (provider: 'openrouter' | 'nvidia', key: string) => Promise<string[]>;
  launchTuiFn?: () => Promise<void>;
}

export function loadSetupConfig(customPath?: string): ForgeConfig {
  if (!customPath) return loadConfig();
  if (fs.existsSync(customPath)) {
    try {
      const raw = fs.readFileSync(customPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        confirm: {
          ...DEFAULT_CONFIG.confirm,
          ...(parsed.confirm || {})
        }
      };
    } catch {}
  }
  return { ...DEFAULT_CONFIG };
}

export function saveSetupConfig(config: Partial<ForgeConfig>, customPath?: string): ForgeConfig {
  if (!customPath) return saveConfig(config);
  const existing = loadSetupConfig(customPath);
  const updated: ForgeConfig = {
    ...existing,
    ...config,
    confirm: {
      ...existing.confirm,
      ...(config.confirm || {})
    }
  };
  fs.writeFileSync(customPath, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

export function loadSetupAuth(customPath?: string): AuthConfig {
  if (!customPath) return loadAuth();
  if (fs.existsSync(customPath)) {
    try {
      return JSON.parse(fs.readFileSync(customPath, 'utf8'));
    } catch {}
  }
  return {};
}

export function saveSetupAuth(auth: Partial<AuthConfig>, customPath?: string): AuthConfig {
  if (!customPath) return saveAuth(auth);
  const existing = loadSetupAuth(customPath);
  const updated: AuthConfig = {
    ...existing,
    ...auth
  };
  fs.writeFileSync(customPath, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

/**
 * Standard unmasked text prompt.
 */
export function promptText(query: string, customPromptFn?: (q: string) => Promise<string>): Promise<string> {
  if (customPromptFn) {
    return customPromptFn(query);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

/**
 * Secure masked text prompt (prints '*' for each typed character).
 * Falls back to regular readline when not in an interactive TTY.
 */
export function promptMasked(query: string, customMaskedFn?: (q: string) => Promise<string>): Promise<string> {
  if (customMaskedFn) {
    return customMaskedFn(query);
  }

  if (!process.stdin.isTTY) {
    return promptText(query);
  }

  process.stdout.write(query);

  return new Promise((resolve) => {
    let input = '';
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          // Ctrl+C
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        } else if (char === '\r' || char === '\n') {
          // Enter
          cleanup();
          process.stdout.write('\n');
          resolve(input.trim());
          return;
        } else if (char === '\u0008' || char === '\x7f') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (char >= ' ' && char <= '~') {
          // Printable ASCII
          input += char;
          process.stdout.write('*');
        }
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(wasRaw || false);
      }
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Validates an API key against provider endpoints.
 */
export async function validateProviderApiKey(
  provider: 'openrouter' | 'nvidia',
  apiKey: string
): Promise<{ valid: boolean; error?: string; isNetworkError?: boolean }> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, error: 'API key cannot be empty' };
  }

  const cleanKey = apiKey.trim();

  try {
    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: {
          Authorization: `Bearer ${cleanKey}`
        }
      });

      if (res.status === 200) {
        return { valid: true };
      }
      if (res.status === 401) {
        let msg = 'Unauthorized: Invalid OpenRouter API key';
        try {
          const body = (await res.json()) as any;
          if (body?.error?.message) msg = body.error.message;
        } catch {}
        return { valid: false, error: msg };
      }
      if (res.status === 429) {
        // Rate limited but authenticated
        return { valid: true };
      }
      return { valid: false, error: `OpenRouter returned HTTP ${res.status}` };
    } else {
      // NVIDIA NIM
      const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cleanKey}`
        },
        body: JSON.stringify({
          model: 'nvidia/nemotron-3-super-120b-a12b',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1
        })
      });

      if (res.status === 200) {
        return { valid: true };
      }
      if (res.status === 401 || res.status === 403) {
        let msg = 'Authorization failed: Invalid NVIDIA API key';
        try {
          const body = (await res.json()) as any;
          if (body?.detail || body?.title) msg = body.detail || body.title;
        } catch {}
        return { valid: false, error: msg };
      }
      if (res.status === 429 || res.status === 400) {
        return { valid: true };
      }
      return { valid: false, error: `NVIDIA returned HTTP ${res.status}` };
    }
  } catch (err: any) {
    return {
      valid: false,
      error: `Network error: ${err.message}`,
      isNetworkError: true
    };
  }
}

/**
 * Fetches available models for a provider using live API or cached fallbacks.
 */
export async function fetchModelsForProvider(
  provider: 'openrouter' | 'nvidia',
  apiKey: string
): Promise<string[]> {
  try {
    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data && Array.isArray(data.data)) {
          const modelList: string[] = [];
          for (const m of data.data) {
            const promptPrice = m.pricing?.prompt;
            const completionPrice = m.pricing?.completion;
            const isFree =
              promptPrice === 0 ||
              promptPrice === '0' ||
              m.id.endsWith(':free') ||
              m.id.includes('/free');
            const supportsTools = Array.isArray(m.supported_parameters)
              ? m.supported_parameters.includes('tools')
              : true;
            if ((isFree || supportsTools) && m.id) {
              modelList.push(m.id);
            }
          }
          if (modelList.length > 0) return modelList;
        }
      }
      return [
        'openrouter/free',
        'openai/gpt-oss-120b:free',
        'meta-llama/llama-3.3-70b-instruct:free',
        'deepseek/deepseek-r1:free'
      ];
    } else {
      // NVIDIA NIM
      const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data && Array.isArray(data.data)) {
          const list = data.data
            .map((m: any) => m.id)
            .filter((id: string) => id && !RETIRED_NVIDIA_MODELS.includes(id));
          if (list.length > 0) return list;
        }
      }
      return PREFERRED_NVIDIA_MODELS;
    }
  } catch {
    return provider === 'openrouter'
      ? ['openrouter/free', 'openai/gpt-oss-120b:free']
      : PREFERRED_NVIDIA_MODELS;
  }
}

/**
 * Checks whether the current Forge configuration and auth state is usable.
 */
export async function checkConfigurationStatus(options?: SetupOptions): Promise<ConfigStatus> {
  const cfgPath = options?.configPath || getConfigPath();
  const authPath = options?.authPath || getAuthPath();

  const hasConfigFile = fs.existsSync(cfgPath);
  const hasAuthFile = fs.existsSync(authPath);

  const config = loadSetupConfig(options?.configPath);
  const auth = loadSetupAuth(options?.authPath);

  const openrouterKey = options?.authPath
    ? auth.openrouterApiKey
    : process.env.OPENROUTER_API_KEY || auth.openrouterApiKey;

  const nvidiaKey = options?.authPath
    ? auth.nvidiaApiKey
    : process.env.NVIDIA_API_KEY || auth.nvidiaApiKey;

  // 1. Fresh first-run check: No config, no auth, no environment keys
  if (!hasConfigFile && !hasAuthFile && !openrouterKey && !nvidiaKey) {
    return { status: 'FIRST_RUN', isFirstRun: true };
  }

  const provider = config.defaultProvider || 'openrouter';
  if (provider !== 'openrouter' && provider !== 'nvidia') {
    return { status: 'FIRST_RUN', isFirstRun: !hasConfigFile };
  }

  // 2. Check API key for selected provider
  const currentKey = provider === 'openrouter' ? openrouterKey : nvidiaKey;
  if (!currentKey || !currentKey.trim()) {
    return {
      status: 'MISSING_KEY',
      provider,
      isFirstRun: !hasConfigFile && !hasAuthFile
    };
  }

  // 3. Check default model
  const model = config.defaultModel;
  if (!model || !model.trim()) {
    return {
      status: 'MISSING_MODEL',
      provider,
      apiKey: currentKey
    };
  }

  // 4. Validate API key if requested
  if (options?.validateKeyFn) {
    const valResult = await options.validateKeyFn(provider, currentKey);
    if (!valResult.valid && !valResult.isNetworkError) {
      return {
        status: 'INVALID_KEY',
        provider,
        model,
        apiKey: currentKey,
        error: valResult.error
      };
    }
  }

  return {
    status: 'VALID',
    provider,
    model,
    apiKey: currentKey
  };
}

/**
 * Runs the interactive setup flow to configure provider, API key, and model.
 */
export async function runSetup(options?: SetupOptions): Promise<void> {
  const ask = (q: string) => promptText(q, options?.promptFn);
  const askMasked = (q: string) => promptMasked(q, options?.maskedPromptFn);
  const validator = options?.validateKeyFn || validateProviderApiKey;
  const modelFetcher = options?.fetchModelsFn || fetchModelsForProvider;

  console.log('\n============================================================');
  console.log('  ⚡ Welcome to Forge — Autonomous Coding Agent Setup');
  console.log('============================================================\n');

  const currentConfig = loadSetupConfig(options?.configPath);
  const currentAuth = loadSetupAuth(options?.authPath);

  let selectedProvider: 'openrouter' | 'nvidia' = currentConfig.defaultProvider || 'openrouter';
  let apiKey = '';

  // --- Step 1: Provider Selection ---
  while (true) {
    console.log('Select an AI Provider:');
    console.log('  [1] OpenRouter (Free & tool-capable models, OpenAI, Anthropic, DeepSeek, etc.)');
    console.log('  [2] NVIDIA NIM (High-speed inference, Llama 3.3, Nemotron, DeepSeek)');

    const defaultNum = selectedProvider === 'nvidia' ? '2' : '1';
    const choice = await ask(`\nEnter choice [1-2] (default: ${defaultNum}): `);

    const cleanChoice = choice || defaultNum;
    if (cleanChoice === '1' || cleanChoice.toLowerCase() === 'openrouter') {
      selectedProvider = 'openrouter';
      break;
    } else if (cleanChoice === '2' || cleanChoice.toLowerCase() === 'nvidia') {
      selectedProvider = 'nvidia';
      break;
    } else {
      console.log('\x1b[31mInvalid choice. Please enter 1 or 2.\x1b[0m\n');
    }
  }

  console.log(`\nSelected provider: \x1b[36m${selectedProvider}\x1b[0m\n`);

  // --- Step 2: API Key Prompt & Validation ---
  const existingKey =
    selectedProvider === 'openrouter'
      ? options?.authPath
        ? currentAuth.openrouterApiKey
        : process.env.OPENROUTER_API_KEY || currentAuth.openrouterApiKey
      : options?.authPath
      ? currentAuth.nvidiaApiKey
      : process.env.NVIDIA_API_KEY || currentAuth.nvidiaApiKey;

  while (true) {
    const keyHint =
      selectedProvider === 'openrouter' ? 'sk-or-v1-...' : 'nvapi-...';
    const promptMsg = existingKey
      ? `Enter ${selectedProvider === 'openrouter' ? 'OpenRouter' : 'NVIDIA'} API Key (${keyHint}) [press Enter to keep existing]: `
      : `Enter ${selectedProvider === 'openrouter' ? 'OpenRouter' : 'NVIDIA'} API Key (${keyHint}): `;

    const entered = await askMasked(promptMsg);
    apiKey = entered || existingKey || '';

    if (!apiKey) {
      console.log('\x1b[31mError: API key is required.\x1b[0m\n');
      continue;
    }

    console.log('\nValidating API key...');
    const valResult = await validator(selectedProvider, apiKey);

    if (valResult.valid) {
      console.log('\x1b[32m✓ API key validated successfully!\x1b[0m\n');
      break;
    }

    if (valResult.isNetworkError) {
      console.log(`\x1b[33m⚠️ Could not verify key online (${valResult.error}).\x1b[0m`);
      const proceed = await ask('Proceed and save this key anyway? (y/n): ');
      if (proceed.toLowerCase() === 'y' || proceed.toLowerCase() === 'yes') {
        break;
      }
      continue;
    }

    console.log(`\x1b[31m✗ Invalid API key: ${valResult.error || 'Unauthorized'}\x1b[0m\n`);
    console.log('What would you like to do?');
    console.log('  [1] Re-enter API key');
    console.log('  [2] Switch provider');
    console.log('  [3] Exit setup');

    const nextAction = await ask('\nEnter choice [1-3] (default: 1): ');
    const act = nextAction || '1';
    if (act === '2') {
      selectedProvider = selectedProvider === 'openrouter' ? 'nvidia' : 'openrouter';
      console.log(`\nSwitched provider to: \x1b[36m${selectedProvider}\x1b[0m\n`);
      continue;
    } else if (act === '3') {
      console.log('Setup aborted.');
      process.exit(0);
    }
  }

  // Save auth credentials
  if (selectedProvider === 'openrouter') {
    saveSetupAuth({ openrouterApiKey: apiKey }, options?.authPath);
    if (!options?.authPath) {
      process.env.OPENROUTER_API_KEY = apiKey;
    }
  } else {
    saveSetupAuth({ nvidiaApiKey: apiKey }, options?.authPath);
    if (!options?.authPath) {
      process.env.NVIDIA_API_KEY = apiKey;
    }
  }

  // --- Step 3: Fetch Available Models & Select Default ---
  console.log('Fetching available models...');
  const availableModels = await modelFetcher(selectedProvider, apiKey);

  if (!options?.configPath) {
    if (selectedProvider === 'openrouter') {
      saveModelsCache({ openrouter: availableModels.map((id) => ({ id, provider: 'openrouter' })) });
    } else {
      saveModelsCache({ nvidia: availableModels.map((id) => ({ id, provider: 'nvidia' })) });
    }
  }

  const defaultRecommended =
    selectedProvider === 'openrouter'
      ? 'openrouter/free'
      : 'nvidia/nemotron-3-super-120b-a12b';

  console.log(`\nAvailable models for ${selectedProvider}:`);
  const displayModels = availableModels.slice(0, 8);
  displayModels.forEach((m, idx) => {
    const isRec = m === defaultRecommended ? ' (Recommended)' : '';
    console.log(`  [${idx + 1}] ${m}${isRec}`);
  });
  console.log('  [c] Enter custom model name');

  let selectedModel = defaultRecommended;
  while (true) {
    const modelChoice = await ask(`\nSelect default model [1-${displayModels.length} or c] (default: 1): `);
    const clean = modelChoice || '1';

    if (clean.toLowerCase() === 'c') {
      const custom = await ask('Enter custom model ID: ');
      if (custom) {
        selectedModel = custom;
        break;
      }
    } else {
      const num = parseInt(clean, 10);
      if (!isNaN(num) && num >= 1 && num <= displayModels.length) {
        selectedModel = displayModels[num - 1];
        break;
      } else if (clean === '1') {
        selectedModel = displayModels[0] || defaultRecommended;
        break;
      } else {
        console.log('\x1b[31mInvalid choice. Please enter a valid number or "c".\x1b[0m');
      }
    }
  }

  console.log(`\nSelected default model: \x1b[32m${selectedModel}\x1b[0m`);

  // Build fallback sequence
  const fallbackModels =
    selectedProvider === 'openrouter'
      ? ['openai/gpt-oss-120b:free', 'nvidia/nemotron-3-super-120b-a12b']
      : ['nvidia/nemotron-3-ultra-550b-a55b', 'openrouter/free'];

  // Save configuration
  saveSetupConfig(
    {
      defaultProvider: selectedProvider,
      defaultModel: selectedModel,
      fallbackModels
    },
    options?.configPath
  );

  console.log('\n============================================================');
  console.log('  ✓ Forge setup completed successfully!');
  console.log(`  • Provider: ${selectedProvider}`);
  console.log(`  • Model:    ${selectedModel}`);
  console.log(`  • Config:   ${options?.configPath || '~/.forge/config.json'}`);
  console.log(`  • Auth:     ${options?.authPath || '~/.forge/auth.json'}`);
  console.log('============================================================\n');

  // Launch agent if launch callback provided
  if (options?.launchTuiFn) {
    await options.launchTuiFn();
  }
}

/**
 * Checks configuration status and runs setup flow if missing or invalid.
 * If running in a headless/non-interactive context, exits with a clear error
 * directing the user to run `forge setup`.
 */
export async function runSetupIfNeeded(options?: {
  isHeadless?: boolean;
  setupOptions?: SetupOptions;
  launchTuiFn?: () => Promise<void>;
}): Promise<boolean> {
  const checkOpts = options?.setupOptions || {};
  const status = await checkConfigurationStatus(checkOpts);

  if (status.status === 'VALID') {
    return false;
  }

  // Non-interactive or headless check
  const isHeadless =
    options?.isHeadless !== undefined ? options.isHeadless : !process.stdin.isTTY;

  if (isHeadless) {
    console.error('\n\x1b[31mError: No valid provider or API key configured.\x1b[0m');
    console.error('Please run \x1b[36mforge setup\x1b[0m to configure Forge before running tasks.\n');
    process.exit(1);
  }

  // Interactive recovery based on status
  if (status.status === 'MISSING_KEY' && status.provider) {
    console.log(`\n\x1b[33mProvider "${status.provider}" is configured, but the API key is missing.\x1b[0m`);
    await runSetup({
      ...options?.setupOptions,
      launchTuiFn: options?.launchTuiFn
    });
    return true;
  }

  if (status.status === 'INVALID_KEY' && status.provider) {
    console.log(`\n\x1b[31mThe API key for "${status.provider}" is invalid: ${status.error || 'Unauthorized'}\x1b[0m`);
    await runSetup({
      ...options?.setupOptions,
      launchTuiFn: options?.launchTuiFn
    });
    return true;
  }

  if (status.status === 'MISSING_MODEL') {
    console.log(`\n\x1b[33mNo default model configured for "${status.provider}".\x1b[0m`);
    await runSetup({
      ...options?.setupOptions,
      launchTuiFn: options?.launchTuiFn
    });
    return true;
  }

  // Full first-run setup
  await runSetup({
    ...options?.setupOptions,
    launchTuiFn: options?.launchTuiFn
  });
  return true;
}
