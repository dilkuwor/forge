import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

export async function startTUI(initialPrompt?: string): Promise<void> {
  const instance = render(React.createElement(App, { initialPrompt }));
  await instance.waitUntilExit();
}
