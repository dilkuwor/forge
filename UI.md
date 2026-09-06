# Forge Localhost Web UI — Production Reference

A modern, standalone localhost web dashboard for monitoring, controlling, and configuring the **Forge** autonomous coding agent in real time.

---

## 1. Architectural Philosophy & Isolation

The Web UI is built strictly as an **additive, isolated subsystem**:
- **Zero Agent Alterations**: The core agent loop (`src/agent/**`), providers (`src/providers/**`), tool system (`src/tools/**`), session store (`src/store/**`), and configuration (`src/config.ts`) remain 100% read-only and unmodified.
- **Single Source of Truth**: Uses the existing Forge `AgentLoop`, `ModelRouter`, `SessionStore`, and configuration files (`~/.forge/`). No competing session database, model router, or authentication store is introduced.
- **Clean Adapter Bridge (`ForgeAdapter`)**: Interfaces with the agent via standard event streams (`onEvent`), confirmation hooks (`onConfirm`), and process signals (`AbortSignal`).
- **No Node.js Required in Production**: The production distribution bundles the UI server and precompiled web assets (`web/dist`). End users run `forge ui` directly without installing Node.js, React, or Vite.
- **Strict Localhost Security**: Binds exclusively to `127.0.0.1` (never `0.0.0.0`).

---

## 2. Quick Start & CLI Commands

### Basic Launch
```bash
# Start on default port (http://127.0.0.1:4317)
forge ui

# Or without global installation:
node ./dist/cli.js ui
# or
npm run ui
```

### Custom Port & Auto-Increment
```bash
forge ui 8080
```
*(If the requested port is occupied, Forge automatically finds and binds to the next available port).*

### Auto-Approve Mode (`-y` / `--y`)
```bash
forge -y ui
# or
forge --y ui
# or
node ./dist/cli.js -y ui
```

---

## 3. Navigation Structure

Navigation follows a clear, developer-focused layout without extraneous testing management tools:

```text
FORGE ⚡

Dashboard

WORK
  Sessions
  Activity
  Files & Diff

CONFIGURATION
  Models
  Providers
  Permissions
  Settings
```

---

## 4. Dashboard & Features

### 📊 Dashboard
The primary monitoring and control center.
- **Live Connection Status**: Visual indicator displaying:
  - `● Connected` (green)
  - `⚠ Reconnecting...` (yellow)
  - `○ Disconnected` (red)
- **Agent Status Badge**: `IDLE`, `WORKING`, `PAUSED`, `WAITING_APPROVAL`, `ERROR`, `COMPLETED`.
- **Project & Session Bar**: Displays active project name, current working directory, and truncated session ID.
- **Real-Time KPIs**:
  - Step counter (`step / maxSteps`)
  - Tool execution counter
  - Elapsed execution time (`MM:SS`)
  - Modified files count
- **Compact Verification Card**:
  - Displays test outcomes (e.g. `✓ Tests: 21/21` or `✗ Tests: 19 passed, 2 failed`).
  - Only displayed when verification runs have occurred.
- **Interactive Task Runner**:
  - Input prompt with auto-approve toggle.
  - Controls: `[ ⏸ Pause ]`, `[ ▶ Resume ]`, `[ ⏹ Stop ]`.
- **Observable Agent Activity**:
  - Real-time step progress, active tool executions, and file edits.
  - **No Hidden Chain-of-Thought**: Strictly adheres to safety policy; hidden provider reasoning is not extracted or displayed.
- **Live Terminal Console**:
  - Streaming stdout/stderr with ANSI color decoding.
  - Auto-scroll lock, copy output, and clear display buttons.
- **Live Todo Checklist**:
  - Synchronized in real time with Forge's internal task plan.

### 🕒 Sessions
Session history and audit inspection.
- **Historical Sessions**: Browse previous sessions persisted in `~/.forge/sessions/*.jsonl`.
- **Audit Details**: Inspect user prompt, tool turns, file changes, errors, and compaction events.
- **Session Actions**:
  - **Export Session**: Download or copy raw JSONL audit logs.
  - **New Session**: Reset context and generate a fresh session ID.

### 📜 Activity
Chronological audit timeline of observable actions.
- Collapsible cards for tool calls (`read_file`, `edit_file`, `write_file`, `bash`, `glob`, `grep`, `list_dir`, `todo`).
- Inspect exact arguments, paths, commands, exit codes, and execution times.
- Context compaction markers (`tokensBefore` → `tokensAfter`).

### 📝 Files & Git Diff
Codebase modifications inspector and safe rollback.
- **Changed Files List**: File tree of files modified or added in the active session.
- **Unified Diff Viewer**: Color-coded syntax diff viewer with copy-to-clipboard support.
- **Safe Revert ("Revert Forge Changes")**:
  - Reverts **only** files touched by Forge during the active session.
  - Pre-existing untracked files or unstaged changes created prior to the session baseline are strictly protected.
  - Never executes destructive commands like `git clean -fd` or `git checkout HEAD -- .`.

### 🤖 Models
Model configuration driven by Forge's `ModelRouter`.
- View and switch active default model across OpenRouter and NVIDIA NIM.
- Inspect and reorder fallback chains.
- Refresh cached models from provider APIs.
- Audit retired/dead models.

### 🔑 Providers
Provider credentials and connectivity.
- Supported providers: **OpenRouter** and **NVIDIA NIM**.
- **Masked API Keys**: Secrets are masked (`••••••••••••XXXX`) and never sent in plain text to the browser.
- **Connectivity Testing**: Test API credentials on demand without triggering agent turns.

### 🛡️ Permissions & Security
Safety policy viewer and confirmation manager.
- Display file editing and bash execution policy (`confirm_required` vs `auto_approved`).
- View allowlisted bash commands (`ls`, `pwd`, `rg`, `git status`, `git diff`, `npm test`, `npx vitest`).
- Audit protected assets (`.env`, `.env.*`, `~/.ssh`, `*.pem`, path escapes, `sudo`).
- Review session-approved files and toggle session auto-approve.

### ⚙️ Settings
System configuration from `~/.forge/config.json`.
- Max steps limit (default: 30).
- Bash timeout (60s).
- Context compaction threshold (70%).
- Safety confirmation toggles.

---

## 5. Interactive Permission Modal

When an unapproved operation requires confirmation:
- The agent loop enters `WAITING_APPROVAL`.
- An interactive modal appears in the browser with:
  - **Operation**: Bash command or File edit.
  - **Target**: Exact file path or shell command string.
  - Actions: **`[ Allow Once ]`**, **`[ Allow Session ]`**, and **`[ Deny ]`**.

---

## 6. Security Guarantees

1. **Localhost Only**: Binds strictly to `127.0.0.1`.
2. **Path Traversal Protection**: Rejects paths attempting to escape workspace boundaries (`../`).
3. **Secret Masking**: Raw API keys are never exposed in API payloads, WebSocket events, or network traces.
4. **Authoritative Forge Sandbox**: All tool execution remains gated by Forge's security policy.
5. **Safe Rollback**: Baseline recording prevents destruction of pre-existing user files.

---

## 7. REST & WebSocket API Specification

### REST Endpoints (`/api/*`)
- `GET /api/status` — Current state, metrics, model, provider, and pending permissions.
- `GET /api/session/current` — Full trace of active session.
- `GET /api/sessions` — List of historical sessions.
- `GET /api/sessions/:id` — Detail of a specific session.
- `GET /api/activity` — Chronological observable events.
- `GET /api/files` — Modified files list.
- `GET /api/diff[?file=path]` — Unified git diff.
- `POST /api/files/revert` — Revert a single file modified by Forge.
- `POST /api/files/revert-forge` — Safely rollback changes introduced by Forge in the session.
- `GET /api/models` — Cached models and fallback order.
- `POST /api/models/select` — Change active default model.
- `POST /api/models/fallback` — Update fallback sequence.
- `POST /api/models/refresh` — Refresh model lists from provider APIs.
- `GET /api/providers` — Masked provider credentials.
- `POST /api/providers/:provider/key` — Update API key in `~/.forge/auth.json`.
- `POST /api/providers/:provider/test` — Test provider connection.
- `GET /api/permissions` — Active security policies and allowlists.
- `POST /api/permissions/approve` — Approve pending action (`once` or `session`).
- `POST /api/permissions/deny` — Deny pending action.
- `GET /api/settings` — Active configuration.
- `POST /api/settings` — Update configuration.
- `POST /api/agent/run` — Start a task.
- `POST /api/agent/pause` — Pause execution.
- `POST /api/agent/resume` — Resume execution.
- `POST /api/agent/stop` — Terminate running task.

### WebSocket (`/ws`)
- **Server Events**: `init`, `status_update`, `activity_item`, `terminal_chunk`, `todos_update`, `permission_required`.
- **Client Commands**: `run_task`, `pause`, `resume`, `stop`, `approve_permission`, `deny_permission`.
