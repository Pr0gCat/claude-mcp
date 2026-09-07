# claude-code-subagent-mcp

A local STDIO MCP server that lets a Codex-like MCP client coordinate the
installed **Claude Code CLI** as Codex-style subagents. The server only
launches and drives the Claude Code executable on your machine; it never
calls the Anthropic API or the Claude Agent SDK directly, and it never holds
its own API key.

It gives Codex a familiar agent lifecycle over MCP:

- Spawn read-only or workspace-writing Claude agents.
- Choose a Claude model and effort level with built-in routing guidance.
- Send context without starting a turn, or queue an actionable follow-up.
- Wait on durable events, inspect results, detect stalls, and interrupt work.
- Resume Claude sessions safely after idle eviction or a confirmed process
  exit.

```text
Codex / MCP client
        |
        v
STDIO MCP server ---- SQLite state, mailbox, events, and leases
        |
        v
Claude Code CLI processes (maximum four at once)
```

## Requirements

- **Windows 11.** This project is Windows-only: process lifecycle
  (`taskkill`, PowerShell ACL/process inspection, ConPTY) is implemented with
  Windows-specific tooling and is not portable to macOS/Linux.
- **Node.js 22 or newer.**
- **Claude Code CLI 2.1.238 or newer**, installed and logged in with a
  **Claude subscription** (Pro/Max/Team login via `claude login` or
  equivalent). The server does not read or supply an API key — it drives
  whatever session the installed CLI already has.
- The Claude executable must be reachable either at the default path
  (`%USERPROFILE%\.local\bin\claude.exe`) or via `CLAUDE_MCP_CLAUDE_EXECUTABLE`
  (see [Configuration](#configuration)). At startup the server runs
  `claude --version` and refuses to spawn agents against anything older than
  2.1.238.

## Quick start

```powershell
git clone https://github.com/Pr0gCat/claude-mcp.git
cd claude-mcp
npm ci
npm run build
codex mcp add claude_subagents -- node "$PWD\dist\index.js"
codex mcp list
```

`npm run build` compiles `src/` to `dist/` via `tsc -p tsconfig.build.json`.
The built entrypoint is `dist/index.js`. Restart Codex after adding the
server; the ChatGPT desktop app, Codex CLI, and IDE extension share the MCP
configuration for the same Codex host.

The `codex mcp add` command above follows the official Codex STDIO MCP
configuration format. If you prefer to edit the configuration directly, use
the [`config.toml` example](#manual-configtoml) below.

### Local package installation

This package is intentionally marked `private`: it is not published to the
public npm registry, and `npm publish` is deliberately blocked. The supported
release path is local installation from a checked-out source tree or a local
tarball. To create and install a self-contained local package:

```powershell
npm pack # runs prepack, rebuilds dist, and creates claude-code-subagent-mcp-0.1.0.tgz
npm install --global .\claude-code-subagent-mcp-0.1.0.tgz
claude-subagent-mcp
```

For a project-local install, replace the global install command with
`npm install --save-dev .\claude-code-subagent-mcp-0.1.0.tgz`, then run
`npx --no-install claude-subagent-mcp`. The compiled bin entrypoint contains
a Node shebang, and npm creates the Windows command shim during installation.

### Manual start

```powershell
npm start
```

or directly:

```powershell
node dist/index.js
```

The server speaks MCP over stdio only. It writes protocol frames to stdout
and diagnostics to stderr; nothing else should ever reach stdout.

### Manual `config.toml`

Point Codex (or any MCP client that reads a TOML `mcp_servers` table) at the
built entrypoint using an **absolute Windows path**:

```toml
[mcp_servers.claude_subagents]
command = "node"
args = ["C:\\absolute\\path\\to\\claude-mcp\\dist\\index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 300
```

Replace the path with the absolute path to your clone's `dist\index.js`.
`tool_timeout_sec` should stay generous: `wait_agent` is a long-poll tool and
Claude turns can legitimately run for minutes.

Codex reads user-level MCP configuration from `~/.codex/config.toml`; trusted
projects may instead use `.codex/config.toml`. You can also manage the server
with `codex mcp add`, `codex mcp list`, and the `/mcp` command.

## Configuration (environment variables)

| Variable | Purpose |
| --- | --- |
| `CLAUDE_MCP_STATE_DIR` | Overrides the state directory. Defaults to `%USERPROFILE%\.claude-mcp`. Must not be set to an empty string. |
| `CLAUDE_MCP_CLAUDE_EXECUTABLE` | Overrides the path to the Claude Code executable. Defaults to `%USERPROFILE%\.local\bin\claude.exe`. Must not be set to an empty string. |
| `CLAUDE_MCP_STALL_TIMEOUT_MS` | Emits an advisory `agent.stalled` event after this many milliseconds without a Claude JSON frame. Defaults to `300000` (5 minutes) and must be a positive integer. It never kills or interrupts Claude. |

The state directory is normalized to an absolute path when the MCP server
starts, including when `CLAUDE_MCP_STATE_DIR` is relative. The generated
`empty-mcp.json` path therefore stays anchored to the server's startup
directory and cannot be reinterpreted relative to an agent workspace.

The state directory holds one SQLite database (`state.sqlite`, WAL mode) that
is the source of truth for every agent, turn, message, lease, workspace lock,
and the append-only event log, plus a generated empty MCP config
(`empty-mcp.json`) used to keep spawned Claude processes isolated from any
other MCP servers on your machine.

On startup the server best-effort restricts the state directory to a
current-user-only Windows ACL (it removes inherited access rules and grants
`FullControl` only to the identity running the server). This uses
PowerShell's `Get-Acl`/`Set-Acl` and can silently no-op under local policy
that forbids ACL changes — it is defense in depth, not a guarantee.

### State retention and cleanup

There is no automatic pruning, expiry, or size cap on the state database.
Prompts, Claude output, and event history persist indefinitely because
follow-up turns and crash recovery need them. If you want to reclaim space or
remove history:

1. Stop every MCP client / server process using that state directory.
2. Delete the state directory (default `%USERPROFILE%\.claude-mcp`, or
   whatever `CLAUDE_MCP_STATE_DIR` pointed at) manually.

There is no built-in per-agent delete or archive tool — cleanup is
directory-level and manual.

## The eight tools

All inputs/outputs use snake_case JSON. Every response is returned as both
`structuredContent` and a JSON text block; tool failures set `isError: true`
and return a stable `{ error: { code, message, details? } }` shape (see
[Errors](#errors)).

### `spawn_agent`

Creates a new logical agent and starts its first turn.

- Input: `task` (required), `cwd`, `permission_profile`
  (`read_only` | `workspace_write`, default `read_only`), `model`, `effort`,
  `name`.
- Output: `agent_id`, `session_id`, `turn_id`, `state`, `cursor`.

Model routing is included in the MCP schema so Codex sees it before spawning:

- Omit `model` for Claude Code's local default.
- `fable`: routine implementation and bounded fixes.
- `sonnet`: complex coding, debugging, and review.
- `opus`: the hardest architecture, security, or escalation work.
- Use `effort: low` for mechanical work, `medium` for normal coding, `high`
  for debugging/review, and `xhigh` or `max` only for unusually hard tasks.

Aliases track the models installed by Claude Code; pass a full model ID only
when an exact version is required.

### `list_models`

Returns the `default`, `fable`, `sonnet`, and `opus` choices, task-routing
guidance, supported effort levels, and whether full model IDs are accepted.
Claude Code validates actual account availability when `spawn_agent` starts;
the MCP does not claim that every alias is enabled for the current account.

### `send_message` vs `followup_task`

Both queue a message into the agent's durable mailbox; they differ in
whether they cause Claude to start a new model turn:

- **`send_message`** queues context with `shouldQuery: false`. If the agent's
  Claude process is currently live/streaming, the message is written into
  that process's input stream immediately but does **not** trigger a new
  query — it just becomes available context for whichever turn asks for it
  next. If the agent is disconnected or queued, the message waits in the
  mailbox. The response reports whether it is still `queued_only` and the
  current `mailbox_depth`, so callers can distinguish "delivered to a live
  process" from "sitting in the database."
- **`followup_task`** queues a message with `shouldQuery: true`. If the agent
  is `idle`, this immediately starts the next turn. If a turn is already
  `running`, the followup is durably ordered and starts as soon as the
  current turn reaches a turn boundary. The response reports the resulting
  agent `state` (e.g. `running`) instead of a `queued_only` flag.

Use `send_message` to hand an agent extra context without spending a turn;
use `followup_task` when you want Claude to actually act on it next.

Both reject with `invalid_state` when the agent is `closed`, `cancelling`, or
`needs_attention`.

### `wait_agent`

Long-polls the durable, global, monotonically increasing event stream for one
to eight agents.

- Input: `agent_ids` (1–8), `after_cursor` (decimal string, default `"0"`),
  `timeout_ms` (0–600000, default `30000`).
- Output: `events`, `cursor`, `timed_out`.

A timeout returns normally with `timed_out: true` and the unchanged/advanced
cursor — it is not an error. An `after_cursor` newer than the latest known
event, or a syntactically invalid cursor, fails with `cursor_expired`.

If a running Claude process emits no JSON frame for the configured stall
timeout, this stream receives one `agent.stalled` event for that inactivity
period. It is a warning, not a terminal state: Codex can keep waiting, inspect
the agent with `read_agent`, or explicitly call `interrupt_agent`.

### `interrupt_agent`

Durably requests interruption of the agent's active turn. Any server
instance can request it; only the instance that owns the live runtime
performs it. See [Interrupt and process cleanup](#interrupt-and-process-cleanup-best-effort)
for what "interrupt" actually does at the OS level.

- Input: `agent_id`.
- Output: `state`, `interrupted`, `cursor`.

### `list_agents`

No input. Lists every persisted agent with `state`, `last_turn_status`,
`pending_message_count`, `cwd`, `permission_profile`, `last_activity_at`,
`stalled`, and timestamps. `stalled: true` means the current running turn has
already emitted its advisory stall event; the process is still running.

### `read_agent`

Reads persisted turn outcomes and semantic events for one agent, with
pagination.

- Input: `agent_id`, `after_cursor` (default `"0"`), `limit` (1–1000, default
  `100`), `include_raw` (default `false`), `after_raw_cursor` (default
  `"0"`).
- Output: `agent` (including `last_activity_at` and `stalled`), `turns`,
  `events`, `cursor`, `has_more`, and — only when
  `include_raw: true` — `raw_events` and `raw_cursor`.

See [Raw event pagination](#raw-event-pagination) below for how
`after_cursor`/`cursor` and `after_raw_cursor`/`raw_cursor` relate.

## Typical Codex workflow

1. Call `list_models` and choose the cheapest model suited to the task.
2. Call `spawn_agent` with a concrete task, workspace, and permission profile.
3. Pass the returned cursor to `wait_agent`; keep passing the newest cursor on
   later waits.
4. Use `send_message` for extra context or `followup_task` when Claude should
   perform another turn.
5. If `agent.stalled` appears, inspect with `read_agent`, wait longer, or call
   `interrupt_agent`. A stall event is advisory and never kills Claude by
   itself.

Agents and events persist in SQLite, so callers can recover state with
`list_agents` and `read_agent` instead of keeping everything in chat context.

## Permission profiles

`permission_profile` selects one of two **Claude Code application-level**
tool policies passed as CLI flags; it is **not an OS-level sandbox**:

- **`read_only`**: `--permission-mode dontAsk` with `--allowedTools
  Read,Glob,Grep` and `--disallowedTools Bash,Edit,Write,NotebookEdit,Agent,mcp__*`.
- **`workspace_write`**: `--permission-mode auto` with `--allowedTools
  Read,Glob,Grep,Edit,Write,NotebookEdit,Bash` and `--disallowedTools
  Agent,mcp__*`.

Both profiles pass `--strict-mcp-config` with an empty, server-generated MCP
config, so a spawned Claude process cannot reach any other MCP server
(including this one) or spawn nested subagents.

`--safe-mode` also disables Claude Code's normal customizations, including
automatic repository `CLAUDE.md` discovery, skills, plugins, hooks, custom
commands, agents, and configured MCP servers. The task and follow-up text sent
through this MCP server still reach Claude normally.

Important caveats:

- These are Claude's own allow/deny tool flags, enforced by Claude Code
  itself. They do **not** sandbox the OS process — a `workspace_write` agent
  runs with your Windows user's own file-system and network permissions for
  any tool it is allowed to use (notably `Bash`). Do not point
  `workspace_write` at anything you would not let your own shell touch.
- Managed policy enforced by system/enterprise Claude Code configuration is
  outside this server's control and may still apply. Do not rely on this
  server alone to enforce a security boundary in an environment with
  untrusted managed policy or untrusted repository content.

## Process model

Each live agent owns at most one long-running Claude CLI process. The normal
`claude.exe` path uses native stdin/stdout/stderr pipes with `-p --input-format
stream-json --output-format stream-json --verbose --replay-user-messages
--safe-mode --strict-mcp-config` and a caller-generated `--session-id` (or
`--resume` for a reconnect). Windows `.cmd`/`.bat` wrappers use ConPTY instead
of enabling a command shell. At most four Claude processes run concurrently
across all agents; idle processes may be evicted and later resumed.

### Stall detection

Each owned running turn records `last_activity_at` whenever Claude emits a
JSON frame. After `CLAUDE_MCP_STALL_TIMEOUT_MS` without another frame, the
lease-owning server appends exactly one `agent.stalled` event for that quiet
period. New activity clears the marker and re-arms detection.

This is deliberately advisory. The agent remains `running`, its process and
workspace lock remain owned, and the server does not send Ctrl+C or `taskkill`.
Long model reasoning or a slow tool can look the same as a true hang from the
outside, so Codex must decide whether to wait longer or call
`interrupt_agent`. `list_agents` and `read_agent` expose `last_activity_at`
and the derived `stalled` flag for that decision.

A canonical-workspace reader/writer lock (Windows path/case-normalized, and
git-repo-root-aware) allows multiple concurrent `read_only` agents in the
same workspace but makes a `workspace_write` agent exclusive against both
readers and writers there.

### Startup and `needs_attention`

On startup the server reconciles every persisted runtime lease against the
live OS process table (PID plus exact process creation time, via
PowerShell). A lease that can be positively confirmed dead is safely
requeued. Anything the server cannot positively confirm dead — no
PID/creation-time recorded, the process inspection is inconclusive, or the
PID+creation-time still matches a live process — moves the agent to
`needs_attention` instead of being auto-resumed. This is intentional: the
server will never risk resuming a Claude session that might still be running
under a duplicate process. An agent in `needs_attention` rejects
`send_message`/`followup_task` with `invalid_state`; use `interrupt_agent` or
inspect the process manually, then send a new followup once it clears.

### Interrupt and process cleanup (best effort)

`interrupt_agent` gracefully closes the stdin pipe (or sends `Ctrl+C` through
the ConPTY fallback) and waits a short grace period for the process to exit
on its own. If it doesn't, the server escalates with Windows
`taskkill /PID <pid> /T /F`
(tree-kill) and then waits up to a bounded confirmation window (default
5000&nbsp;ms) for the exit callback before giving up on confirmation.
`taskkill` is a best-effort fallback — process exit, when observed, is what's
authoritative, not the `taskkill` call succeeding.

There is **no Windows Job Object** tying descendant processes to the Claude
CLI process's lifetime in this version, so a `taskkill /T` tree-kill is the
only descendant cleanup mechanism. A descendant that detaches itself from
the process tree before the kill (or that `taskkill` otherwise cannot reach)
can outlive the agent. Reliable descendant containment would require a
future native launcher; treat this as best-effort, not a guarantee, when
running untrusted tasks under `workspace_write`.

## Errors

Every failed tool call returns `isError: true` with
`{ error: { code, message, details? } }` using one of these stable codes:

| Code | Meaning |
| --- | --- |
| `invalid_input` | Tool arguments are missing, have the wrong type/range, or contain unknown fields. The service is not called. |
| `agent_not_found` | The `agent_id` does not exist in this server's state. |
| `invalid_state` | The requested operation is not valid for the agent's current state (e.g. messaging a `closed`/`cancelling`/`needs_attention` agent). |
| `cursor_expired` | `after_cursor` / `after_raw_cursor` is syntactically invalid or newer than the latest known event. |
| `cli_unavailable` | The Claude executable could not be found/executed, or failed its version check. |
| `resume_failed` | `--resume` of an existing Claude session failed. |
| `permission_denied` | The operation hit an OS-level permission error (e.g. `EACCES`/`EPERM`). |
| `internal_error` | Anything else, including process-containment failures. |

Error messages and `details` are sanitized: they never include environment
variables, prompt/output content, or auth material. `details` may include
`agent_id`, `state`, and/or `process.{pid,started_at}` when relevant.
Invalid-input responses use the fixed message `Invalid tool arguments.` and do
not expose Zod validation issues or stack traces.

## Raw event pagination

`read_agent` exposes two independent cursors:

- `after_cursor` / response `cursor`: pages through **semantic** events
  (`agent.*`, `turn.*`, `message.enqueued`) — the durable event stream also
  used by `wait_agent`.
- `after_raw_cursor` / response `raw_cursor` (only present when
  `include_raw: true`): separately pages through **raw Claude CLI** JSON
  lines (`raw_events`), retained mainly for diagnostics. These have their
  own sequence numbers and cursor space — do not mix a `cursor` value into
  `after_raw_cursor` or vice versa.

Both cursors are decimal strings from a monotonically increasing sequence;
`"0"` means "from the beginning." `has_more` only reflects pagination of the
semantic `events` page, not the raw page.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| MCP server does not appear | Run `npm run build`, confirm the configured `dist\index.js` path is absolute, then run `codex mcp list` and restart Codex. |
| `cli_unavailable` | Run `claude --version`, confirm Claude Code is at least 2.1.238, and set `CLAUDE_MCP_CLAUDE_EXECUTABLE` if it is not installed at the default path. |
| Agent remains `running` | Check `last_activity_at` and `stalled` with `list_agents`; use `read_agent` before deciding whether to wait or interrupt. |
| Agent is `needs_attention` | The server could not prove the previous PID and creation time are dead. Inspect or interrupt that process before sending another follow-up. |
| A write task is denied | Confirm the agent was spawned with `permission_profile: "workspace_write"`; managed Claude Code policy can still deny operations. |

## Testing

```powershell
npm test              # full suite, fake CLI only — no Anthropic API/model usage
npm run typecheck
npm run build
```

The end-to-end suite (`test/e2e.test.ts`) builds the project, then drives the
real `dist/index.js` STDIO server over the real MCP client/transport against
a fake Claude executable (`test/fixtures/fake-claude-cli.cmd`), using a
temporary state directory injected via `CLAUDE_MCP_STATE_DIR` and
`CLAUDE_MCP_CLAUDE_EXECUTABLE`. It never touches the Anthropic API or your
installed Claude CLI.

### Opt-in real Claude smoke test

```powershell
npm run smoke:claude
```

This runs `test/claude-real-smoke.test.ts`, which spawns your **actually
installed, logged-in** Claude Code CLI and will consume real model
usage/tokens against your subscription. It is intentionally excluded from
`npm test` and must be run explicitly and deliberately.

## Security

See [`docs/security.md`](docs/security.md) for the full security boundary,
threat model, and hardening notes.
