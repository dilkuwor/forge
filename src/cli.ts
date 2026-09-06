import readline from 'node:readline';
import { AgentLoop, AgentEvent } from './agent/loop.js';
import { loadConfig, saveAuth, loadModelsCache } from './config.js';
import { ModelRouter } from './providers/router.js';
import { startTUI } from './tui/index.js';
import { todoStore } from './todo.js';
import { runSetup, runSetupIfNeeded } from './setup.js';
import { listSessions } from './store/session.js';
import { ConfirmRequest } from './tools/index.js';
import { VERSION } from './version.js';
import { parseArgs } from './args.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (ans: string) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`
};

function resolveResumeId(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  if (spec !== 'last') return spec;
  const latest = listSessions(1)[0];
  return latest?.id;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function handleLoginCommand(provider?: string, explicitKey?: string) {
  if (!provider) {
    console.log('Usage: forge login <openrouter|nvidia> [api-key]');
    return;
  }
  const p = provider.toLowerCase();
  if (p !== 'openrouter' && p !== 'nvidia') {
    console.error(`Unknown provider "${provider}". Supported: openrouter, nvidia`);
    process.exit(1);
  }

  let key = explicitKey;
  if (!key) {
    if (!process.stdin.isTTY) {
      console.error('No API key provided. Usage: forge login <provider> <api-key>');
      process.exit(1);
    }
    key = await askQuestion(`Enter ${p === 'openrouter' ? 'OpenRouter' : 'NVIDIA'} API Key: `);
  }
  if (!key) {
    console.error('No API key provided.');
    process.exit(1);
  }

  if (p === 'openrouter') {
    saveAuth({ openrouterApiKey: key });
    console.log('Saved OpenRouter API key to ~/.forge/auth.json (mode 0600)');
  } else {
    saveAuth({ nvidiaApiKey: key });
    console.log('Saved NVIDIA API key to ~/.forge/auth.json (mode 0600)');
  }

  console.log('Fetching live models...');
  const router = new ModelRouter();
  try {
    const models =
      p === 'openrouter' ? await router.openrouter.fetchModels() : await router.nvidia.fetchModels();
    console.log(`Cached ${models.length} ${p === 'openrouter' ? 'free/tool OpenRouter' : 'live NVIDIA NIM'} models.`);
  } catch (err) {
    console.warn(`Warning: could not fetch models (${(err as Error).message}). Cached defaults will be used.`);
  }
}

async function handleModelsCommand() {
  const router = new ModelRouter();
  const config = loadConfig();
  await router.initBootCache().catch(() => {});

  const cache = loadModelsCache();
  const unavailable = router.getDeadModels();
  console.log('\n=== forge Models ===\n');
  console.log(`Default Provider: ${config.defaultProvider}`);
  console.log(`Default Model:    ${config.defaultModel}`);
  console.log(`Fallback Models:  ${config.fallbackModels.join(' -> ') || '(none)'}\n`);

  const printList = (title: string, models: typeof cache.openrouter, hint: string) => {
    console.log(title);
    if (models.length === 0) {
      console.log(`  (no cached models - ${hint})`);
    } else {
      for (const m of models) {
        const ctx = m.contextLength ? c.gray(` ${Math.round(m.contextLength / 1000)}k ctx`) : '';
        const flag = unavailable.has(m.id) ? c.red(' [unavailable]') : '';
        console.log(`  • ${m.id}${ctx}${flag}`);
      }
    }
    console.log('');
  };

  printList('OpenRouter (Free / Tool Supported):', cache.openrouter, 'run `forge login openrouter` to refresh');
  printList('NVIDIA NIM (Live Models):', cache.nvidia, 'run `forge login nvidia` to refresh');

  if (cache.deadModels.length > 0) {
    console.log('Retired Models:');
    for (const m of cache.deadModels) console.log(`  x ${m}`);
    console.log('');
  }
  const cooldowns = Object.entries(cache.cooldowns || {}).filter(([, e]) => Date.parse(e.until) > Date.now());
  if (cooldowns.length > 0) {
    console.log('Temporarily unavailable (cooldown):');
    for (const [m, e] of cooldowns) {
      const mins = Math.max(1, Math.round((Date.parse(e.until) - Date.now()) / 60000));
      console.log(`  ~ ${m} ${c.gray(`(retry in ~${mins}m${e.reason ? `: ${e.reason.slice(0, 80)}` : ''})`)}`);
    }
    console.log('');
  }
}

function handleSessionsCommand(limit: number = 20) {
  const sessions = listSessions(limit);
  if (sessions.length === 0) {
    console.log('No sessions recorded yet.');
    return;
  }
  console.log(`\nRecent sessions (${sessions.length}):\n`);
  for (const s of sessions) {
    const when = s.updatedAt || s.createdAt;
    const date = when ? new Date(when).toLocaleString() : '';
    console.log(`  ${c.yellow(s.id)}  ${c.gray(date)}`);
    if (s.title) console.log(`    ${s.title}`);
    if (s.cwd) console.log(`    ${c.gray(`${s.model || '?'} · ${s.cwd}`)}`);
  }
  console.log(`\nResume with: forge --resume <id>   (or: forge -r  for the most recent)\n`);
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
        for (const t of todos) console.log(`  [${t.done ? 'x' : ' '}] ${t.id}: ${t.text}`);
      }
      break;
    }
    case 'remove':
    case 'toggle': {
      const id = parseInt(subArgs[1], 10);
      if (isNaN(id)) {
        console.log(`Error: valid todo id required. Example: forge todo ${subCommand} 1`);
        return;
      }
      if (subCommand === 'remove') {
        console.log(todoStore.remove(id) ? `Removed todo #${id}` : `Error: todo #${id} not found`);
      } else {
        const todo = todoStore.toggleDone(id);
        console.log(todo ? `Todo #${id} marked as ${todo.done ? 'done' : 'undone'}` : `Error: todo #${id} not found`);
      }
      break;
    }
    default:
      console.log(`Unknown todo subcommand: ${subCommand}`);
      console.log('Available subcommands: add, list, remove, toggle');
  }
}

// ---------------------------------------------------------------------------
// Headless run
// ---------------------------------------------------------------------------

export interface HeadlessOptions {
  yes?: boolean;
  resume?: string;
  model?: string;
}

async function handleRunCommand(task: string, options: HeadlessOptions = {}) {
  if (!task || !task.trim()) {
    console.error('Error: task argument required. Example: forge run "what does this repo do?"');
    process.exit(1);
  }

  const config = loadConfig();
  const confirmConfig = options.yes ? { edit: false, bash: false } : config.confirm;
  const isInteractive = Boolean(process.stdin.isTTY);

  const router = new ModelRouter();
  router.initBootCache().catch(() => {});

  let loop: AgentLoop | null = null;
  const resumeId = resolveResumeId(options.resume);
  if (options.resume) {
    if (!resumeId) {
      console.error(c.red('No session to resume.'));
      process.exit(1);
    }
    loop = AgentLoop.resume(resumeId, { router, projectRoot: process.cwd(), confirmConfig, model: options.model });
    if (!loop) {
      console.error(c.red(`Session "${resumeId}" not found. Run 'forge sessions' to list sessions.`));
      process.exit(1);
    }
    console.log(c.gray(`Resumed session ${resumeId}`));
  } else {
    loop = new AgentLoop({ router, projectRoot: process.cwd(), confirmConfig, model: options.model });
  }

  // Cancellation: first Ctrl+C aborts the run gracefully, second exits immediately.
  const controller = new AbortController();
  let sigints = 0;
  const onSigint = () => {
    sigints++;
    if (sigints === 1) {
      console.error(`\n${c.yellow('Cancelling... (press Ctrl+C again to force exit)')}`);
      controller.abort();
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', () => controller.abort());

  const onConfirm = async (req: ConfirmRequest): Promise<boolean> => {
    if (!isInteractive) {
      // Non-interactive without -y: deny by default. Silently approving would
      // let a piped/CI invocation modify files or run commands unattended.
      console.error(
        c.yellow(`[confirm] Denied ${req.type === 'file' ? `write to ${req.target}` : `bash: ${req.target}`} (non-interactive; pass -y to auto-approve)`)
      );
      return false;
    }
    const label = req.type === 'file' ? `edit/write ${c.bold(req.target)}` : `run ${c.bold(req.target)}`;
    if (req.preview) console.log(`\n${c.gray(req.preview)}`);
    const ans = await askQuestion(`\n${c.yellow('[confirm]')} Allow ${label}? (y/N): `);
    return ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes';
  };

  let lastErrorMessage: string | undefined;
  let streamedThisStep = false;

  const onEvent = (event: AgentEvent) => {
    switch (event.type) {
      case 'step_start':
        streamedThisStep = false;
        break;
      case 'text':
        streamedThisStep = true;
        process.stdout.write(event.text);
        break;
      case 'stream_reset':
        if (streamedThisStep) process.stdout.write(`\n${c.gray('[partial output discarded]')}\n`);
        streamedThisStep = false;
        break;
      case 'tool_call_start': {
        const a = event.args;
        const detail =
          (typeof a.path === 'string' && a.path) ||
          (typeof a.command === 'string' && a.command) ||
          (typeof a.pattern === 'string' && a.pattern) ||
          (Array.isArray(a.items) ? `${a.items.length} items` : '');
        process.stdout.write(`\n${c.cyan(`⚙ [tool: ${event.name}]`)} ${detail}\n`);
        break;
      }
      case 'tool_call_result': {
        const summary = event.result.length > 400 ? event.result.slice(0, 400) + '\n... (truncated)' : event.result;
        const color = event.denied ? c.yellow : event.error ? c.red : c.gray;
        console.log(`${color(summary)}\n`);
        break;
      }
      case 'todos':
        console.log(c.magenta(`☐ todos: ${event.todos.join(' | ')}`));
        break;
      case 'compact':
        console.log(c.yellow(`⚡ Context compacted (${event.tokensBefore} -> ${event.tokensAfter} tokens, ${event.reason})`));
        break;
      case 'model_changed':
        console.log(c.magenta(`↪ model switched: ${event.from} -> ${event.to}`));
        break;
      case 'status':
        console.log(c.magenta(`ℹ ${event.message}`));
        break;
      case 'error':
        lastErrorMessage = event.error.message;
        break;
      case 'cancelled':
        console.log(`\n${c.yellow('■ Cancelled.')}`);
        break;
      default:
        break;
    }
  };

  const result = await loop.runTask(task, { confirmConfig, onConfirm, onEvent, signal: controller.signal });
  process.off('SIGINT', onSigint);
  console.log('');

  if (result.outcome === 'error') {
    console.error(c.red(`✖ ${lastErrorMessage || result.error?.message || 'Unknown error'}`));
    process.exit(1);
  }
  if (result.outcome === 'cancelled') process.exit(130);
  console.log(c.gray(`session: ${loop.session.id}`));
}

// ---------------------------------------------------------------------------
// Help / main
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
forge ${VERSION} - Terminal coding agent

USAGE:
  forge [options]                    Start interactive TUI
  forge "<task>" [options]           Start TUI with an initial prompt
  forge run "<task>" [options]       Run a task headless (no TUI)
  forge setup                        Interactive setup / configure AI provider and model
  forge login <openrouter|nvidia>    Set an API key and cache the provider's models
  forge models                       List available/cached models, fallbacks, and availability
  forge sessions                     List recent sessions
  forge todo <add|list|remove|toggle>
  forge uninstall [--purge] [-y]     Uninstall Forge CLI and configuration
  forge --help | --version

OPTIONS:
  -y, --yes            Auto-approve edits and commands (no permission prompts)
  -r, --resume [id]    Resume a previous session (most recent when id is omitted)
  -m, --model <name>   Use a specific model for this invocation

HEADLESS NOTES:
  Without -y, confirmations are denied automatically when stdin is not a TTY.
  Ctrl+C cancels the current run; a second Ctrl+C force-exits.

TUI SLASH COMMANDS:
  /models              List cached models
  /model <name>        Switch active model
  /provider            Switch or view provider (/provider openrouter|nvidia)
  /confirm [on|off]    Toggle auto-approve / permission prompts in current session
  /new                 Start a new session
  /resume [id]         Resume a previous session
  /sessions            List recent sessions
  /compact             Compact history context
  /diff                Show git diff
  /stop                Stop the currently running agent loop
  /exit                Quit
`);
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.version) {
    console.log(`forge v${VERSION}`);
    return;
  }
  if (args.help && !args.command) {
    printHelp();
    return;
  }
  if (args.unknownFlags.length > 0) {
    console.error(`Unknown option: ${args.unknownFlags[0]}`);
    printHelp();
    process.exit(1);
  }

  switch (args.command) {
    case 'setup':
      await runSetup();
      return;
    case 'login':
      await handleLoginCommand(args.positional[0], args.positional[1]);
      return;
    case 'models':
      await handleModelsCommand();
      return;
    case 'sessions':
      handleSessionsCommand();
      return;
    case 'todo':
      await handleTodoCommand(args.positional);
      return;
    case 'uninstall': {
      const { handleUninstallCommand } = await import('./uninstall.js');
      await handleUninstallCommand({ purge: args.purge, yes: args.yes });
      return;
    }
    case 'run': {
      const task = args.positional.join(' ');
      await runSetupIfNeeded({ isHeadless: true });
      await handleRunCommand(task, { yes: args.yes, resume: args.resume, model: args.model });
      return;
    }
    case 'resume':
      args.resume = args.positional.shift() || 'last';
    // falls through
    case 'start':
    case undefined: {
      await runSetupIfNeeded({ isHeadless: !process.stdin.isTTY });
      const resumeId = resolveResumeId(args.resume);
      if (args.resume && !resumeId) {
        console.error(c.red('No session to resume.'));
        process.exit(1);
      }
      await startTUI({
        initialPrompt: args.positional.join(' ') || undefined,
        noConfirm: args.yes,
        resumeSessionId: resumeId,
        model: args.model
      });
      return;
    }
    default:
      printHelp();
  }
}

main().catch((err) => {
  console.error(c.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  if (process.env.FORGE_DEBUG) console.error(err);
  process.exit(1);
});
