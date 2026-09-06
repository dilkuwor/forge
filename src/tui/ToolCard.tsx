import React from 'react';
import { Box, Text } from 'ink';

export interface ToolCardProps {
  id: string;
  name: string;
  args: Record<string, any>;
  result?: string;
  error?: boolean;
  status: 'running' | 'done' | 'error';
}

export const ToolCard: React.FC<ToolCardProps> = ({ name, args, result, status }) => {
  const isError = status === 'error';
  const isRunning = status === 'running';

  const borderColor = isError ? 'red' : isRunning ? 'yellow' : 'green';
  const statusLabel = isError ? '[ERROR]' : isRunning ? '[RUNNING]' : '[DONE]';

  // Summarize main argument
  const detail = args.path || args.command || args.pattern || (args.items ? `${args.items.length} items` : '');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginY={0}>
      <Box>
        <Text bold color={isError ? 'red' : isRunning ? 'yellow' : 'cyan'}>
          tool: {name}
        </Text>
        {detail ? (
          <Text color="gray"> ({typeof detail === 'string' ? detail.slice(0, 60) : JSON.stringify(detail)})</Text>
        ) : null}
        <Box flexGrow={1} />
        <Text color={isError ? 'red' : isRunning ? 'yellow' : 'green'}>{statusLabel}</Text>
      </Box>

      {result ? (
        <Box marginTop={0}>
          <Text color={isError ? 'red' : 'gray'}>
            {result.length > 200 ? result.slice(0, 200) + '...' : result}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};
