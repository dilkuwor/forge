import fs from 'node:fs';
import path from 'node:path';
import { getProjectMd } from '../config.js';

export function buildRepoMap(projectRoot: string, maxFiles: number = 80): string {
  const fileList: string[] = [];

  function traverse(dir: string, depth: number = 0) {
    if (fileList.length >= maxFiles || depth > 4) return;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort directories first, then files
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (fileList.length >= maxFiles) break;

      const name = entry.name;
      if (
        name.startsWith('.') ||
        name === 'node_modules' ||
        name === 'dist' ||
        name === 'coverage' ||
        name === '.git'
      ) {
        continue;
      }

      const fullPath = path.join(dir, name);
      const relPath = path.relative(projectRoot, fullPath);

      if (entry.isDirectory()) {
        fileList.push(`${relPath}/`);
        traverse(fullPath, depth + 1);
      } else if (entry.isFile()) {
        fileList.push(relPath);
      }
    }
  }

  traverse(projectRoot);

  if (fileList.length === 0) {
    return '(empty directory)';
  }

  return fileList.join('\n');
}

export function buildSystemPrompt(projectRoot: string, touchedFiles: Set<string>): string {
  const repoMap = buildRepoMap(projectRoot);
  const projectMd = getProjectMd(projectRoot);

  let prompt = `You are routercode (rcd), an autonomous terminal coding agent.
Working directory: ${projectRoot}

CORE RULES:
1. Stay inside the project root at all times.
2. Read before edit: always inspect existing file content before modifying it.
3. Prefer exact edit_file over rewriting whole files with write_file.
4. edit_file requires the exact, unique 'old' string from the file. If edit_file fails because 'old' is not found or not unique, use read_file to inspect the file and retry once with exact context.
5. Run tests after code changes (e.g. npm test or npx vitest via bash).
6. Do not invent file contents or assumptions; verify with tools.
7. Never print or upload secrets from .env, keys, or pem files.
8. When planning complex tasks, use the todo tool.
9. Be direct, helpful, and concise. Explain your actions cleanly.

REPOSITORY STRUCTURE:
${repoMap}
`;

  if (projectMd) {
    prompt += `\nPROJECT INSTRUCTIONS (.rcd/project.md):\n${projectMd}\n`;
  }

  if (touchedFiles.size > 0) {
    prompt += `\nFILES TOUCHED IN THIS SESSION:\n${Array.from(touchedFiles)
      .map((f) => `- ${f}`)
      .join('\n')}\n`;
  }

  return prompt.trim();
}
