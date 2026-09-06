import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, Static, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { execFileSync } from 'node:child_process';
import { Header } from './Header.js';
import { ToolCard, summarizeToolArgs } from './ToolCard.js';
import { AgentLoop, AgentEvent, TokenUsageSnapshot } from '../agent/loop.js';
import { loadConfig, saveConfig, loadModelsCache, ProviderName } from '../config.js';
import { listSessions } from '../store/session.js';
import { ModelRouter } from '../providers/router.js';
import type { ConfirmRequest } from '../tools/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HistoryItem =
  | { id: number; kind: 'user'; content: string }
  | { id: number; kind: 'assistant'; content: string }
  | { id: number; kind: 'thinking'; content: string }
  | { id: number; kind: 'system'; content: string; tone?: 'info' | 'warn' | 'error' }
  | {
      id: number;
      kind: 'tool';
      toolId: string;
      name: string;
      args: Record<string, unknown>;
      result?: string;
      status: 'running' | 'done' | 'error' | 'denied';
    };

interface ActiveTool {
  toolId: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: 'running' | 'done' | 'error' | 'denied';
}

interface ConfirmationState {
  request: ConfirmRequest;
  resolve: (value: boolean) => void;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type HistoryInput = DistributiveOmit<HistoryItem, 'id'>;

type UiStatus = 'idle' | 'running' | 'confirming';

export interface AppProps {
  initialPrompt?: string;
  noConfirm?: boolean;
  resumeSessionId?: string;
  model?: string;
}

function inferProvider(model: string, fallback: ProviderName): ProviderName {
  if (model.startsWith('openrouter/') || model.includes(':free')) return 'openrouter';
  if (model.startsWith('nvidia/') || model.startsWith('meta/') || model.startsWith('deepseek-ai/')) return 'nvidia';
  return fallback;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const App: React.FC<AppProps> = ({ initialPrompt, noConfirm, resumeSessionId, model: modelOverride }) => {
  const { exit } = useApp();
  const config = loadConfig();
  const cwd = process.cwd();

  const routerRef = useRef<ModelRouter>(new ModelRouter());
  const createLoop = useCallback(
    (resumeId?: string): { loop: AgentLoop; resumed: boolean } => {
      if (resumeId) {
        const resumed = AgentLoop.resume(resumeId, {
          router: routerRef.current,
          projectRoot: cwd,
          model: modelOverride
        });
        if (resumed) return { loop: resumed, resumed: true };
      }
      return {
        loop: new AgentLoop({ router: routerRef.current, projectRoot: cwd, model: modelOverride }),
        resumed: false
      };
    },
    [cwd, modelOverride]
  );

  const initial = useRef(createLoop(resumeSessionId));
  const loopRef = useRef<AgentLoop>(initial.current.loop);

  const [confirmConfig, setConfirmConfig] = useState(noConfirm ? { edit: false, bash: false } : config.confirm);
  const [model, setModel] = useState<string>(loopRef.current.getModel());
  const [provider, setProvider] = useState<ProviderName>(inferProvider(loopRef.current.getModel(), config.defaultProvider));
  const [sessionId, setSessionId] = useState<string>(loopRef.current.session.id);
  const [resumed, setResumed] = useState<boolean>(initial.current.resumed);

  const [inputVal, setInputVal] = useState('');
  const [status, setStatus] = useState<UiStatus>('idle');
  const [statusText, setStatusText] = useState('Ready');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [todos, setTodos] = useState<string[]>([]);
  const [usage, setUsage] = useState<TokenUsageSnapshot | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;
  // Refs mirror streaming state so async callbacks never read stale closures.
  const stepTextRef = useRef('');
  const stepThinkingRef = useRef('');
  const activeToolsRef = useRef<ActiveTool[]>([]);
  const stepRef = useRef({ step: 0, max: config.maxSteps });
  const lastCtrlCRef = useRef(0);
  const statusRef = useRef<UiStatus>('idle');
  statusRef.current = status;

  const pushHistory = useCallback((...items: HistoryInput[]) => {
    setHistory((prev) => [...prev, ...items.map((it) => ({ ...it, id: nextId() }) as HistoryItem)]);
  }, []);

  const sys = useCallback(
    (content: string, tone: 'info' | 'warn' | 'error' = 'info') => pushHistory({ kind: 'system', content, tone }),
    [pushHistory]
  );

  /** Move the current step's live output (thinking, text, tools) into static history. */
  const flushStep = useCallback(() => {
    const items: HistoryInput[] = [];
    if (stepThinkingRef.current.trim()) items.push({ kind: 'thinking', content: stepThinkingRef.current });
    if (stepTextRef.current.trim()) items.push({ kind: 'assistant', content: stepTextRef.current });
    for (const t of activeToolsRef.current) {
      items.push({ kind: 'tool', toolId: t.toolId, name: t.name, args: t.args, result: t.result, status: t.status });
    }
    if (items.length) pushHistory(...items);
    stepTextRef.current = '';
    stepThinkingRef.current = '';
    activeToolsRef.current = [];
    setStreamingText('');
    setStreamingThinking('');
    setActiveTools([]);
  }, [pushHistory]);

  const updateTool = (toolId: string, patch: Partial<ActiveTool>) => {
    activeToolsRef.current = activeToolsRef.current.map((t) => (t.toolId === toolId ? { ...t, ...patch } : t));
    setActiveTools(activeToolsRef.current);
  };

  const stepLabel = () => `Step ${stepRef.current.step}/${stepRef.current.max}`;

  // -------------------------------------------------------------------------
  // Agent events
  // -------------------------------------------------------------------------

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'step_start':
          flushStep();
          stepRef.current = { step: event.step, max: event.maxSteps };
          setStatusText(`${stepLabel()} · Contacting model...`);
          break;
        case 'text':
          stepTextRef.current += event.text;
          setStreamingText(stepTextRef.current);
          setStatusText(`${stepLabel()} · Streaming response...`);
          break;
        case 'thinking':
          stepThinkingRef.current += event.text;
          setStreamingThinking(stepThinkingRef.current);
          setStatusText(`${stepLabel()} · Thinking...`);
          break;
        case 'stream_reset':
          stepTextRef.current = '';
          stepThinkingRef.current = '';
          setStreamingText('');
          setStreamingThinking('');
          break;
        case 'tool_call_start':
          activeToolsRef.current = [
            ...activeToolsRef.current,
            { toolId: event.id, name: event.name, args: event.args, status: 'running' }
          ];
          setActiveTools(activeToolsRef.current);
          setStatusText(`${stepLabel()} · ${event.name} ${summarizeToolArgs(event.name, event.args)}`.slice(0, 100));
          break;
        case 'tool_call_result':
          updateTool(event.id, {
            result: event.result,
            status: event.denied ? 'denied' : event.error ? 'error' : 'done'
          });
          break;
        case 'todos':
          setTodos(event.todos);
          break;
        case 'token_usage':
          setUsage(event.tokenUsage);
          break;
        case 'compact':
          sys(`Context compacted (${fmtTokens(event.tokensBefore)} → ${fmtTokens(event.tokensAfter)} tokens, ${event.reason}).`, 'warn');
          break;
        case 'model_changed':
          setModel(event.to);
          setProvider(inferProvider(event.to, provider));
          sys(`Model switched: ${event.from} → ${event.to}`, 'warn');
          break;
        case 'status':
          sys(event.message, 'info');
          break;
        case 'done':
          flushStep();
          setStatusText('Finished');
          break;
        case 'cancelled':
          flushStep();
          sys('Cancelled.', 'warn');
          setStatusText('Cancelled');
          break;
        case 'error':
          flushStep();
          sys(`Error: ${event.error.message}`, 'error');
          setStatusText('Error');
          break;
        default:
          break;
      }
    },
    [flushStep, sys, provider]
  );

  // -------------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------------

  const switchSession = (resumeId?: string) => {
    if (statusRef.current === 'running' && abortRef.current) abortRef.current.abort();
    const created = createLoop(resumeId);
    if (resumeId && !created.resumed) {
      sys(`Session "${resumeId}" not found. Use /sessions to list.`, 'error');
      return;
    }
    loopRef.current = created.loop;
    setSessionId(created.loop.session.id);
    setResumed(created.resumed);
    setModel(created.loop.getModel());
    // Never shrink `history`: <Static> renders by index and would drop new items.
    pushHistory({ kind: 'system', content: '─'.repeat(40), tone: 'info' });
    setTodos(created.loop.getTodos());
    setUsage(null);
    stepTextRef.current = '';
    stepThinkingRef.current = '';
    activeToolsRef.current = [];
    setStreamingText('');
    setStreamingThinking('');
    setActiveTools([]);
    setStatus('idle');
    if (created.resumed) {
      const turns = created.loop.getMessages().filter((m) => m.role === 'user').length;
      const lastUser = [...created.loop.getMessages()].reverse().find((m) => m.role === 'user');
      sys(`Resumed session ${created.loop.session.id} (${turns} earlier turn${turns === 1 ? '' : 's'}).`);
      if (lastUser?.content) pushHistory({ kind: 'user', content: `(last) ${lastUser.content}` });
      setStatusText('Session resumed');
    } else {
      setStatusText('Started new session');
    }
  };

  const handleSlashCommand = async (cmd: string) => {
    const parts = cmd.trim().split(/\s+/);
    const main = parts[0].toLowerCase();
    const arg = parts[1];

    switch (main) {
      case '/stop':
        if (abortRef.current) {
          abortRef.current.abort();
          setStatusText('Stopping...');
        } else {
          sys('Nothing is running.');
        }
        return;
      case '/exit':
      case '/quit':
        abortRef.current?.abort();
        exit();
        return;
      case '/new':
        switchSession();
        return;
      case '/resume': {
        const id = arg || listSessions(2).find((s) => s.id !== sessionId)?.id;
        if (!id) {
          sys('No previous session to resume.', 'warn');
          return;
        }
        switchSession(id);
        return;
      }
      case '/sessions': {
        const sessions = listSessions(10);
        if (sessions.length === 0) {
          sys('No sessions recorded yet.');
          return;
        }
        sys(
          ['Recent sessions:', ...sessions.map((s) => `  ${s.id}${s.id === sessionId ? ' (current)' : ''}  ${s.title || ''}`), 'Use /resume <id> to resume.'].join('\n')
        );
        return;
      }
      case '/compact': {
        if (statusRef.current === 'running') {
          sys('Cannot compact while the agent is running.', 'warn');
          return;
        }
        const res = loopRef.current.compact(true, handleEvent, 'manual');
        if (!res.compacted) sys(`History is already compact (${fmtTokens(res.tokensBefore)} tokens).`);
        return;
      }
      case '/diff': {
        try {
          const stat = execFileSync('git', ['diff', '--stat'], { encoding: 'utf8', cwd, maxBuffer: 4 * 1024 * 1024 }).trim();
          const diff = execFileSync('git', ['diff'], { encoding: 'utf8', cwd, maxBuffer: 4 * 1024 * 1024 }).trim();
          if (!diff) {
            sys('No uncommitted changes in git.');
            return;
          }
          const lines = diff.split('\n');
          const shown = lines.slice(0, 300).join('\n');
          sys(`--- GIT DIFF ---\n${stat}\n\n${shown}${lines.length > 300 ? `\n... (${lines.length - 300} more lines)` : ''}`);
        } catch (err) {
          sys(`git diff failed: ${(err as Error).message.split('\n')[0]}`, 'error');
        }
        return;
      }
      case '/models': {
        const cache = loadModelsCache();
        const unavailable = routerRef.current.getDeadModels();
        const fmt = (ids: string[]) =>
          ids.length ? ids.map((m) => `  • ${m}${unavailable.has(m) ? ' [unavailable]' : ''}`).join('\n') : '  (none cached — run forge login <provider>)';
        sys(
          [
            `Current model: ${model} (${provider})`,
            '',
            'OpenRouter free/tool models:',
            fmt(cache.openrouter.map((m) => m.id)),
            '',
            'NVIDIA NIM live models:',
            fmt(cache.nvidia.map((m) => m.id))
          ].join('\n')
        );
        return;
      }
      case '/model': {
        if (!arg) {
          sys(`Current model: ${model} (${provider}). Usage: /model <model-name>`);
          return;
        }
        const prov = inferProvider(arg, provider);
        saveConfig({ defaultModel: arg, defaultProvider: prov });
        routerRef.current.clearModelStatus(arg);
        loopRef.current.setModel(arg);
        setModel(arg);
        setProvider(prov);
        sys(`Model switched to ${arg} (${prov}).`);
        return;
      }
      case '/provider': {
        if (arg === 'openrouter' || arg === 'nvidia') {
          saveConfig({ defaultProvider: arg });
          setProvider(arg);
          sys(`Provider switched to ${arg}.`);
        } else {
          sys(`Current provider: ${provider}. Usage: /provider [openrouter|nvidia]`);
        }
        return;
      }
      case '/confirm':
      case '/yes':
      case '/auto-approve': {
        if (arg === 'off' || main !== '/confirm') {
          setConfirmConfig({ edit: false, bash: false });
          sys('Auto-approve enabled (permission prompts disabled for this session).', 'warn');
        } else if (arg === 'on') {
          setConfirmConfig(config.confirm);
          sys('Permission prompts enabled.');
        } else {
          const off = !confirmConfig.edit && !confirmConfig.bash;
          sys(`Permission prompts: ${off ? 'DISABLED (auto-approve ON)' : 'ENABLED'}. Usage: /confirm [on|off]`);
        }
        return;
      }
      case '/help':
        sys('Commands: /models /model <name> /provider /confirm [on|off] /new /resume [id] /sessions /compact /diff /stop /exit');
        return;
      default:
        sys(`Unknown command: ${main}. Type /help for the list.`, 'warn');
    }
  };

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  const handleUserSubmit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/')) {
      await handleSlashCommand(trimmed);
      return;
    }
    if (statusRef.current !== 'idle') {
      sys('Agent is busy — use /stop to cancel first.', 'warn');
      return;
    }

    pushHistory({ kind: 'user', content: trimmed });
    setStatus('running');
    setStatusText('Contacting model...');
    stepTextRef.current = '';
    stepThinkingRef.current = '';
    activeToolsRef.current = [];
    setStreamingText('');
    setStreamingThinking('');
    setActiveTools([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await loopRef.current.runTask(trimmed, {
        confirmConfig,
        signal: controller.signal,
        onConfirm: (request) =>
          new Promise<boolean>((resolve) => {
            setStatus('confirming');
            setConfirmation({
              request,
              resolve: (val) => {
                setConfirmation(null);
                setStatus('running');
                resolve(val);
              }
            });
          }),
        onEvent: handleEvent
      });
    } catch (err) {
      flushStep();
      sys(`Error: ${(err as Error).message}`, 'error');
    } finally {
      abortRef.current = null;
      setConfirmation(null);
      setStatus('idle');
      setStatusText((s) => (s === 'Cancelled' || s === 'Error' ? s : 'Ready'));
    }
  };

  useEffect(() => {
    if (resumed) {
      const msgs = loopRef.current.getMessages();
      const turns = msgs.filter((m) => m.role === 'user').length;
      sys(`Resumed session ${sessionId} (${turns} earlier turn${turns === 1 ? '' : 's'}).`);
    }
    if (initialPrompt && initialPrompt.trim()) {
      void handleUserSubmit(initialPrompt.trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const now = Date.now();
      if (status === 'confirming' && confirmation) {
        confirmation.resolve(false);
        abortRef.current?.abort();
        setStatusText('Cancelled');
        return;
      }
      if (status === 'running') {
        if (now - lastCtrlCRef.current < 1500) {
          exit();
          return;
        }
        lastCtrlCRef.current = now;
        abortRef.current?.abort();
        setStatusText('Cancelling... (Ctrl+C again to quit)');
        return;
      }
      if (inputVal) {
        setInputVal('');
        return;
      }
      exit();
      return;
    }

    if (status === 'confirming' && confirmation) {
      if (input.toLowerCase() === 'y' || key.return) confirmation.resolve(true);
      else if (input.toLowerCase() === 'n' || key.escape) confirmation.resolve(false);
    }
  });

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const autoApprove = !confirmConfig.edit && !confirmConfig.bash;
  const ctxPct = usage && usage.contextWindow ? Math.min(100, Math.round((usage.currentContextTokens / usage.contextWindow) * 100)) : null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Static items={[{ id: -1, kind: 'header' as const }, ...history]}>
        {(item) =>
          item.kind === 'header' ? (
            <Header
              key="header"
              model={model}
              provider={provider}
              sessionId={sessionId}
              cwd={cwd}
              autoApprove={autoApprove}
              resumed={resumed}
            />
          ) : (
            <Box key={item.id} flexDirection="column" marginBottom={item.kind === 'tool' ? 0 : 1}>
              {item.kind === 'user' ? (
                <Text bold color="green">
                  › {item.content}
                </Text>
              ) : item.kind === 'assistant' ? (
                <Text>{item.content.trimEnd()}</Text>
              ) : item.kind === 'thinking' ? (
                <Text color="gray" italic>
                  [thinking: {item.content.replace(/\s+/g, ' ').slice(0, 160)}
                  {item.content.length > 160 ? '…' : ''}]
                </Text>
              ) : item.kind === 'tool' ? (
                <ToolCard id={item.toolId} name={item.name} args={item.args} result={item.result} status={item.status} compact />
              ) : (
                <Text color={item.tone === 'error' ? 'red' : item.tone === 'warn' ? 'yellow' : 'cyan'}>{item.content}</Text>
              )}
            </Box>
          )
        }
      </Static>

      {/* Live region */}
      <Box flexDirection="column">
        {streamingThinking ? (
          <Text color="gray" italic>
            [thinking] {streamingThinking.replace(/\s+/g, ' ').slice(-200)}
          </Text>
        ) : null}
        {streamingText ? <Text>{streamingText}</Text> : null}
        {activeTools.map((tc) => (
          <ToolCard key={tc.toolId} id={tc.toolId} name={tc.name} args={tc.args} result={tc.result} status={tc.status} />
        ))}
      </Box>

      {todos.length > 0 ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color="magenta" bold>
            Todo
          </Text>
          {todos.slice(0, 8).map((t, i) => (
            <Text key={i} color={/^\[x\]/i.test(t) ? 'gray' : 'white'}>
              {t}
            </Text>
          ))}
          {todos.length > 8 ? <Text color="gray">… {todos.length - 8} more</Text> : null}
        </Box>
      ) : null}

      {status === 'confirming' && confirmation ? (
        <Box borderStyle="double" borderColor="yellow" paddingX={1} marginY={1} flexDirection="column">
          <Text bold color="yellow">
            PERMISSION REQUIRED — {confirmation.request.tool}
          </Text>
          <Text>
            {confirmation.request.type === 'file' ? 'Modify file: ' : 'Run command: '}
            <Text bold>{confirmation.request.target}</Text>
          </Text>
          {confirmation.request.preview ? (
            <Box marginTop={1} flexDirection="column">
              {confirmation.request.preview
                .split('\n')
                .slice(0, 20)
                .map((l, i) => (
                  <Text key={i} color={l.startsWith('+') ? 'green' : l.startsWith('-') ? 'red' : 'gray'}>
                    {l}
                  </Text>
                ))}
            </Box>
          ) : null}
          <Text color="gray">[y / Enter] allow · [n / Esc] deny · [Ctrl+C] deny and stop</Text>
        </Box>
      ) : null}

      {/* Status line */}
      <Box justifyContent="space-between" marginTop={1}>
        <Text color="gray">
          <Text color={status === 'running' ? 'yellow' : status === 'confirming' ? 'magenta' : 'cyan'}>{statusText}</Text>
          {'  '}
          <Text color="green">{model}</Text>
          {autoApprove ? <Text color="yellow"> [no-confirm]</Text> : null}
          {' · '}
          <Text color="yellow">{sessionId}</Text>
        </Text>
        <Text color="gray">
          {usage
            ? `ctx ${fmtTokens(usage.currentContextTokens)}/${fmtTokens(usage.contextWindow)}${ctxPct !== null ? ` (${ctxPct}%)` : ''} · in ${fmtTokens(
                usage.inputTokens
              )} out ${fmtTokens(usage.outputTokens)}${usage.isActual ? '' : ' ~'}`
            : '/help for commands · Ctrl+C to stop/exit'}
        </Text>
      </Box>

      {status !== 'confirming' ? (
        <Box borderStyle="round" borderColor={status === 'running' ? 'gray' : 'cyan'} paddingX={1}>
          <Text bold color="cyan">
            ›{' '}
          </Text>
          <TextInput
            value={inputVal}
            onChange={setInputVal}
            onSubmit={(val) => {
              setInputVal('');
              void handleUserSubmit(val);
            }}
            placeholder={status === 'running' ? '/stop to cancel' : 'Ask forge to do something…'}
          />
        </Box>
      ) : null}
    </Box>
  );
};
