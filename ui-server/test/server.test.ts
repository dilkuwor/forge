import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, RunningServer } from '../src/server.js';
import { maskApiKey, ForgeAdapter } from '../src/forge-adapter.js';
import { formatTokens, resolveModelContextLimit } from '../src/token-utils.js';

describe('Forge UI Server API & Security Test Suite', () => {
  let serverInstance: RunningServer;
  let baseUrl: string;

  beforeAll(async () => {
    // Start on available test port
    serverInstance = await startServer({
      port: 4899,
      host: '127.0.0.1',
      openBrowser: false
    });
    baseUrl = serverInstance.url;
  });

  afterAll(async () => {
    if (serverInstance) {
      await serverInstance.close();
    }
  });

  // --- Security Tests ---

  it('1. verifies server binds to 127.0.0.1 by default', () => {
    expect(serverInstance.host).toBe('127.0.0.1');
    expect(serverInstance.url).toContain('127.0.0.1');
  });

  it('2. verifies API keys are masked and NEVER returned in plain text', async () => {
    const res = await fetch(`${baseUrl}/api/providers`);
    expect(res.status).toBe(200);
    const providers = (await res.json()) as any[];

    for (const p of providers) {
      if (p.keyMasked) {
        expect(p.keyMasked).toMatch(/^•{8,}/);
        expect(p.keyMasked).not.toContain('sk-');
      }
    }
  });

  it('3. maskApiKey helper masks sensitive keys cleanly', () => {
    expect(maskApiKey('')).toBe(null);
    expect(maskApiKey(undefined)).toBe(null);
    expect(maskApiKey('short')).toBe('••••••••');
    expect(maskApiKey('sk-or-v1-abcdef1234567890')).toBe('••••••••••••7890');
  });

  it('4. prevents path traversal attacks when viewing diffs', async () => {
    const res = await fetch(`${baseUrl}/api/diff?file=../../../../etc/passwd`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error).toContain('outside project boundary');
  });

  it('5. prevents path traversal attacks when reverting files', async () => {
    const res = await fetch(`${baseUrl}/api/files/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: '../../evil.ts' })
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error).toContain('Invalid file path');
  });

  // --- API Endpoint Tests ---

  it('6. GET /api/status returns valid agent status schema', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const status = (await res.json()) as any;

    expect(status).toHaveProperty('isRunning');
    expect(status).toHaveProperty('isPaused');
    expect(status).toHaveProperty('status');
    expect(status).toHaveProperty('currentModel');
    expect(status).toHaveProperty('currentProvider');
    expect(status).toHaveProperty('step');
    expect(status).toHaveProperty('maxSteps');
    expect(status).toHaveProperty('toolCount');
    expect(status).toHaveProperty('filesChangedCount');
  });

  it('7. GET /api/sessions returns session history list', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as any;
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('8. GET /api/files returns git status array', async () => {
    const res = await fetch(`${baseUrl}/api/files`);
    expect(res.status).toBe(200);
    const files = (await res.json()) as any;
    expect(Array.isArray(files)).toBe(true);
  });

  it('9. GET /api/diff returns diff text', async () => {
    const res = await fetch(`${baseUrl}/api/diff`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('diff');
    expect(typeof body.diff).toBe('string');
  });

  it('10. GET /api/models returns model configuration and fallback chain', async () => {
    const res = await fetch(`${baseUrl}/api/models`);
    expect(res.status).toBe(200);
    const models = (await res.json()) as any;
    expect(models).toHaveProperty('defaultModel');
    expect(models).toHaveProperty('fallbackModels');
    expect(Array.isArray(models.fallbackModels)).toBe(true);
    expect(models).toHaveProperty('openrouter');
    expect(models).toHaveProperty('nvidia');
  });

  it('11. POST /api/models/fallback updates fallback sequence', async () => {
    const newFallbacks = ['nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-120b:free'];
    const res = await fetch(`${baseUrl}/api/models/fallback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fallbackModels: newFallbacks })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.fallbackModels).toEqual(newFallbacks);
  });

  it('12. GET /api/settings and POST /api/settings update agent configuration', async () => {
    const getRes = await fetch(`${baseUrl}/api/settings`);
    expect(getRes.status).toBe(200);
    const settings = (await getRes.json()) as any;
    expect(settings).toHaveProperty('maxSteps');
    expect(settings).toHaveProperty('confirm');
    expect(settings.security.blockEnv).toBe(true);

    const postRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxSteps: 35 })
    });
    expect(postRes.status).toBe(200);
    const updated = (await postRes.json()) as any;
    expect(updated.settings.maxSteps).toBe(35);
  });

  it('13. GET /api/permissions returns locked security policies', async () => {
    const res = await fetch(`${baseUrl}/api/permissions`);
    expect(res.status).toBe(200);
    const perms = (await res.json()) as any;
    expect(perms).toHaveProperty('protectedAssets');
    expect(perms.protectedAssets.length).toBeGreaterThanOrEqual(4);
    expect(perms.protectedAssets.every((p: any) => p.locked === true)).toBe(true);
    expect(perms.bashExecution.allowlist).toContain('npm test');
  });

  it('14. POST /api/agent/pause, resume, stop work cleanly', async () => {
    const pauseRes = await fetch(`${baseUrl}/api/agent/pause`, { method: 'POST' });
    expect(pauseRes.status).toBe(200);

    const resumeRes = await fetch(`${baseUrl}/api/agent/resume`, { method: 'POST' });
    expect(resumeRes.status).toBe(200);

    const stopRes = await fetch(`${baseUrl}/api/agent/stop`, { method: 'POST' });
    expect(stopRes.status).toBe(200);
  });

  it('15. POST /api/files/revert-forge operates safely on session-scoped files', async () => {
    const revertRes = await fetch(`${baseUrl}/api/files/revert-forge`, { method: 'POST' });
    expect(revertRes.status).toBe(200);
    const body = (await revertRes.json()) as any;
    expect(body.success).toBe(true);
    expect(body.revertedCount).toBe(0);
  });

  it('16. WebSocket /ws connects and receives init payload', async () => {
    const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws';
    const ws = new WebSocket(wsUrl);

    const receivedInit = await new Promise<boolean>((resolve) => {
      ws.on('open', () => {
        // Connected
      });
      ws.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'init') {
            resolve(true);
          }
        } catch {
          // ignore
        }
      });
      setTimeout(() => resolve(false), 2000);
    });

    ws.close();
    expect(receivedInit).toBe(true);
  });

  // --- Token & Context Monitoring Tests ---

  it('17. GET /api/status returns valid tokenUsage and compactions schemas', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const status = (await res.json()) as any;

    expect(status).toHaveProperty('tokenUsage');
    expect(status.tokenUsage).toHaveProperty('inputTokens');
    expect(status.tokenUsage).toHaveProperty('outputTokens');
    expect(status.tokenUsage).toHaveProperty('totalTokens');
    expect(status.tokenUsage).toHaveProperty('currentContextTokens');
    expect(status.tokenUsage).toHaveProperty('modelContextLimit');
    expect(status.tokenUsage).toHaveProperty('utilizationPercent');
    expect(status.tokenUsage).toHaveProperty('estimatedRemainingTokens');
    expect(status.tokenUsage).toHaveProperty('isActual');
    expect(typeof status.tokenUsage.isActual).toBe('boolean');

    expect(status).toHaveProperty('compactions');
    expect(status.compactions).toHaveProperty('count');
    expect(status.compactions).toHaveProperty('totalTokensFreed');
    expect(typeof status.compactions.count).toBe('number');
  });

  it('18. GET /api/sessions returns session items with tokenUsage and compactionsCount', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as any[];
    expect(Array.isArray(sessions)).toBe(true);

    if (sessions.length > 0) {
      const s = sessions[0];
      expect(s).toHaveProperty('tokenUsage');
      expect(s.tokenUsage).toHaveProperty('totalTokens');
      expect(s.tokenUsage).toHaveProperty('currentContextTokens');
      expect(s.tokenUsage).toHaveProperty('modelContextLimit');
      expect(s.tokenUsage).toHaveProperty('utilizationPercent');
      expect(s).toHaveProperty('compactionsCount');
      expect(typeof s.compactionsCount).toBe('number');
    }
  });

  it('19. formatTokens and resolveModelContextLimit format numbers and resolve known limits', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(450)).toBe('450');
    expect(formatTokens(1200)).toBe('1.2K');
    expect(formatTokens(81000)).toBe('81K');
    expect(formatTokens(120000)).toBe('120K');
    expect(formatTokens(1500000)).toBe('1.5M');

    expect(resolveModelContextLimit('openrouter/free')).toBe(131072);
    expect(resolveModelContextLimit('nvidia/nemotron-3-super-120b-a12b')).toBe(131072);
    expect(resolveModelContextLimit('openai/gpt-4o')).toBe(128000);
    expect(resolveModelContextLimit('anthropic/claude-3.5-sonnet')).toBe(200000);
    expect(resolveModelContextLimit('unknown-model')).toBe(32768);
  });

  it('20. ForgeAdapter tracks actual/estimated token usage and compaction events properly', () => {
    const adapter = new ForgeAdapter(process.cwd());

    // Initially 0 usage, not actual
    const initialStatus = adapter.getStatus();
    expect(initialStatus.tokenUsage.totalTokens).toBe(0);
    expect(initialStatus.tokenUsage.isActual).toBe(false);

    // Record step with real provider usage data
    adapter.recordStepTokenUsage(
      {
        text: 'Hello world',
        usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600 }
      },
      450,
      'openrouter/free'
    );

    const updated = adapter.getStatus();
    expect(updated.tokenUsage.inputTokens).toBe(500);
    expect(updated.tokenUsage.outputTokens).toBe(100);
    expect(updated.tokenUsage.totalTokens).toBe(600);
    expect(updated.tokenUsage.currentContextTokens).toBe(600);
    expect(updated.tokenUsage.isActual).toBe(true);
    expect(updated.tokenUsage.modelContextLimit).toBe(131072);
    expect(updated.tokenUsage.estimatedRemainingTokens).toBe(131072 - 600);

    // Simulate compaction event
    (adapter as any).handleAgentEvent({
      type: 'compact',
      tokensBefore: 81000,
      tokensAfter: 34000
    });

    const compacted = adapter.getStatus();
    expect(compacted.compactions.count).toBe(1);
    expect(compacted.compactions.lastTokensBefore).toBe(81000);
    expect(compacted.compactions.lastTokensAfter).toBe(34000);
    expect(compacted.compactions.lastTokensFreed).toBe(47000);
    expect(compacted.compactions.totalTokensFreed).toBe(47000);
    expect(compacted.tokenUsage.currentContextTokens).toBe(34000);
  });
});
