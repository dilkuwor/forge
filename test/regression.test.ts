import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentLoop } from '../src/agent/loop.js';
import { ModelRouter } from '../src/providers/router.js';
import { ProviderClient, ChatOptions, ChatResponse } from '../src/providers/types.js';
import { executeToolDetailed, executeTool } from '../src/tools/index.js';
import {
  validateFilePath,
  isBashCommandDenied,
  isSensitiveRelativePath,
  SecurityError
} from '../src/tools/security.js';
import {
  loadConfig,
  saveConfig,
  loadAuth,
  saveAuth,
  getAuthPath,
  getConfigPath,
  getForgeDir,
  DEFAULT_CONFIG
} from '../src/config.js';
import { compactHistory, estimateHistoryTokens } from '../src/agent/compact.js';
import { todoStore } from '../src/todo.js';

describe('Forge Final QA & Regression Suite', () => {
  let tempDir: string;
  let originalForgeHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-regression-'));
    originalForgeHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = path.join(tempDir, '.forge');
    fs.mkdirSync(process.env.FORGE_HOME, { recursive: true });
  });

  afterEach(() => {
    if (originalForgeHome !== undefined) {
      process.env.FORGE_HOME = originalForgeHome;
    } else {
      delete process.env.FORGE_HOME;
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // -------------------------------------------------------------------------
  // 1. Cancellation (AbortSignal)
  // -------------------------------------------------------------------------
  describe('1. Cancellation & Signal Handling', () => {
    it('aborts during model streaming and returns cancelled outcome with partial text', async () => {
      const controller = new AbortController();
      let streamedChunks = 0;

      const mockProvider: ProviderClient = {
        name: 'openrouter',
        fetchModels: async () => ['openrouter/free'],
        chat: async (options: ChatOptions): Promise<ChatResponse> => {
          if (options.onEvent) {
            options.onEvent({ type: 'text', text: 'Starting to work...' });
            streamedChunks++;
          }
          // Abort during the call
          controller.abort();
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
      };

      const loop = new AgentLoop({
        projectRoot: tempDir,
        router: new ModelRouter({ openrouter: mockProvider }),
        model: 'openrouter/free'
      });

      let cancelledEventReceived = false;
      const result = await loop.runTask('Do something long', {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'cancelled') {
            cancelledEventReceived = true;
          }
        }
      });

      expect(result.outcome).toBe('cancelled');
      expect(cancelledEventReceived).toBe(true);
      expect(streamedChunks).toBe(1);

      // Verify session history preserved partial text with interrupted flag
      const events = loop.session.readAll();
      const assistantEvent = events.find((e) => e.type === 'assistant');
      expect(assistantEvent).toBeDefined();
      expect(assistantEvent?.data?.interrupted).toBe(true);
    });

    it('cancels remaining tool calls cleanly when signal is aborted', async () => {
      const controller = new AbortController();
      let firstToolExecuted = false;

      const mockProvider: ProviderClient = {
        name: 'openrouter',
        fetchModels: async () => ['openrouter/free'],
        chat: async (): Promise<ChatResponse> => {
          return {
            text: 'I will run two tools.',
            thinking: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'read_file',
                arguments: JSON.stringify({ path: 'README.md' })
              },
              {
                id: 'call_2',
                name: 'read_file',
                arguments: JSON.stringify({ path: 'LICENSE' })
              }
            ]
          };
        }
      };

      fs.writeFileSync(path.join(tempDir, 'README.md'), 'Hello World');

      const loop = new AgentLoop({
        projectRoot: tempDir,
        router: new ModelRouter({ openrouter: mockProvider }),
        model: 'openrouter/free'
      });

      // Abort after first tool call starts
      await loop.runTask('Run two tools', {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'tool_call_start' && event.id === 'call_1') {
            firstToolExecuted = true;
            controller.abort();
          }
        }
      });

      expect(firstToolExecuted).toBe(true);
      // Verify both tool calls have paired result messages in history
      const messages = loop.getMessages();
      const toolMessages = messages.filter((m) => m.role === 'tool');
      expect(toolMessages.length).toBe(2);
      expect(toolMessages[0].tool_call_id).toBe('call_1');
      expect(toolMessages[1].tool_call_id).toBe('call_2');
      expect(toolMessages[1].content).toContain('Cancelled by user');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Tool Call & Result Pairing Invariants
  // -------------------------------------------------------------------------
  describe('2. Tool Call & Tool Result Pairing', () => {
    it('strictly maintains 1-to-1 pairing and ordering for multiple tool calls', async () => {
      fs.writeFileSync(path.join(tempDir, 'a.txt'), 'content a');
      fs.writeFileSync(path.join(tempDir, 'b.txt'), 'content b');

      let step = 0;
      const mockProvider: ProviderClient = {
        name: 'openrouter',
        fetchModels: async () => ['openrouter/free'],
        chat: async (): Promise<ChatResponse> => {
          step++;
          if (step === 1) {
            return {
              text: 'Reading files',
              thinking: '',
              toolCalls: [
                { id: 'call_a', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
                { id: 'call_b', name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) }
              ]
            };
          }
          return { text: 'Done reading both', thinking: '', toolCalls: [] };
        }
      };

      const loop = new AgentLoop({
        projectRoot: tempDir,
        router: new ModelRouter({ openrouter: mockProvider }),
        model: 'openrouter/free'
      });

      await loop.run('Read a and b');
      const messages = loop.getMessages();

      // Find assistant message with tool calls
      const assistantIdx = messages.findIndex((m) => m.role === 'assistant' && m.tool_calls?.length === 2);
      expect(assistantIdx).toBeGreaterThan(-1);

      // The next two messages must be role: tool with matching IDs
      const tool1 = messages[assistantIdx + 1];
      const tool2 = messages[assistantIdx + 2];
      expect(tool1.role).toBe('tool');
      expect(tool1.tool_call_id).toBe('call_a');
      expect(tool1.content).toContain('content a');

      expect(tool2.role).toBe('tool');
      expect(tool2.tool_call_id).toBe('call_b');
      expect(tool2.content).toContain('content b');
    });

    it('creates a proper tool result error message when arguments are malformed JSON', async () => {
      let step = 0;
      const mockProvider: ProviderClient = {
        name: 'openrouter',
        fetchModels: async () => ['openrouter/free'],
        chat: async (): Promise<ChatResponse> => {
          step++;
          if (step === 1) {
            return {
              text: 'Running with broken args',
              thinking: '',
              toolCalls: [
                { id: 'call_broken', name: 'read_file', arguments: '{invalid-json' }
              ]
            };
          }
          return { text: 'Handled error', thinking: '', toolCalls: [] };
        }
      };

      const loop = new AgentLoop({
        projectRoot: tempDir,
        router: new ModelRouter({ openrouter: mockProvider }),
        model: 'openrouter/free'
      });

      await loop.run('Test broken json');
      const messages = loop.getMessages();
      const toolMsg = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_broken');
      expect(toolMsg).toBeDefined();
      expect(toolMsg?.content).toContain('could not parse arguments');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Security & Path Validation Edge Cases
  // -------------------------------------------------------------------------
  describe('3. Security & Path Validation', () => {
    it('blocks null byte injections in file paths', () => {
      expect(() => validateFilePath('safe.txt\0/escape', tempDir)).toThrow(SecurityError);
    });

    it('blocks directory traversal attempts using dot-dot', () => {
      expect(() => validateFilePath('../../../etc/passwd', tempDir)).toThrow(SecurityError);
      expect(() => validateFilePath('sub/../../outside.txt', tempDir)).toThrow(SecurityError);
    });

    it('blocks sensitive files across project hierarchy', () => {
      const sensitiveList = [
        '.env',
        '.env.local',
        '.env.production',
        '.forge/auth.json',
        'sub/.forge/auth.json',
        'secrets/id_rsa',
        'config/cert.pem',
        'deploy.key'
      ];
      for (const p of sensitiveList) {
        expect(() => validateFilePath(p, tempDir), p).toThrow(/sensitive/);
        expect(isSensitiveRelativePath(p), p).toBe(true);
      }
    });

    it('explicitly allows safe exceptions: .env.example and .forge/project.md', () => {
      expect(isSensitiveRelativePath('.env.example')).toBe(false);
      expect(isSensitiveRelativePath('.forge/project.md')).toBe(false);
      expect(() => validateFilePath('.env.example', tempDir)).not.toThrow();
      expect(() => validateFilePath('.forge/project.md', tempDir)).not.toThrow();
    });

    it('blocks dangerous bash commands in deny list', () => {
      expect(isBashCommandDenied('rm -rf /')).toBe(true);
      expect(isBashCommandDenied('sudo rm -rf node_modules')).toBe(true);
      expect(isBashCommandDenied('cat .env')).toBe(true);
      expect(isBashCommandDenied('cat ~/.ssh/id_rsa')).toBe(true);
      expect(isBashCommandDenied('cat ~/.forge/auth.json')).toBe(true);
      expect(isBashCommandDenied(':(){ :|:& };:')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Non-TTY & Headless Behavior
  // -------------------------------------------------------------------------
  describe('4. Non-TTY & Headless Auto-Approval', () => {
    it('auto-approves tool execution when confirm config is disabled (headless -y)', async () => {
      let promptCalled = false;
      const ctx = {
        projectRoot: tempDir,
        allowedFiles: new Set<string>(),
        confirmConfig: { edit: false, bash: false },
        touchedFiles: new Set<string>(),
        onConfirm: async () => {
          promptCalled = true;
          return true;
        }
      };

      const res = await executeToolDetailed('write_file', { path: 'created.txt', content: 'hello' }, ctx);
      expect(res.isError).toBe(false);
      expect(promptCalled).toBe(false);
      expect(fs.readFileSync(path.join(tempDir, 'created.txt'), 'utf8')).toBe('hello');
    });

    it('respects denial without hanging when user or non-TTY denier rejects', async () => {
      let promptCalled = false;
      const ctx = {
        projectRoot: tempDir,
        allowedFiles: new Set<string>(),
        confirmConfig: { edit: true, bash: true },
        touchedFiles: new Set<string>(),
        onConfirm: async () => {
          promptCalled = true;
          return false; // Denied
        }
      };

      await expect(executeTool('write_file', { path: 'blocked.txt', content: 'hello' }, ctx)).rejects.toThrow(
        /denied/i
      );
      expect(promptCalled).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'blocked.txt'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Provider Errors & Model Router Fallback
  // -------------------------------------------------------------------------
  describe('5. Provider Error Resilience & Recovery', () => {
    it('retries on 429 rate limit error with exponential backoff and succeeds', async () => {
      let attempts = 0;
      const rateLimitedProvider: ProviderClient = {
        name: 'openrouter',
        fetchModels: async () => ['openrouter/free'],
        chat: async (): Promise<ChatResponse> => {
          attempts++;
          if (attempts === 1) {
            const err = new Error('Rate limit exceeded');
            (err as any).status = 429;
            throw err;
          }
          return { text: 'Recovered from 429!', thinking: '', toolCalls: [] };
        }
      };

      const router = new ModelRouter({ openrouter: rateLimitedProvider });
      const resp = await router.chat({
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'test rate limit' }]
      });

      expect(attempts).toBe(2);
      expect(resp.text).toBe('Recovered from 429!');
    });

    it('falls back to next model when current model does not support tool calling', async () => {
      let model1Attempts = 0;
      let model2Attempts = 0;

      const mockProvider: ProviderClient = {
        name: 'openrouter',
        fetchModels: async () => ['model-without-tools', 'model-with-tools'],
        chat: async (options: ChatOptions): Promise<ChatResponse> => {
          if (options.model === 'model-without-tools') {
            model1Attempts++;
            const err = new Error('This model does not support tools or function calling');
            (err as any).code = 'tools_not_supported';
            throw err;
          }
          model2Attempts++;
          return {
            text: 'I support tools!',
            thinking: '',
            toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: '{}' }]
          };
        }
      };

      // Save config with fallback
      saveConfig({
        defaultProvider: 'openrouter',
        defaultModel: 'model-without-tools',
        fallbackModels: ['model-with-tools']
      });

      const router = new ModelRouter({ openrouter: mockProvider });
      const resp = await router.chat({
        model: 'model-without-tools',
        messages: [{ role: 'user', content: 'run tool' }],
        tools: [{ type: 'function', function: { name: 'read_file' } }]
      });

      expect(model1Attempts).toBe(1);
      expect(model2Attempts).toBe(1);
      expect(resp.finalModel).toBe('model-with-tools');
      expect(resp.text).toBe('I support tools!');
    });

    it('allows custom mock providers to bypass missing environment API keys', async () => {
      // Ensure no environment keys exist
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.NVIDIA_API_KEY;

      const mockProvider: ProviderClient = {
        name: 'openrouter',
        fetchModels: async () => ['openrouter/free'],
        chat: async () => ({ text: 'Custom provider success', thinking: '', toolCalls: [] })
      };

      const router = new ModelRouter({ openrouter: mockProvider });
      const resp = await router.chat({
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'test' }]
      });

      expect(resp.text).toBe('Custom provider success');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Config & Auth Safety
  // -------------------------------------------------------------------------
  describe('6. Configuration & Auth File Safety', () => {
    it('sets restrictive file mode 0o600 on auth.json credentials', () => {
      saveAuth({ openrouterApiKey: 'sk-test-secret-key-123' });
      const authFile = getAuthPath();
      expect(fs.existsSync(authFile)).toBe(true);

      const stats = fs.statSync(authFile);
      // Permissions should be 0o600 (owner read/write only)
      expect(stats.mode & 0o777).toBe(0o600);

      const loaded = loadAuth();
      expect(loaded.openrouterApiKey).toBe('sk-test-secret-key-123');
    });

    it('returns empty auth safely if auth.json is corrupted JSON', () => {
      const authFile = getAuthPath();
      fs.writeFileSync(authFile, '{corrupted-json-data', 'utf8');

      const loaded = loadAuth();
      expect(loaded).toEqual({});
    });

    it('applies defaults when config.json has invalid fields or corrupted data', () => {
      const configFile = getConfigPath();
      fs.writeFileSync(configFile, JSON.stringify({ maxSteps: -5, defaultProvider: 'invalid' }), 'utf8');

      const config = loadConfig();
      expect(config.maxSteps).toBe(DEFAULT_CONFIG.maxSteps);
      expect(config.defaultProvider).toBe(DEFAULT_CONFIG.defaultProvider);
    });
  });

  // -------------------------------------------------------------------------
  // 7. History & Compaction Invariants
  // -------------------------------------------------------------------------
  describe('7. Context History & Compaction', () => {
    it('does not compact if token count is below threshold', () => {
      const messages = [
        { role: 'system' as const, content: 'System prompt' },
        { role: 'user' as const, content: 'Short user question' },
        { role: 'assistant' as const, content: 'Short answer' }
      ];

      const res = compactHistory(messages, 8000, 0.7);
      expect(res.compacted).toBe(false);
      expect(res.messages.length).toBe(3);
    });

    it('preserves system prompt and recent turns when compacting large history', () => {
      const messages: any[] = [
        { role: 'system', content: 'Base system instructions' },
        { role: 'user', content: 'Initial project task' }
      ];

      for (let i = 0; i < 20; i++) {
        messages.push({
          role: 'assistant',
          content: `Assistant message turn ${i} ` + 'word '.repeat(100)
        });
        messages.push({
          role: 'user',
          content: `User feedback turn ${i} ` + 'word '.repeat(50)
        });
      }

      // Add recent turn that must be preserved
      messages.push({ role: 'user', content: 'Most recent user prompt' });
      messages.push({ role: 'assistant', content: 'Most recent assistant response' });

      const res = compactHistory(messages, 1500, 0.5, 2);
      expect(res.compacted).toBe(true);
      expect(res.tokensAfter).toBeLessThan(res.tokensBefore);

      // System message preserved
      expect(res.messages[0].role).toBe('system');
      expect(res.messages[0].content).toBe('Base system instructions');

      // Summary message injected
      const summaryMsg = res.messages.find((m) => m.content?.includes('[CONVERSATION HISTORY COMPACTED'));
      expect(summaryMsg).toBeDefined();

      // Recent turns preserved at the end
      const lastMsg = res.messages[res.messages.length - 1];
      expect(lastMsg.content).toBe('Most recent assistant response');
    });
  });

  // -------------------------------------------------------------------------
  // 8. Todo Store Persistence
  // -------------------------------------------------------------------------
  describe('8. Todo Store Persistence', () => {
    it('persists todos to disk and survives store reload', () => {
      const todo1 = todoStore.add('First regression task');
      const todo2 = todoStore.add('Second regression task');

      expect(todoStore.list().length).toBe(2);

      // Verify file exists in FORGE_HOME
      const todoFile = path.join(getForgeDir(), 'todos.json');
      expect(fs.existsSync(todoFile)).toBe(true);

      // Toggle first task
      const toggled = todoStore.toggleDone(todo1.id);
      expect(toggled?.done).toBe(true);

      // Remove second task
      const removed = todoStore.remove(todo2.id);
      expect(removed).toBe(true);

      // Final list has only first task marked done
      const list = todoStore.list();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(todo1.id);
      expect(list[0].done).toBe(true);
    });

    it('handles corrupted todos.json gracefully', () => {
      const todoFile = path.join(getForgeDir(), 'todos.json');
      fs.writeFileSync(todoFile, 'not-json-content', 'utf8');

      // Does not crash, returns empty list
      expect(todoStore.list()).toEqual([]);

      // Adding after corruption resets cleanly
      const added = todoStore.add('Recovered task');
      expect(added.text).toBe('Recovered task');
      expect(todoStore.list().length).toBe(1);
    });
  });
});
