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
import { todoStore } from './todo.js';

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
    console.log('Saved OpenRouter API key to ~/.forge/auth.json');
  } else {
    saveAuth({ nvidiaApiKey: key });
    console.log('Saved NVIDIA API key to ~/.forge/auth.json');
  }

  console.log('Fetching live models...');
  const router = new ModelRouter();
  try {
    if (p === 'openrouter') {
      const models = await router.openrouter.fetchModels();
      console.log(`Cached ${models.length} free/tool OpenRouter models in ~/.forge/models-cache.json`);
    } else {
      const models = await router.nvidia.fetchModels();
      console.log(`Cached ${models.length} live NVIDIA NIM models in ~/.forge/models-cache.json`);
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
  console.log('\n=== forge Models ===\n');
  console.log(`Default Provider: ${config.defaultProvider}`);
  console.log(`Default Model:    ${config.defaultModel}`);
  console.log(`Fallback Models:  ${config.fallbackModels.join(' -> ')}\n`);

  console.log('OpenRouter (Free / Tool Supported):');
  if (cache.openrouter.length === 0) {
    console.log('  (no cached models - run `forge login openrouter` to refresh)');
  } else {
    for (const m of cache.openrouter) {
      console.log(`  • ${m.id} ${m.name && m.name !== m.id ? `(${m.name})` : ''}`);
    }
  }

  console.log('\nNVIDIA NIM (Live Models):');
  if (cache.nvidia.length === 0) {
    console.log('  (no cached models - run `forge login nvidia` to refresh)');
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

async function handleTodoCommand(subArgs: string[]) {
  const subCommand = subArgs[0];
  if (!subCommand) {
    console.log('Usage: forge todo <add|list|remove|toggle> [args]');
    return;
  }

  switch (subCommand) {
    case 'add': {
      const text = subArgs.slice(1).join(' ');
      if (!text) {
        console.log('Error: todo text required. Example: forge todo add "buy milk"');
        return;
      }
      const todo = todoStore.add(text);
      console.log(`Added todo #${todo.id}: ${todo.text}`);
      break;
    }
    case 'list': {
      const todos = todoStore.list();
      if (todos.length === 0) {
        console.log('No todos.');
      } else {
        console.log('Todos:');
        for (const t of todos) {
          console.log(`  [${t.done ? 'x' : ' '}] ${t.id}: ${t.text}`);
        }
      }
      break;
    }
    case 'remove': {
      const idStr = subArgs[1];
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.log('Error: valid todo id required. Example: forge todo remove 1');
        return;
      }
      const removed = todoStore.remove(id);
      if (removed) {
        console.log(`Removed todo #${id}`);
      } else {
        console.log(`Error: todo #${id} not found`);
      }
      break;
    }
    case 'toggle': {
      const idStr = subArgs[1];
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.log('Error: valid todo id required. Example: forge todo toggle 1');
        return;
      }
      const todo = todoStore.toggleDone(id);
      if (todo) {
        console.log(`Todo #${id} marked as ${todo.done ? 'done' : 'undone'}`);
      } else {
        console.log(`Error: todo #${id} not found`);
      }
      break;
    }
    default:
      console.log(`Unknown todo subcommand: ${subCommand}`);
      console.log('Available subcommands: add, list, remove, toggle');
  }
}

async function handleRunCommand(task: string, options?: { noConfirm?: boolean }) {
  if (!task || !task.trim()) {
    console.error('Error: task argument required. Example: forge run "what does this repo do?"');
    process.exit(1);
  }

  const config = loadConfig();
  const confirmConfig = options?.noConfirm
    ? { edit: false, bash: false }
    : config.confirm;

  const router = new ModelRouter();

  // Boot cache update non-blocking
  router.initBootCache().catch(() => {});

  const loop = new AgentLoop({
    router,
    projectRoot: process.cwd(),
    confirmConfig
  });

  const isInteractive = process.stdin.isTTY && !options?.noConfirm;

  const onConfirm = async (prompt: { type: 'file' | 'bash'; target: string }): Promise<boolean> => {
    if (!isInteractive) {
      // If headless non-interactive or auto-approved
      return true;
    }
    const ans = await askQuestion(
      `\n[Confirm] Allow ${prompt.type === 'file' ? 'edit/write to' : 'bash command'}: "${prompt.target}"? (y/n): `
    );
    return ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes';
  };

  try {
    await loop.run(task, {
      confirmConfig,
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
forge - Terminal coding agent

USAGE:
  forge [-y]                Start interactive TUI (-y for auto-approve / no-confirm)
  forge run "<task>" [-y]   Run a task headless without TUI (-y for auto-approve)
  forge login openrouter    Set OpenRouter API key and cache free/tool models
  forge login nvidia        Set NVIDIA NIM API key and cache live models
  forge models              List available/cached models and fallbacks
  forge todo                Manage in-memory todo list
  forge --help              Show this help message

TUI SLASH COMMANDS:
  /models                 List cached models
  /provider               Switch or view provider (/provider openrouter|nvidia)
  /confirm [on|off]       Toggle auto-approve / permission prompts in current session
  /new                    Start a new session
  /compact                Compact history context
  /diff                   Show git diff
  /stop                   Stop currently running agent loop
`);
}

export async function main() {
  const rawArgs = process.argv.slice(2);
  const noConfirm = rawArgs.some(
    (a) => a === '-y' || a === '--yes' || a === '--no-confirm' || a === '--auto-approve'
  );
  const args = rawArgs.filter(
    (a) => a !== '-y' && a !== '--yes' && a !== '--no-confirm' && a !== '--auto-approve'
  );
  const command = args[0];

  if (!command || command === 'start') {
    // Start TUI
    await startTUI({ noConfirm });
    return;
  }

  if (command === 'run') {
    const task = args.slice(1).join(' ');
    await handleRunCommand(task, { noConfirm });
    return;
  }

  if (command === 'login') {
    const provider = args[1];
    const key = args[2];
    if (!provider) {
      console.error('Usage: forge login <openrouter|nvidia> [apiKey]');
      process.exit(1);
    }
    await handleLogin(provider, key);
    return;
  }

  if (command === 'models') {
    await handleModelsCommand();
    return;
  }

  if (command === 'todo') {
    await handleTodoCommand(args.slice(1));
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log('forge v0.1.0');
    return;
  }

  // If unrecognized command, treat the entire line as a task if no flag, or show help
  if (command.startsWith('-')) {
    console.error(`Unknown option: ${command}`);
    printHelp();
    process.exit(1);
  } else {
    // Convenience: `forge "what does this repo do?"` launches TUI with initial prompt
    await startTUI({ initialPrompt: args.join(' '), noConfirm });
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
