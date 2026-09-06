import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isForgeOwnedBinary,
  findForgeBinaries,
  cleanShellIntegrations,
  removeForgeFiles,
  handleUninstallCommand
} from '../src/uninstall.js';

describe('Forge Uninstall Test Suite', () => {
  let tempHome: string;
  let tempWorkspace: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-uninstall-home-'));
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-user-project-'));

    // Create user workspace files and user project .forge/project.md
    const projectForgeDir = path.join(tempWorkspace, '.forge');
    fs.mkdirSync(projectForgeDir, { recursive: true });
    fs.writeFileSync(path.join(projectForgeDir, 'project.md'), '# Project Overrides\nDo not delete', 'utf8');
    fs.writeFileSync(path.join(tempWorkspace, 'index.ts'), 'console.log("user project");', 'utf8');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Binary Path Detection & Safety Checks', () => {
    it('identifies ~/.forge/bin/forge as forge-owned', () => {
      const binDir = path.join(tempHome, '.forge', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const binPath = path.join(binDir, 'forge');
      fs.writeFileSync(binPath, '#!/bin/sh\necho "forge"', 'utf8');
      fs.chmodSync(binPath, 0o755);

      expect(isForgeOwnedBinary(binPath, tempHome)).toBe(true);
    });

    it('identifies ~/.local/bin/forge as forge-owned', () => {
      const binDir = path.join(tempHome, '.local', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const binPath = path.join(binDir, 'forge');
      fs.writeFileSync(binPath, '#!/bin/sh\necho "forge"', 'utf8');

      expect(isForgeOwnedBinary(binPath, tempHome)).toBe(true);
    });

    it('refuses to delete system binaries like /bin/sh or /usr/bin/python', () => {
      expect(isForgeOwnedBinary('/bin/sh', tempHome)).toBe(false);
      expect(isForgeOwnedBinary('/bin/bash', tempHome)).toBe(false);
      expect(isForgeOwnedBinary('/usr/bin/git', tempHome)).toBe(false);
    });

    it('refuses to delete files that do not exist', () => {
      expect(isForgeOwnedBinary('/path/that/does/not/exist/forge', tempHome)).toBe(false);
    });

    it('refuses to delete files not named forge or forge-*', () => {
      const binDir = path.join(tempHome, '.forge', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const otherFile = path.join(binDir, 'important-data.txt');
      fs.writeFileSync(otherFile, 'content', 'utf8');

      expect(isForgeOwnedBinary(otherFile, tempHome)).toBe(false);
    });

    it('refuses to delete binaries or files inside git repositories outside ~/.forge', () => {
      const gitDir = path.join(tempWorkspace, '.git');
      fs.mkdirSync(gitDir, { recursive: true });
      const fakeBinaryInRepo = path.join(tempWorkspace, 'forge');
      fs.writeFileSync(fakeBinaryInRepo, '#!/bin/sh', 'utf8');

      expect(isForgeOwnedBinary(fakeBinaryInRepo, tempHome)).toBe(false);
    });

    it('findForgeBinaries locates existing forge binaries in standard paths', () => {
      const forgeBin = path.join(tempHome, '.forge', 'bin', 'forge');
      const localBin = path.join(tempHome, '.local', 'bin', 'forge');
      fs.mkdirSync(path.dirname(forgeBin), { recursive: true });
      fs.mkdirSync(path.dirname(localBin), { recursive: true });
      fs.writeFileSync(forgeBin, '#!/bin/sh', 'utf8');
      fs.writeFileSync(localBin, '#!/bin/sh', 'utf8');

      const found = findForgeBinaries(tempHome);
      expect(found).toContain(forgeBin);
      expect(found).toContain(localBin);
    });
  });

  describe('2. Shell Integration Cleaning', () => {
    it('removes Forge PATH export lines while preserving all other configuration', () => {
      const zshrc = path.join(tempHome, '.zshrc');
      const originalZshrc = [
        '# User configuration',
        'export PATH="/usr/local/bin:$PATH"',
        'alias ll="ls -la"',
        '',
        'export PATH="$HOME/.forge/bin:$PATH"',
        'export EDITOR=nano'
      ].join('\n');
      fs.writeFileSync(zshrc, originalZshrc, 'utf8');

      const bashrc = path.join(tempHome, '.bashrc');
      const originalBashrc = [
        'export PATH="$HOME/.forge/bin:$PATH"',
        'source ~/.profile'
      ].join('\n');
      fs.writeFileSync(bashrc, originalBashrc, 'utf8');

      const results = cleanShellIntegrations(tempHome);
      expect(results.length).toBe(2);

      const updatedZshrc = fs.readFileSync(zshrc, 'utf8');
      expect(updatedZshrc).not.toContain('.forge/bin');
      expect(updatedZshrc).toContain('export PATH="/usr/local/bin:$PATH"');
      expect(updatedZshrc).toContain('alias ll="ls -la"');
      expect(updatedZshrc).toContain('export EDITOR=nano');

      const updatedBashrc = fs.readFileSync(bashrc, 'utf8');
      expect(updatedBashrc).not.toContain('.forge/bin');
      expect(updatedBashrc).toContain('source ~/.profile');
    });

    it('leaves shell files untouched if Forge integration was not present', () => {
      const zshrc = path.join(tempHome, '.zshrc');
      const content = 'export FOO=bar\nalias gst="git status"\n';
      fs.writeFileSync(zshrc, content, 'utf8');

      const results = cleanShellIntegrations(tempHome);
      expect(results.length).toBe(0);
      expect(fs.readFileSync(zshrc, 'utf8')).toBe(content);
    });
  });

  describe('3. Default Uninstall (Preserves Sessions & Credentials)', () => {
    it('removes binaries, config.json, and models-cache.json but preserves auth.json and sessions', () => {
      const forgeDir = path.join(tempHome, '.forge');
      fs.mkdirSync(path.join(forgeDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(forgeDir, 'sessions'), { recursive: true });

      const binFile = path.join(forgeDir, 'bin', 'forge');
      fs.writeFileSync(binFile, '#!/bin/sh', 'utf8');

      const configFile = path.join(forgeDir, 'config.json');
      fs.writeFileSync(configFile, '{"defaultModel":"openrouter/free"}', 'utf8');

      const cacheFile = path.join(forgeDir, 'models-cache.json');
      fs.writeFileSync(cacheFile, '{"openrouter":[]}', 'utf8');

      const authFile = path.join(forgeDir, 'auth.json');
      fs.writeFileSync(authFile, '{"openrouterApiKey":"sk-secret"}', 'utf8');

      const sessionFile = path.join(forgeDir, 'sessions', 'session-123.jsonl');
      fs.writeFileSync(sessionFile, '{"type":"meta"}\n', 'utf8');

      const res = removeForgeFiles({ purge: false, homeDir: tempHome });

      // Removed
      expect(fs.existsSync(binFile)).toBe(false);
      expect(fs.existsSync(configFile)).toBe(false);
      expect(fs.existsSync(cacheFile)).toBe(false);

      // Preserved
      expect(fs.existsSync(authFile)).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(true);
      expect(res.preserved).toContain(authFile);
      expect(res.preserved).toContain(path.join(forgeDir, 'sessions'));

      // Project workspace files MUST NOT be touched
      expect(fs.existsSync(path.join(tempWorkspace, '.forge', 'project.md'))).toBe(true);
      expect(fs.existsSync(path.join(tempWorkspace, 'index.ts'))).toBe(true);
    });
  });

  describe('4. Purge Uninstall (Removes All Forge Data)', () => {
    it('removes all of ~/.forge including auth.json and sessions, but NEVER touches project files', () => {
      const forgeDir = path.join(tempHome, '.forge');
      fs.mkdirSync(path.join(forgeDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(forgeDir, 'sessions'), { recursive: true });

      fs.writeFileSync(path.join(forgeDir, 'config.json'), '{}', 'utf8');
      fs.writeFileSync(path.join(forgeDir, 'auth.json'), '{"key":"secret"}', 'utf8');
      fs.writeFileSync(path.join(forgeDir, 'sessions', 's.jsonl'), '{}', 'utf8');

      removeForgeFiles({ purge: true, homeDir: tempHome });

      // Entire ~/.forge is removed
      expect(fs.existsSync(forgeDir)).toBe(false);

      // User workspace files remain completely intact!
      expect(fs.existsSync(path.join(tempWorkspace, '.forge', 'project.md'))).toBe(true);
      expect(fs.existsSync(path.join(tempWorkspace, 'index.ts'))).toBe(true);
      const projectMdContent = fs.readFileSync(path.join(tempWorkspace, '.forge', 'project.md'), 'utf8');
      expect(projectMdContent).toContain('Do not delete');
    });
  });

  describe('5. Interactive Confirmation & --yes Flags', () => {
    it('aborts when user declines confirmation', async () => {
      const forgeDir = path.join(tempHome, '.forge');
      fs.mkdirSync(forgeDir, { recursive: true });
      const configFile = path.join(forgeDir, 'config.json');
      fs.writeFileSync(configFile, '{}', 'utf8');

      // Mock user typing 'n'
      const success = await handleUninstallCommand({
        purge: false,
        yes: false,
        homeDir: tempHome,
        promptFn: async () => 'n'
      });

      expect(success).toBe(false);
      // Config was NOT removed
      expect(fs.existsSync(configFile)).toBe(true);
    });

    it('proceeds when user confirms with y', async () => {
      const forgeDir = path.join(tempHome, '.forge');
      fs.mkdirSync(forgeDir, { recursive: true });
      const configFile = path.join(forgeDir, 'config.json');
      fs.writeFileSync(configFile, '{}', 'utf8');

      const success = await handleUninstallCommand({
        purge: false,
        yes: false,
        homeDir: tempHome,
        promptFn: async () => 'y'
      });

      expect(success).toBe(true);
      expect(fs.existsSync(configFile)).toBe(false);
    });

    it('proceeds without prompting when yes: true is passed', async () => {
      const forgeDir = path.join(tempHome, '.forge');
      fs.mkdirSync(forgeDir, { recursive: true });
      const configFile = path.join(forgeDir, 'config.json');
      fs.writeFileSync(configFile, '{}', 'utf8');

      let promptCalled = false;
      const success = await handleUninstallCommand({
        purge: false,
        yes: true,
        homeDir: tempHome,
        promptFn: async () => {
          promptCalled = true;
          return 'n';
        }
      });

      expect(promptCalled).toBe(false);
      expect(success).toBe(true);
      expect(fs.existsSync(configFile)).toBe(false);
    });

    it('purges all data when purge: true and yes: true are passed', async () => {
      const forgeDir = path.join(tempHome, '.forge');
      fs.mkdirSync(forgeDir, { recursive: true });
      fs.writeFileSync(path.join(forgeDir, 'auth.json'), '{"key":"val"}', 'utf8');

      const success = await handleUninstallCommand({
        purge: true,
        yes: true,
        homeDir: tempHome
      });

      expect(success).toBe(true);
      expect(fs.existsSync(forgeDir)).toBe(false);
    });
  });
});
