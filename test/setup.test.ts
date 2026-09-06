import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkConfigurationStatus,
  runSetup,
  runSetupIfNeeded,
  validateProviderApiKey,
  fetchModelsForProvider,
  promptText,
  promptMasked
} from '../src/setup.js';
import { ForgeConfig, AuthConfig, DEFAULT_CONFIG } from '../src/config.js';

describe('Forge First-Run Setup & Configuration Suite', () => {
  let tempDir: string;
  let tempConfigPath: string;
  let tempAuthPath: string;
  let originalEnvOpenRouter: string | undefined;
  let originalEnvNvidia: string | undefined;

  beforeEach(() => {
    // Isolate environment
    originalEnvOpenRouter = process.env.OPENROUTER_API_KEY;
    originalEnvNvidia = process.env.NVIDIA_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.NVIDIA_API_KEY;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-test-'));
    tempConfigPath = path.join(tempDir, 'config.json');
    tempAuthPath = path.join(tempDir, 'auth.json');
  });

  afterEach(() => {
    // Restore environment
    if (originalEnvOpenRouter !== undefined) {
      process.env.OPENROUTER_API_KEY = originalEnvOpenRouter;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }

    if (originalEnvNvidia !== undefined) {
      process.env.NVIDIA_API_KEY = originalEnvNvidia;
    } else {
      delete process.env.NVIDIA_API_KEY;
    }

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

    vi.restoreAllMocks();
  });

  // --- 1. First-Run Detection ---

  it('1. detects first-run when no config, auth, or env keys exist', async () => {
    const status = await checkConfigurationStatus({
      configPath: tempConfigPath,
      authPath: tempAuthPath
    });

    expect(status.status).toBe('FIRST_RUN');
    expect(status.isFirstRun).toBe(true);
  });

  // --- 2. Valid Existing Configuration ---

  it('2. detects valid configuration and skips setup completely', async () => {
    // Setup valid config and auth files
    const config: ForgeConfig = {
      ...DEFAULT_CONFIG,
      defaultProvider: 'openrouter',
      defaultModel: 'openrouter/free'
    };
    fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));

    const auth: AuthConfig = {
      openrouterApiKey: 'sk-or-v1-valid-key-1234567890'
    };
    fs.writeFileSync(tempAuthPath, JSON.stringify(auth, null, 2));

    const status = await checkConfigurationStatus({
      configPath: tempConfigPath,
      authPath: tempAuthPath
    });

    expect(status.status).toBe('VALID');
    expect(status.provider).toBe('openrouter');
    expect(status.model).toBe('openrouter/free');
    expect(status.apiKey).toBe('sk-or-v1-valid-key-1234567890');

    // runSetupIfNeeded should return false without prompting
    const promptMock = vi.fn();
    const needed = await runSetupIfNeeded({
      setupOptions: {
        configPath: tempConfigPath,
        authPath: tempAuthPath,
        promptFn: promptMock
      }
    });

    expect(needed).toBe(false);
    expect(promptMock).not.toHaveBeenCalled();
  });

  // --- 3. Missing API Key ---

  it('3. detects missing API key when provider is configured and prompts to configure it', async () => {
    const config: ForgeConfig = {
      ...DEFAULT_CONFIG,
      defaultProvider: 'nvidia',
      defaultModel: 'nvidia/nemotron-3-super-120b-a12b'
    };
    fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));
    // Auth file exists but lacks nvidiaApiKey
    fs.writeFileSync(tempAuthPath, JSON.stringify({ openrouterApiKey: 'other-key' }, null, 2));

    const status = await checkConfigurationStatus({
      configPath: tempConfigPath,
      authPath: tempAuthPath
    });

    expect(status.status).toBe('MISSING_KEY');
    expect(status.provider).toBe('nvidia');

    // Run setup flow with simulated inputs
    const inputs = [
      '2', // select NVIDIA
      '1'  // select first model
    ];
    let inputIndex = 0;
    const promptFn = async () => inputs[inputIndex++] || '';
    const maskedPromptFn = async () => 'nvapi-valid-test-key';

    const validateKeyFn = vi.fn().mockResolvedValue({ valid: true });
    const fetchModelsFn = vi.fn().mockResolvedValue(['nvidia/nemotron-3-super-120b-a12b']);

    await runSetup({
      configPath: tempConfigPath,
      authPath: tempAuthPath,
      promptFn,
      maskedPromptFn,
      validateKeyFn,
      fetchModelsFn
    });

    // Verify key was saved and config updated
    expect(validateKeyFn).toHaveBeenCalledWith('nvidia', 'nvapi-valid-test-key');
    const savedAuth = JSON.parse(fs.readFileSync(tempAuthPath, 'utf8'));
    expect(savedAuth.nvidiaApiKey).toBe('nvapi-valid-test-key');
    const savedConfig = JSON.parse(fs.readFileSync(tempConfigPath, 'utf8'));
    expect(savedConfig.defaultProvider).toBe('nvidia');
  });

  // --- 4. Missing Model ---

  it('4. detects missing model and prompts user to select one', async () => {
    const config: ForgeConfig = {
      ...DEFAULT_CONFIG,
      defaultProvider: 'openrouter',
      defaultModel: '' // Empty model
    };
    fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));
    fs.writeFileSync(tempAuthPath, JSON.stringify({ openrouterApiKey: 'sk-or-v1-my-key' }, null, 2));

    const status = await checkConfigurationStatus({
      configPath: tempConfigPath,
      authPath: tempAuthPath
    });

    expect(status.status).toBe('MISSING_MODEL');
    expect(status.provider).toBe('openrouter');

    // Run setup to pick a model
    const inputs = [
      '1', // Provider: OpenRouter
      '2'  // Pick model #2 (openai/gpt-oss-120b:free)
    ];
    let inputIndex = 0;
    const promptFn = async () => inputs[inputIndex++] || '';
    const maskedPromptFn = async () => ''; // Enter to keep existing key

    const validateKeyFn = vi.fn().mockResolvedValue({ valid: true });
    const fetchModelsFn = vi.fn().mockResolvedValue([
      'openrouter/free',
      'openai/gpt-oss-120b:free'
    ]);

    await runSetup({
      configPath: tempConfigPath,
      authPath: tempAuthPath,
      promptFn,
      maskedPromptFn,
      validateKeyFn,
      fetchModelsFn
    });

    const savedConfig = JSON.parse(fs.readFileSync(tempConfigPath, 'utf8'));
    expect(savedConfig.defaultModel).toBe('openai/gpt-oss-120b:free');
  });

  // --- 5. Invalid API Key & Retry Flow ---

  it('5. handles invalid API key with retry flow and successful re-entry', async () => {
    // Validation returns false first, then true on second key
    const validateKeyFn = vi
      .fn()
      .mockResolvedValueOnce({ valid: false, error: 'Unauthorized: Invalid key' })
      .mockResolvedValueOnce({ valid: true });

    const fetchModelsFn = vi.fn().mockResolvedValue(['openrouter/free']);

    const prompts = [
      '1', // Provider: OpenRouter
      '1', // Action after invalid key: [1] Re-enter API key
      '1'  // Default model choice: 1
    ];
    let promptIndex = 0;
    const promptFn = async () => prompts[promptIndex++] || '';

    const maskedKeys = [
      'sk-bad-key',
      'sk-good-key'
    ];
    let keyIndex = 0;
    const maskedPromptFn = async () => maskedKeys[keyIndex++] || '';

    await runSetup({
      configPath: tempConfigPath,
      authPath: tempAuthPath,
      promptFn,
      maskedPromptFn,
      validateKeyFn,
      fetchModelsFn
    });

    expect(validateKeyFn).toHaveBeenCalledTimes(2);
    expect(validateKeyFn).toHaveBeenNthCalledWith(1, 'openrouter', 'sk-bad-key');
    expect(validateKeyFn).toHaveBeenNthCalledWith(2, 'openrouter', 'sk-good-key');

    const savedAuth = JSON.parse(fs.readFileSync(tempAuthPath, 'utf8'));
    expect(savedAuth.openrouterApiKey).toBe('sk-good-key');
  });

  // --- 6. forge setup Command ---

  it('6. runs explicit forge setup to reconfigure provider and models at any time', async () => {
    // Initial config: OpenRouter
    fs.writeFileSync(
      tempConfigPath,
      JSON.stringify({ defaultProvider: 'openrouter', defaultModel: 'openrouter/free' }, null, 2)
    );
    fs.writeFileSync(tempAuthPath, JSON.stringify({ openrouterApiKey: 'old-key' }, null, 2));

    // Reconfigure to NVIDIA NIM with a custom model
    const prompts = [
      '2',                    // Switch to NVIDIA NIM
      'c',                    // Custom model
      'nvidia/custom-model-70b' // Custom model ID
    ];
    let pIdx = 0;
    const promptFn = async () => prompts[pIdx++] || '';
    const maskedPromptFn = async () => 'nvapi-new-key-xyz';

    const validateKeyFn = vi.fn().mockResolvedValue({ valid: true });
    const fetchModelsFn = vi.fn().mockResolvedValue(['nvidia/nemotron-3-super-120b-a12b']);
    const launchMock = vi.fn().mockResolvedValue(undefined);

    await runSetup({
      configPath: tempConfigPath,
      authPath: tempAuthPath,
      promptFn,
      maskedPromptFn,
      validateKeyFn,
      fetchModelsFn,
      launchTuiFn: launchMock
    });

    const savedConfig = JSON.parse(fs.readFileSync(tempConfigPath, 'utf8'));
    expect(savedConfig.defaultProvider).toBe('nvidia');
    expect(savedConfig.defaultModel).toBe('nvidia/custom-model-70b');

    const savedAuth = JSON.parse(fs.readFileSync(tempAuthPath, 'utf8'));
    expect(savedAuth.nvidiaApiKey).toBe('nvapi-new-key-xyz');

    expect(launchMock).toHaveBeenCalled();
  });

  // --- 7. forge ui Setup Behavior ---

  it('7. forge ui triggers first-run setup when unconfigured, then starts server & TUI', async () => {
    let setupRunCount = 0;
    const validateKeyFn = vi.fn().mockResolvedValue({ valid: true });
    const fetchModelsFn = vi.fn().mockResolvedValue(['openrouter/free']);

    const promptFn = async () => '1';
    const maskedPromptFn = async () => 'sk-or-v1-my-key';

    // Verify setup is needed on empty config
    const needed = await runSetupIfNeeded({
      isHeadless: false,
      setupOptions: {
        configPath: tempConfigPath,
        authPath: tempAuthPath,
        promptFn,
        maskedPromptFn,
        validateKeyFn,
        fetchModelsFn
      }
    });

    expect(needed).toBe(true);

    // Now verify second invocation detects valid config and skips setup
    const neededSecondTime = await runSetupIfNeeded({
      isHeadless: false,
      setupOptions: {
        configPath: tempConfigPath,
        authPath: tempAuthPath
      }
    });

    expect(neededSecondTime).toBe(false);
  });

  // --- 8. Headless forge run Behavior ---

  it('8. headless forge run exits with clear error without entering interactive setup', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit: ${code}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runSetupIfNeeded({
        isHeadless: true,
        setupOptions: {
          configPath: tempConfigPath,
          authPath: tempAuthPath
        }
      })
    ).rejects.toThrow('process.exit: 1');

    expect(errorSpy).toHaveBeenCalled();
    const allErrors = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allErrors).toContain('No valid provider or API key configured');
    expect(allErrors).toContain('forge setup');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // --- 9. Utility Tests ---

  it('9. promptText and promptMasked fallback to provided callbacks gracefully', async () => {
    const textResult = await promptText('Test: ', async () => 'sample text');
    expect(textResult).toBe('sample text');

    const maskedResult = await promptMasked('Secret: ', async () => 'sample secret');
    expect(maskedResult).toBe('sample secret');
  });

  it('10. validateProviderApiKey handles empty keys properly', async () => {
    const result = await validateProviderApiKey('openrouter', '');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cannot be empty');
  });

  it('11. fetchModelsForProvider returns defaults on network failure', async () => {
    // Unreachable domain to trigger network fallback
    const models = await fetchModelsForProvider('openrouter', 'any-key');
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain('openrouter/free');
  });
});
