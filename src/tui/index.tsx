import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

export interface TUIOptions {
  initialPrompt?: string;
  noConfirm?: boolean;
  uiUrl?: string;
}

export async function startTUI(options?: string | TUIOptions): Promise<void> {
  const opts: TUIOptions =
    typeof options === 'string' ? { initialPrompt: options } : options || {};
  const instance = render(React.createElement(App, opts));
  await instance.waitUntilExit();
}
