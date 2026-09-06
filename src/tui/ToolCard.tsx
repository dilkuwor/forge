import React from 'react';
import { Box, Text } from 'ink';

export interface ToolCardProps {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: 'running' | 'done' | 'error' | 'denied';
  /** Compact rendering for history (single line + short result). */
  compact?: boolean;
}

export function summarizeToolArgs(name: string, args: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'read_file': {
      const range = args.start || args.end ? `:${args.start ?? 1}-${args.end ?? ''}` : '';
      return `${s(args.path)}${range}`;
    }
    case 'write_file':
    case 'edit_file':
    case 'list_dir':
      return s(args.path) || '.';
    case 'glob':
      return s(args.pattern);
    case 'grep':
      return `${s(args.pattern)}${args.glob ? ` (${s(args.glob)})` : ''}`;
    case 'bash':
      return s(args.command);
    case 'todo':
      return Array.isArray(args.items) ? `${args.items.length} items` : '';
    default:
      return JSON.stringify(args).slice(0, 80);
  }
}

export const ToolCard: React.FC<ToolCardProps> = ({ name, args, result, status, compact }) => {
  const isError = status === 'error';
  const isDenied = status === 'denied';
  const isRunning = status === 'running';

  const color = isDenied ? 'yellow' : isError ? 'red' : isRunning ? 'yellow' : 'green';
  const icon = isDenied ? '⊘' : isError ? '✖' : isRunning ? '…' : '✔';
  const detail = summarizeToolArgs(name, args);
  const maxDetail = compact ? 70 : 90;

  const resultText = result
    ? result.length > (compact ? 160 : 400)
      ? result.slice(0, compact ? 160 : 400) + '…'
      : result
    : '';

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Box>
        <Text color={color}>{icon} </Text>
        <Text bold color="cyan">
          {name}
        </Text>
        {detail ? (
          <Text color="gray"> {detail.length > maxDetail ? detail.slice(0, maxDetail) + '…' : detail}</Text>
        ) : null}
      </Box>
      {resultText && (!compact || isError || isDenied) ? (
        <Box marginLeft={2}>
          <Text color={isError || isDenied ? color : 'gray'} wrap="truncate-end">
            {resultText.split('\n').slice(0, compact ? 2 : 6).join('\n')}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};
