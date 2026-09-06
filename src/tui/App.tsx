import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { execSync } from 'node:child_process';
import { Header } from './Header.js';
import { ToolCard } from './ToolCard.js';
import { AgentLoop } from '../agent/loop.js';
import { loadConfig, saveConfig, loadModelsCache, getOpenRouterKey, getNvidiaKey } from '../config.js';
import { compactHistory } from '../agent/compact.js';

interface MessageItem {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'thinking';
  content: string;
}

interface ActiveToolItem {
  id: string;
  name: string;
  args: any;
  result?: string;
  status: 'running' | 'done' | 'error';
}

interface ConfirmationState {
  type: 'file' | 'bash';
  target: string;
  resolve: (value: boolean) => void;
}

export const App: React.FC<{ initialPrompt?: string; noConfirm?: boolean }> = ({
  initialPrompt,
  noConfirm
}) => {
  const { exit } = useApp();
  const config = loadConfig();

  const [confirmConfig, setConfirmConfig] = useState<{ edit: boolean; bash: boolean }>(
    noConfirm ? { edit: false, bash: false } : config.confirm
  );
  const [provider, setProvider] = useState<string>(config.defaultProvider);
  const [model, setModel] = useState<string>(config.defaultModel);
  const [inputVal, setInputVal] = useState<string>('');
  const [status, setStatus] = useState<'idle' | 'running' | 'confirming'>('idle');
  const [statusText, setStatusText] = useState<string>('Ready');

  const [history, setHistory] = useState<MessageItem[]>([]);
  const [activeTools, setActiveTools] = useState<ActiveToolItem[]>([]);
  const [streamingText, setStreamingText] = useState<string>('');
  const [streamingThinking, setStreamingThinking] = useState<string>('');

  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const loopRef = useRef<AgentLoop>(new AgentLoop());
  const currentStepRef = useRef<number>(1);
  const maxStepsRef = useRef<number>(config.maxSteps || 30);

  const cwd = process.cwd();
  const sessionId = loopRef.current.session.id;

  // Run initial prompt if provided
  useEffect(() => {
    if (initialPrompt && initialPrompt.trim()) {
      handleUserSubmit(initialPrompt.trim());
    }
  }, []);

  const handleSlashCommand = async (cmd: string) => {
    const parts = cmd.trim().split(/\s+/);
    const main = parts[0].toLowerCase();
    const arg = parts[1];

    if (main === '/stop') {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        setStatusText('Stopped by user (/stop)');
      }
      return;
    }

    if (main === '/new') {
      if (status === 'running' && abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      loopRef.current = new AgentLoop();
      setHistory([]);
      setActiveTools([]);
      setStreamingText('');
      setStreamingThinking('');
      setStatus('idle');
      setStatusText('Started new session');
      return;
    }

    if (main === '/compact') {
      const messages = loopRef.current.getMessages();
      const res = compactHistory(messages, 32768, 0.0); // force compact
      setHistory((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          type: 'system',
          content: res.compacted
            ? `Manual compaction completed: reduced from ${res.tokensBefore} to ${res.tokensAfter} tokens.`
            : `History is already compact (${res.tokensBefore} tokens).`
        }
      ]);
      return;
    }

    if (main === '/diff') {
      try {
        const diffOutput = execSync('git diff', { encoding: 'utf8', cwd });
        const text = diffOutput.trim() || '(no uncommitted changes in git)';
        setHistory((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            type: 'system',
            content: `--- GIT DIFF ---\n${text}`
          }
        ]);
      } catch (err: any) {
        setHistory((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            type: 'system',
            content: `Git diff failed: ${err.message}`
          }
        ]);
      }
      return;
    }

    if (main === '/models') {
      const cache = loadModelsCache();
      const orModels = cache.openrouter.map((m) => m.id);
      const nvModels = cache.nvidia.map((m) => m.id);
      const text = [
        '--- AVAILABLE MODELS ---',
        `Current model: ${model} (${provider})`,
        '',
        'OpenRouter free/tool models:',
        orModels.length > 0 ? orModels.map((m) => `  • ${m}`).join('\n') : '  (run forge login openrouter to fetch)',
        '',
        'NVIDIA NIM live models:',
        nvModels.length > 0 ? nvModels.map((m) => `  • ${m}`).join('\n') : '  (run forge login nvidia to fetch)',
        '',
        'Dead models:',
        cache.deadModels.map((m) => `  x ${m}`).join('\n')
      ].join('\n');

      setHistory((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          type: 'system',
          content: text
        }
      ]);
      return;
    }

    if (main === '/model') {
      if (arg) {
        const prov = arg.startsWith('nvidia/')
          ? 'nvidia'
          : arg.includes('/')
          ? 'openrouter'
          : (provider as 'openrouter' | 'nvidia');
        saveConfig({ defaultModel: arg, defaultProvider: prov });
        setModel(arg);
        loopRef.current.setModel(arg);
        if (prov !== provider) {
          setProvider(prov);
        }
        setHistory((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            type: 'system',
            content: `Model switched to ${arg} (${prov}).`
          }
        ]);
      } else {
        setHistory((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            type: 'system',
            content: `Current model: ${model} (${provider}). Usage: /model <model-name> (type /models to see available)`
          }
        ]);
      }
      return;
    }

    if (main === '/provider') {
      if (arg === 'openrouter' || arg === 'nvidia') {
        saveConfig({ defaultProvider: arg });
        setProvider(arg);
        setHistory((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            type: 'system',
            content: `Provider switched to ${arg}.`
          }
        ]);
      } else {
        setHistory((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            type: 'system',
            content: `Current provider: ${provider}. Usage: /provider [openrouter|nvidia]`
          }
        ]);
      }
      return;
    }

    if (main === '/confirm' || main === '/yes' || main === '/auto-approve') {
      if (arg === 'off' || main === '/yes' || main === '/auto-approve') {
        setConfirmConfig({ edit: false, bash: false });
        setHistory((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            type: 'system',
            content: 'Auto-Approve enabled (Permission prompts disabled for this session).'
          }
        ]);
      } else if (arg === 'on') {
        setConfirmConfig(config.confirm);
        setHistory((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            type: 'system',
            content: 'Permission prompts enabled.'
          }
        ]);
      } else {
        const isOff = !confirmConfig.edit && !confirmConfig.bash;
        setHistory((prev) => [
          ...prev,
          {
            id: String(Date.now()),
            type: 'system',
            content: `Permission prompts: ${
              isOff ? 'DISABLED (Auto-Approve ON)' : 'ENABLED'
            }. Usage: /confirm [on|off]`
          }
        ]);
      }
      return;
    }

    setHistory((prev) => [
      ...prev,
      {
        id: String(Date.now()),
        type: 'system',
        content: `Unknown slash command: ${main}. Available: /models, /model, /provider, /confirm, /new, /compact, /diff, /stop`
      }
    ]);
  };

  const handleUserSubmit = async (text: string) => {
    if (!text.trim() || status === 'running') return;

    if (text.startsWith('/')) {
      await handleSlashCommand(text);
      return;
    }

    setHistory((prev) => [
      ...prev,
      {
        id: String(Date.now()),
        type: 'user',
        content: text
      }
    ]);

    setStatus('running');
    setStatusText('Thinking & streaming...');
    setStreamingText('');
    setStreamingThinking('');
    setActiveTools([]);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      await loopRef.current.run(text, {
        confirmConfig,
        signal: controller.signal,
        onConfirm: async (prompt) => {
          setStatus('confirming');
          return new Promise<boolean>((resolve) => {
            setConfirmation({
              type: prompt.type,
              target: prompt.target,
              resolve: (val) => {
                setStatus('running');
                setConfirmation(null);
                resolve(val);
              }
            });
          });
        },
        onEvent: (event) => {
          if (event.type === 'text') {
            setStreamingText((prev) => prev + event.text);
            setStatusText(`Step ${currentStepRef.current} of ${maxStepsRef.current} · Streaming response...`);
          } else if (event.type === 'thinking') {
            setStreamingThinking((prev) => prev + event.text);
            setStatusText(`Step ${currentStepRef.current} of ${maxStepsRef.current} · Thinking...`);
          } else if (event.type === 'step_start') {
            currentStepRef.current = event.step;
            maxStepsRef.current = event.maxSteps;
            setStatusText(`Step ${event.step} of ${event.maxSteps} · Contacting model...`);
          } else if (event.type === 'tool_call_start') {
            setStatusText(`Step ${currentStepRef.current} of ${maxStepsRef.current} · Running tool: ${event.name}`);
            setActiveTools((prev) => [
              ...prev,
              {
                id: event.id,
                name: event.name,
                args: event.args,
                status: 'running'
              }
            ]);
          } else if (event.type === 'tool_call_result') {
            setStatusText(
              `Step ${currentStepRef.current} of ${maxStepsRef.current} · ${
                event.error ? 'Tool failed' : 'Tool completed'
              } (${event.name})`
            );
            setActiveTools((prev) =>
              prev.map((t) =>
                t.id === event.id
                  ? {
                      ...t,
                      result: event.result,
                      status: event.error ? 'error' : 'done'
                    }
                  : t
              )
            );
          } else if (event.type === 'compact') {
            setHistory((prev) => [
              ...prev,
              {
                id: String(Date.now()),
                type: 'system',
                content: `History compacted: reduced from ${event.tokensBefore} to ${event.tokensAfter} tokens.`
              }
            ]);
          } else if (event.type === 'status') {
            setStatusText(event.message);
          } else if (event.type === 'done') {
            setStatusText('Finished');
          } else if (event.type === 'error') {
            setStatusText(`Error: ${event.error.message}`);
          }
        }
      });

      setHistory((prev) => {
        const next = [...prev];
        if (streamingThinking) {
          next.push({
            id: String(Date.now() - 1),
            type: 'thinking',
            content: streamingThinking
          });
        }
        if (streamingText) {
          next.push({
            id: String(Date.now()),
            type: 'assistant',
            content: streamingText
          });
        }
        return next;
      });
    } catch (err: any) {
      setHistory((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          type: 'system',
          content: `Error: ${err.message}`
        }
      ]);
    } finally {
      setStatus('idle');
      setStatusText('Ready');
      setStreamingText('');
      setStreamingThinking('');
      abortControllerRef.current = null;
    }
  };

  // Keyboard navigation & Ctrl+C
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (status === 'running' && abortControllerRef.current) {
        abortControllerRef.current.abort();
        setStatusText('Stopped by user (Ctrl+C)');
      } else {
        exit();
      }
      return;
    }

    if (status === 'confirming' && confirmation) {
      if (input.toLowerCase() === 'y' || key.return) {
        confirmation.resolve(true);
      } else if (input.toLowerCase() === 'n' || key.escape) {
        confirmation.resolve(false);
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        model={model}
        provider={provider}
        sessionId={sessionId}
        cwd={cwd}
        autoApprove={!confirmConfig.edit && !confirmConfig.bash}
      />

      {/* Message History */}
      <Box flexDirection="column" marginY={1}>
        {history.map((msg) => (
          <Box key={msg.id} marginY={0} flexDirection="column">
            {msg.type === 'user' ? (
              <Text bold color="green">
                &gt; {msg.content}
              </Text>
            ) : msg.type === 'assistant' ? (
              <Text color="white">{msg.content}</Text>
            ) : msg.type === 'thinking' ? (
              <Text color="gray" italic>
                [thinking: {msg.content.slice(0, 150)}...]
              </Text>
            ) : (
              <Text color="cyan">{msg.content}</Text>
            )}
          </Box>
        ))}

        {/* Current Streaming output */}
        {streamingThinking ? (
          <Box marginY={0}>
            <Text color="gray" italic>
              [thinking] {streamingThinking.slice(-200)}
            </Text>
          </Box>
        ) : null}

        {streamingText ? (
          <Box marginY={0}>
            <Text color="white">{streamingText}</Text>
          </Box>
        ) : null}

        {/* Active Tool Cards */}
        {activeTools.map((tc) => (
          <ToolCard
            key={tc.id}
            id={tc.id}
            name={tc.name}
            args={tc.args}
            result={tc.result}
            status={tc.status}
          />
        ))}
      </Box>

      {/* Confirmation Modal / Bar */}
      {status === 'confirming' && confirmation ? (
        <Box
          borderStyle="double"
          borderColor="yellow"
          paddingX={1}
          marginY={1}
          flexDirection="column"
        >
          <Text bold color="yellow">
            PERMISSION CONFIRMATION REQUIRED
          </Text>
          <Text>
            Allow {confirmation.type === 'file' ? 'file write/edit to' : 'bash command'}:{' '}
            <Text bold color="white">
              {confirmation.target}
            </Text>
            ?
          </Text>
          <Text color="gray">Press [y / Enter] to Allow, [n / Esc] to Deny</Text>
        </Box>
      ) : null}

      {/* Status Line */}
      <Box justifyContent="space-between" marginY={0}>
        <Text color="gray">
          Status: <Text color={status === 'running' ? 'yellow' : 'cyan'}>{statusText}</Text>
        </Text>
        <Text color="gray">
          Type <Text color="yellow">/models</Text>, <Text color="yellow">/model</Text>,{' '}
          <Text color="yellow">/confirm</Text>, <Text color="yellow">/new</Text>,{' '}
          <Text color="yellow">/diff</Text>, <Text color="yellow">/stop</Text> | Ctrl+C to stop/exit
        </Text>
      </Box>

      {/* Input Box */}
      {status !== 'confirming' ? (
        <Box borderStyle="round" borderColor={status === 'running' ? 'gray' : 'cyan'} paddingX={1}>
          <Text bold color="cyan">
            &gt;{' '}
          </Text>
          <TextInput
            value={inputVal}
            onChange={setInputVal}
            onSubmit={(val) => {
              setInputVal('');
              handleUserSubmit(val);
            }}
            focus={status !== 'confirming'}
          />
        </Box>
      ) : null}
    </Box>
  );
};
