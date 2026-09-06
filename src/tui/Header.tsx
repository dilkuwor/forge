import React from 'react';
import { Box, Text } from 'ink';
import { VERSION } from '../version.js';

export interface HeaderProps {
  model: string;
  provider: string;
  sessionId: string;
  cwd: string;
  autoApprove?: boolean;
  resumed?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ model, provider, sessionId, cwd, autoApprove, resumed }) => {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0} marginBottom={1}>
      <Box justifyContent="space-between" alignItems="flex-start">
        <Box flexDirection="column">
          <Box>
            <Text bold color="cyan">
              █▀▀ █▀█ █▀█
            </Text>
            <Text bold color="magenta">
              {' '}█▀▀ █▀▀
            </Text>
          </Box>
          <Box>
            <Text bold color="cyan">
              █▀  █▄█ █▀▄
            </Text>
            <Text bold color="magenta">
              {' '}█▄█ ██▄
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column" alignItems="flex-end">
          <Box>
            <Text backgroundColor="cyan" color="black" bold>
              {' forge '}
            </Text>
            <Text color="gray"> v{VERSION} </Text>
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

      <Box>
        <Text color="gray">{'─'.repeat(54)}</Text>
      </Box>

      <Box justifyContent="space-between">
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
          {resumed ? <Text color="magenta"> (resumed)</Text> : null}
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
