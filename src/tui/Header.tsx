import React from 'react';
import { Box, Text } from 'ink';

export interface HeaderProps {
  model: string;
  provider: string;
  sessionId: string;
  cwd: string;
  autoApprove?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  model,
  provider,
  sessionId,
  cwd,
  autoApprove
}) => {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      {/* Top Stylish Logo & Badge */}
      <Box justifyContent="space-between" alignItems="flex-start" marginY={0}>
        <Box flexDirection="column">
          <Box>
            <Text bold color="cyan">
              █▀█ █▀█ █ █ ▀█▀ █▀▀ █▀█
            </Text>
            <Text bold color="magenta">
              {'   '}█▀▀ █▀█ █▀▄ █▀▀
            </Text>
          </Box>
          <Box>
            <Text bold color="cyan">
              █▀▄ █▄█ █▄█  █  ██▄ █▀▄
            </Text>
            <Text bold color="magenta">
              {'   '}█▄▄ █▄█ █▄▀ ██▄
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column" alignItems="flex-end">
          <Box>
            <Text backgroundColor="cyan" color="black" bold>
              {' rcd '}
            </Text>
            <Text color="gray"> v0.1.0 </Text>
            <Text color="yellow">⚡</Text>
          </Box>
          <Box>
            {autoApprove ? (
              <Text backgroundColor="yellow" color="black" bold>
                {' NO-CONFIRM '}
              </Text>
            ) : (
              <Text color="gray" italic>
                Autonomous Coding Agent
              </Text>
            )}
          </Box>
        </Box>
      </Box>

      {/* Divider */}
      <Box marginY={0}>
        <Text color="gray">{'─'.repeat(54)}</Text>
      </Box>

      {/* Metadata Chips */}
      <Box justifyContent="space-between" marginY={0}>
        <Box>
          <Text color="gray">model: </Text>
          <Text bold color="green">
            {model}
          </Text>
          <Text color="gray"> ({provider})</Text>
        </Box>
        <Box>
          <Text color="gray">session: </Text>
          <Text bold color="yellow">
            {sessionId}
          </Text>
        </Box>
      </Box>

      <Box>
        <Text color="gray">workspace: </Text>
        <Text color="white" wrap="truncate">
          {cwd}
        </Text>
      </Box>
    </Box>
  );
};
