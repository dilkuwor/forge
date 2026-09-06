import readline from 'node:readline';
import { AgentLoop } from './agent/loop.js';
import {
  loadConfig,
  saveConfig,
  loadAuth,
  saveAuth,
  loadModelsCache,
  getOpenRouterKey,
  getNvidiaKey
} from './config.js';
import { ModelRouter } from './providers/router.js';
import { startTUI } from './tui/index.js';

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function handleLogin(provider: string, explicitKey?: string) {
  const p = provider.toLowerCase();
  if (p !== 'openrouter' && p !== 'nvidia') {
    console.error(`Unknown provider "${provider}". Supported: openrouter, nvidia`);
    process.exit(1);
  }

  let key = explicitKey;
  if (!key) {
    key = await askQuestion(`Enter ${p === 'openrouter' ? 'OpenRouter' : 'NVIDIA'} API Key: `);
  }

  if (!key) {
    console.error('No API key provided.');
    process.exit(1);
  }

  if (p === 'openrouter') {
    saveAuth({ openrouterApiKey: key });
    console.log('Saved OpenRouter API key to ~/.rcd/auth.json');
  } else {
    saveAuth({ nvidiaApiKey: key });
    console.log('Saved NVIDIA API key to ~/.rcd/auth.json');
  }

  console.log('Fetching live models...');
  const router = new ModelRouter();
  try {
    if (p === 'openrouter') {
      const models = await router.openrouter.fetchModels();
      console.log(`Cached ${models.length} free/tool OpenRouter models in ~/.rcd/models-cache.json`);
    } else {
      const models = await router.nvidia.fetchModels();
      console.log(`Cached ${models.length} live NVIDIA NIM models in ~/.rcd/models-cache.json`);
    }
  } catch (err: any) {
    console.warn(`Warning: could not fetch models immediately (${err.message}). Cached defaults will be used.`);
  }
}

async function handleModelsCommand() {
  const router = new ModelRouter();
  const config = loadConfig();

  // Try refreshing cache in background or fetch if empty
  await router.initBootCache().catch(() => {});

  const cache = loadModelsCache();
  console.log('\n=== routercode (rcd) Models ===\n');
  console.log(`Default Provider: ${config.defaultProvider}`);
  console.log(`Default Model:    ${config.defaultModel}`);
  console.log(`Fallback Models:  ${config.fallbackModels.join(' -> ')}\n`);

  console.log('OpenRouter (Free / Tool Supported):');
  if (cache.openrouter.length === 0) {
    console.log('  (no cached models - run `rcd login openrouter` to refresh)');
  } else {
    for (const m of cache.openrouter) {
      console.log(`  • ${m.id} ${m.name && m.name !== m.id ? `(${m.name})` : ''}`);
    }
  }

  console.log('\nNVIDIA NIM (Live Models):');
  if (cache.nvidia.length === 0) {
    console.log('  (no cached models - run `rcd login nvidia` to refresh)');
  } else {
    for (const m of cache.nvidia) {
      console.log(`  • ${m.id}`);
    }
  }

  if (cache.deadModels.length > 0) {
    console.log('\nRetired / Dead Models:');
    for (const m of cache.deadModels) {
      console.log(`  x ${m}`);
    }
  }
  console.log('');
}

async function handleRunCommand(task: string) {
  if (!task || !task.trim()) {
    console.error('Error: task argument required. Example: rcd run "what does this repo do?"');
    process.exit(1);
  }

  const config = loadConfig();
  const router = new ModelRouter();

  // Boot cache update non-blocking
  router.initBootCache().catch(() => {});

  const loop = new AgentLoop({
    router,
    projectRoot: process.cwd()
  });

  const isInteractive = process.stdin.isTTY;

  const onConfirm = async (prompt: { type: 'file' | 'bash'; target: string }): Promise<boolean> => {
    if (!isInteractive) {
      // If headless non-interactive, check config
      return true;
    }
    const ans = await askQuestion(
      `\n[Confirm] Allow ${prompt.type === 'file' ? 'edit/write to' : 'bash command'}: "${prompt.target}"? (y/n): `
    );
    return ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes';
  };

  try {
    await loop.run(task, {
      onConfirm,
      onEvent: (event) => {
        if (event.type === 'text') {
          process.stdout.write(event.text);
        } else if (event.type === 'tool_call_start') {
          const detail =
            event.args.path ||
            event.args.command ||
            event.args.pattern ||
            (event.args.items ? `${event.args.items.length} items` : '');
          console.log(`\n\x1b[36m⚙ [tool: ${event.name}]\x1b[0m ${detail}`);
        } else if (event.type === 'tool_call_result') {
          const summary =
            event.result.length > 250
              ? event.result.slice(0, 250) + '\n... (truncated)'
              : event.result;
          console.log(`\x1b[90m${summary}\x1b[0m\n`);
        } else if (event.type === 'compact') {
          console.log(
            `\x1b[33m⚡ Context compacted (${event.tokensBefore} -> ${event.tokensAfter} tokens)\x1b[0m`
          );
        } else if (event.type === 'status') {
          console.log(`\x1b[35mℹ ${event.message}\x1b[0m`);
        } else if (event.type === 'error') {
          console.error(`\x1b[31m✖ Error: ${event.error.message}\x1b[0m`);
        }
      }
    });
    console.log('');
  } catch (err: any) {
    console.error(`\x1b[31mFatal error: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
routercode (rcd) - Terminal coding agent

USAGE:
  rcd                     Start interactive TUI in current directory
  rcd run "<task>"        Run a task headless without TUI
  rcd login openrouter    Set OpenRouter API key and cache free/tool models
  rcd login nvidia        Set NVIDIA NIM API key and cache live models
  rcd models              List available/cached models and fallbacks
  rcd --help              Show this help message

TUI SLASH COMMANDS:
  /models                 List cached models
  /provider               Switch or view provider (/provider openrouter|nvidia)
  /new                    Start a new session
  /compact                Compact history context
  /diff                   Show git diff
  /stop                   Stop currently running agent loop
`);
}

export async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'start') {
    // Start TUI
    await startTUI();
    return;
  }

  if (command === 'run') {
    const task = args.slice(1).join(' ');
    await handleRunCommand(task);
    return;
  }

  if (command === 'login') {
    const provider = args[1];
    const key = args[2];
    if (!provider) {
      console.error('Usage: rcd login <openrouter|nvidia> [apiKey]');
      process.exit(1);
    }
    await handleLogin(provider, key);
    return;
  }

  if (command === 'models') {
    await handleModelsCommand();
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log('routercode (rcd) v0.1.0');
    return;
  }

  // If unrecognized command, treat the entire line as a task if no flag, or show help
  if (command.startsWith('-')) {
    console.error(`Unknown option: ${command}`);
    printHelp();
    process.exit(1);
  } else {
    // Convenience: `rcd "what does this repo do?"` works like `rcd run "what does this repo do?"` or launches TUI with initial prompt
    await startTUI(args.join(' '));
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
