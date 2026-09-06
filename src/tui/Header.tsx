import React from 'react';
import { Box, Text } from 'ink';

export interface HeaderProps {
  model: string;
  provider: string;
  sessionId: string;
  cwd: string;
}

export const Header: React.FC<HeaderProps> = ({ model, provider, sessionId, cwd }) => {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1} marginY={0}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          routercode (rcd)
        </Text>
        <Text color="gray">
          session: <Text color="white">{sessionId}</Text>
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color="gray">
          model: <Text color="green">{model}</Text> ({provider})
        </Text>
        <Text color="gray" wrap="truncate">
          dir: <Text color="white">{cwd}</Text>
        </Text>
      </Box>
    </Box>
  );
};
