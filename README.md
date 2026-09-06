# routercode (rcd)

A fast, lightweight terminal coding agent. Run `rcd` inside any project folder, describe your task, and let the agent inspect the codebase, edit files with exact precision, run commands, and iterate until the task is complete.

## Quick Install

Install the standalone binary directly via curl (no Node.js required):

```bash
curl -fsSL https://raw.githubusercontent.com/YOU/routercode/main/install.sh | bash
```

> **Note:** Replace `YOU/routercode` with your actual GitHub repository path after publishing.

Then:
1. **Restart your terminal** (or run `source ~/.zshrc` / `source ~/.bashrc`).
2. Run `rcd login openrouter` or `rcd login nvidia` to set up your API keys.
3. Run `rcd` to launch the interactive terminal agent!

---

## Commands

```bash
rcd                  # Start interactive TUI in current directory
rcd run "task"       # One-shot execution without TUI
rcd login openrouter # Configure OpenRouter API key and cache free/tool models
rcd login nvidia     # Configure NVIDIA NIM API key and cache live models
rcd models           # List available and fallback models
```

### TUI Slash Commands

While inside the interactive `rcd` session:
- `/models` — Display all available models and fallbacks
- `/provider` — View or switch provider (`/provider openrouter` or `/provider nvidia`)
- `/new` — Start a fresh session with a new ID and clean context
- `/compact` — Trigger history compaction manually to reduce token usage
- `/diff` — View git diff of changes made in the session
- `/stop` — Stop the currently running agent loop

---

## Model Providers & Router Policy

`routercode` supports both **OpenRouter** and **NVIDIA NIM** using the official OpenAI SDK interface.

### OpenRouter
- Default model: `openrouter/free`
- Supports explicit `:free` models
- On boot, caches price-0 models supporting tools

### NVIDIA NIM
- Preferred models:
  - `nvidia/nemotron-3-super-120b-a12b`
  - `nvidia/nemotron-3-ultra-550b-a55b`
  - `deepseek-ai/deepseek-v4-flash-0731`
- **Important:** `deepseek-ai/deepseek-v4-flash` is retired; do not use it.

### Routing & Fallback Policy
1. Attempts the user-selected or default model first.
2. On HTTP 404 or 410, marks the model dead and switches to the next fallback.
3. On HTTP 429 (rate limit), applies exponential backoff and retries twice.
4. If a model does not support tool calling, skips to the next fallback.

Default fallback chain:
1. `openrouter/free`
2. `nvidia/nemotron-3-super-120b-a12b`
3. `openai/gpt-oss-120b:free`

---

## Tools & Security Model

`routercode` implements a strict toolset:
- `read_file(path, start?, end?)` — inspect file contents (auto-allowed)
- `write_file(path, content)` — create or overwrite files (requires confirmation)
- `edit_file(path, old, new)` — exact search-and-replace (requires confirmation; fails if `old` is missing or not unique)
- `list_dir(path)` — list directory contents (auto-allowed)
- `glob(pattern)` — find files matching patterns (auto-allowed)
- `grep(pattern, glob?)` — fast text search using `rg` if available, or native Node fallback (auto-allowed)
- `bash(command)` — run shell commands (cwd = project root, 60s timeout, output truncated)
- `todo(items)` — manage multi-step task checklists

### Security Protections
- **Pre-approved Bash Commands:** `ls`, `pwd`, `rg`, `git status`, `git diff`, `npm test`, `npx vitest`
- **Confirmation Policy:** File edits/writes require user confirmation once per file per session. Bash commands outside the allowlist require confirmation.
- **Strictly Denied:**
  - Path escapes outside the project root
  - Access to `~/.ssh`, `.env`, `.env.*`, and `*.pem` files
  - Dangerous commands: `sudo`, `rm -rf /`, `curl | sh`

---

## Configuration

Configuration is stored in `~/.rcd/`:
- `~/.rcd/config.json` — agent settings
- `~/.rcd/auth.json` — stored API keys
- `~/.rcd/models-cache.json` — cached model metadata
- `~/.rcd/sessions/<id>.jsonl` — conversation and audit logs
- `./.rcd/project.md` — optional project-specific instructions in project root

Default `~/.rcd/config.json`:
```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "openrouter/free",
  "fallbackModels": [
    "nvidia/nemotron-3-super-120b-a12b",
    "openai/gpt-oss-120b:free"
  ],
  "maxSteps": 30,
  "confirm": {
    "edit": true,
    "bash": true
  }
}
```

---

## Local Development (Node.js)

Node/npm is only needed for local development.

```bash
# Clone and install dependencies
git clone https://github.com/dilkuwor/routercode.git
cd routercode
npm install

# Build the project
npm run build

# Run tests
npm test

# Run CLI locally
npx rcd
npx rcd run "what does this repo do?"
```

---

## Docker (Isolated Environment)

Docker is optional for running isolated tests without installing Node or modifying host state. The image does not contain the user repository.

```bash
# Build the Docker image
docker build -t rcd .

# Run inside any workspace
docker run --rm -it \
  -v "$PWD":/workspace \
  -w /workspace \
  -e OPENROUTER_API_KEY \
  -e NVIDIA_API_KEY \
  rcd
```
