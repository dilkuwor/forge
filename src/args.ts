export interface ParsedArgs {
  command?: string;
  positional: string[];
  yes: boolean;
  resume?: string;
  purge: boolean;
  model?: string;
  help: boolean;
  version: boolean;
  unknownFlags: string[];
}

const YES_FLAGS = new Set(['-y', '--y', '--yes', '--no-confirm', '--auto-approve']);
const COMMANDS = new Set([
  'setup',
  'login',
  'models',
  'todo',
  'start',
  'run',
  'uninstall',
  'sessions',
  'resume'
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    positional: [],
    yes: false,
    purge: false,
    help: false,
    version: false,
    unknownFlags: []
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (YES_FLAGS.has(a)) {
      out.yes = true;
    } else if (a === '--purge') {
      out.purge = true;
    } else if (a === '-h' || a === '--help' || (a === 'help' && out.positional.length === 0)) {
      out.help = true;
    } else if (a === '-v' || a === '--version') {
      out.version = true;
    } else if (a === '-r' || a === '--resume') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-') && !COMMANDS.has(next)) {
        out.resume = next;
        i++;
      } else {
        out.resume = 'last';
      }
    } else if (a.startsWith('--resume=')) {
      out.resume = a.slice('--resume='.length) || 'last';
    } else if (a === '-m' || a === '--model') {
      const next = argv[i + 1];
      if (next) {
        out.model = next;
        i++;
      }
    } else if (a.startsWith('--model=')) {
      out.model = a.slice('--model='.length);
    } else if (a.startsWith('-') && a.length > 1 && out.positional.length === 0) {
      out.unknownFlags.push(a);
    } else {
      out.positional.push(a);
    }
  }

  if (out.positional.length > 0 && COMMANDS.has(out.positional[0])) {
    out.command = out.positional.shift();
  }
  return out;
}
