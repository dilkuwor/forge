import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execSync } from 'node:child_process';

export interface UninstallOptions {
  purge?: boolean;
  yes?: boolean;
  homeDir?: string;
  promptFn?: (query: string) => Promise<string>;
}

export interface UninstallResult {
  binariesRemoved: string[];
  shellFilesCleaned: string[];
  configRemoved: boolean;
  statePurged: boolean;
  preservedPaths: string[];
}

/**
 * Checks if a file path is a valid Forge-owned binary or symlink.
 * Guards strictly against deleting system files, git repositories,
 * or user project files.
 */
export function isForgeOwnedBinary(filePath: string, homeDir: string = os.homedir()): boolean {
  if (!filePath || typeof filePath !== 'string') return false;

  const resolved = path.resolve(filePath);
  const basename = path.basename(resolved);

  // Basename must be forge or a forge binary release name
  const isForgeName =
    basename === 'forge' ||
    basename === 'forge-darwin-arm64' ||
    basename === 'forge-darwin-x64' ||
    basename === 'forge-linux-x64' ||
    basename.startsWith('forge-');

  if (!isForgeName) return false;

  // Check if file or symlink exists
  let isSymlink = false;
  try {
    const lstat = fs.lstatSync(resolved);
    isSymlink = lstat.isSymbolicLink();
  } catch {
    return false;
  }

  // Safety: NEVER delete anything in /bin, /sbin, /usr/bin unless it's a symlink pointing to forge
  if ((resolved.startsWith('/bin/') || resolved.startsWith('/usr/bin/') || resolved.startsWith('/sbin/')) && !isSymlink) {
    return false;
  }

  // Safety: Check if file is inside a git repository (other than ~/.forge)
  // This prevents deleting development source files in the forge repo
  const forgeDir = path.resolve(homeDir, '.forge');
  if (!resolved.startsWith(forgeDir)) {
    let currentDir = path.dirname(resolved);
    while (currentDir && currentDir !== '/' && currentDir !== path.dirname(currentDir)) {
      if (fs.existsSync(path.join(currentDir, '.git'))) {
        // Inside a git repo outside ~/.forge - DO NOT DELETE
        return false;
      }
      currentDir = path.dirname(currentDir);
    }
  }

  // If it's a symlink, verify target
  if (isSymlink) {
    try {
      const linkTarget = fs.readlinkSync(resolved);
      const targetResolved = path.resolve(path.dirname(resolved), linkTarget);
      if (
        targetResolved.includes('.forge/bin') ||
        targetResolved.endsWith('dist/cli.js') ||
        path.basename(targetResolved).startsWith('forge')
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }

  // Accepted install locations
  const allowedDirs = [
    path.resolve(homeDir, '.forge', 'bin'),
    path.resolve(homeDir, '.local', 'bin'),
    '/usr/local/bin'
  ];

  const parentDir = path.dirname(resolved);
  return allowedDirs.some((allowed) => parentDir === allowed);
}

/**
 * Finds all installed Forge CLI binaries and symlinks across standard locations.
 */
export function findForgeBinaries(homeDir: string = os.homedir()): string[] {
  const candidates: string[] = [
    path.join(homeDir, '.forge', 'bin', 'forge'),
    path.join(homeDir, '.local', 'bin', 'forge'),
    '/usr/local/bin' + path.sep + 'forge'
  ];

  // Also check `which forge` if available
  try {
    const whichOut = execSync('which forge', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (whichOut && !candidates.includes(whichOut)) {
      candidates.push(whichOut);
    }
  } catch {
    // ignore
  }

  const found: string[] = [];
  for (const candidate of candidates) {
    if (isForgeOwnedBinary(candidate, homeDir)) {
      if (!found.includes(candidate)) {
        found.push(candidate);
      }
    }
  }

  return found;
}

/**
 * Removes PATH export lines explicitly added by Forge in shell rc files.
 * Preserves all unrelated shell configuration.
 */
export function cleanShellIntegrations(
  homeDir: string = os.homedir()
): { file: string; removedLines: string[] }[] {
  const shellFiles = [
    path.join(homeDir, '.zshrc'),
    path.join(homeDir, '.bashrc'),
    path.join(homeDir, '.bash_profile'),
    path.join(homeDir, '.profile'),
    path.join(homeDir, '.config', 'fish', 'config.fish')
  ];

  const results: { file: string; removedLines: string[] }[] = [];

  const isForgePathLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.includes('.forge/bin')) {
      return false;
    }
    // Must be a PATH export line
    return (
      trimmed.startsWith('export PATH=') ||
      trimmed.startsWith('PATH=') ||
      trimmed.includes('$PATH') ||
      trimmed.startsWith('fish_add_path') ||
      trimmed.includes('set -gx PATH')
    );
  };

  for (const file of shellFiles) {
    if (!fs.existsSync(file)) {
      continue;
    }

    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      const removed: string[] = [];
      const kept: string[] = [];

      for (const line of lines) {
        if (isForgePathLine(line)) {
          removed.push(line);
        } else {
          kept.push(line);
        }
      }

      if (removed.length > 0) {
        // Clean up trailing multiple blank lines
        let newContent = kept.join('\n');
        newContent = newContent.replace(/\n{3,}/g, '\n\n');
        fs.writeFileSync(file, newContent, 'utf8');
        results.push({ file, removedLines: removed });
      }
    } catch {
      // ignore read/write errors on restricted shell files
    }
  }

  return results;
}

/**
 * Safely removes Forge binaries, configuration, and optionally all local state.
 * Never touches user project files or .forge/project.md inside project workspaces.
 */
export function removeForgeFiles(options: {
  purge?: boolean;
  homeDir?: string;
}): { removed: string[]; preserved: string[] } {
  const homeDir = options.homeDir || os.homedir();
  const forgeHome = path.resolve(homeDir, '.forge');
  const purge = !!options.purge;

  const removed: string[] = [];
  const preserved: string[] = [];

  // 1. Remove Forge CLI binaries
  const binaries = findForgeBinaries(homeDir);
  for (const bin of binaries) {
    try {
      fs.unlinkSync(bin);
      removed.push(bin);
    } catch {
      // ignore if already removed or permission issue
    }
  }

  // 2. Remove ~/.forge/bin folder
  const binDir = path.join(forgeHome, 'bin');
  if (fs.existsSync(binDir)) {
    try {
      fs.rmSync(binDir, { recursive: true, force: true });
      removed.push(binDir);
    } catch {
      // ignore
    }
  }

  if (!fs.existsSync(forgeHome)) {
    return { removed, preserved };
  }

  if (purge) {
    // Purge mode: Remove everything in ~/.forge/
    try {
      fs.rmSync(forgeHome, { recursive: true, force: true });
      removed.push(forgeHome);
    } catch {
      // ignore
    }
  } else {
    // Default mode: Remove config.json and models-cache.json, preserve auth.json and sessions/
    const configPath = path.join(forgeHome, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        fs.unlinkSync(configPath);
        removed.push(configPath);
      } catch {}
    }

    const cachePath = path.join(forgeHome, 'models-cache.json');
    if (fs.existsSync(cachePath)) {
      try {
        fs.unlinkSync(cachePath);
        removed.push(cachePath);
      } catch {}
    }

    // Clean any temporary / cache files in ~/.forge
    try {
      const items = fs.readdirSync(forgeHome);
      for (const item of items) {
        if (item.endsWith('.tmp') || item.endsWith('.temp')) {
          const itemPath = path.join(forgeHome, item);
          fs.unlinkSync(itemPath);
          removed.push(itemPath);
        }
      }
    } catch {}

    const authPath = path.join(forgeHome, 'auth.json');
    if (fs.existsSync(authPath)) {
      preserved.push(authPath);
    }

    const sessionsDir = path.join(forgeHome, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      preserved.push(sessionsDir);
    }

    // If ~/.forge is completely empty now, remove it
    try {
      const remaining = fs.readdirSync(forgeHome);
      if (remaining.length === 0) {
        fs.rmdirSync(forgeHome);
        removed.push(forgeHome);
      }
    } catch {}
  }

  return { removed, preserved };
}

function defaultAskQuestion(query: string): Promise<string> {
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

/**
 * Main command handler for `forge uninstall` and `forge uninstall --purge`.
 */
export async function handleUninstallCommand(options: UninstallOptions = {}): Promise<boolean> {
  const purge = !!options.purge;
  const skipConfirm = !!options.yes;
  const homeDir = options.homeDir || os.homedir();
  const ask = options.promptFn || defaultAskQuestion;

  // UX Header
  if (purge) {
    console.log('\nForge Uninstaller (Purge Mode)\n');
    console.log('WARNING: This will permanently remove ALL Forge data, including:');
    console.log('  ✓ Forge CLI');
    console.log('  ✓ Forge shell integration');
    console.log('  ✓ Forge local configuration');
    console.log('  ✓ API credentials (auth.json)');
    console.log('  ✓ Session history and audit logs (sessions/)\n');
    console.log('Your project files will NOT be modified.\n');
  } else {
    console.log('\nForge Uninstaller\n');
    console.log('This will remove:');
    console.log('  ✓ Forge CLI');
    console.log('  ✓ Forge shell integration');
    console.log('  ✓ Forge local configuration\n');
    console.log('Your project files will NOT be modified.\n');
  }

  // Interactive confirmation
  if (!skipConfirm) {
    const isTTY = process.stdin.isTTY;
    if (!isTTY && !options.promptFn) {
      console.error('Error: Interactive confirmation required. Use --yes / -y to skip confirmation in scripts.');
      return false;
    }

    const question = purge
      ? 'Are you sure you want to permanently delete all Forge data? [y/N] '
      : 'Continue? [y/N] ';

    const answer = await ask(question);
    const confirmed = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';

    if (!confirmed) {
      console.log('\nUninstall cancelled.\n');
      return false;
    }
  }

  // Perform uninstallation
  removeForgeFiles({ purge, homeDir });
  cleanShellIntegrations(homeDir);

  // Completion UX output
  console.log('\n✓ Forge CLI removed');
  console.log('✓ Configuration removed');
  console.log('✓ Shell integration removed');

  if (purge) {
    console.log('✓ API credentials removed');
    console.log('✓ Session history purged');
    console.log('✓ Local state directory removed (~/.forge)\n');
    console.log('Forge has been completely uninstalled.\n');
  } else {
    console.log('\nForge has been uninstalled.\n');
    console.log('For complete removal including sessions and credentials:');
    console.log('  forge uninstall --purge\n');
  }

  return true;
}
