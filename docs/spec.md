# Claude Code Subagent MCP Specification

## Goal

Build a local STDIO MCP server that lets Codex coordinate the installed Claude Code CLI through a Codex-like subagent interface. The server talks only to the Claude Code executable; it does not use the Anthropic API or Claude Agent SDK.

## Supported platform

- Windows 11
- Node.js 22 or newer
- Claude Code CLI 2.1.238 or newer
- One OS user; all MCP clients for that user share one agent namespace
- Default state directory: `%USERPROFILE%\.claude-mcp`; override with `CLAUDE_MCP_STATE_DIR`

## MCP tools

### `spawn_agent`

Creates a logical agent and starts its first turn.

Input: `task`, optional `cwd`, `permission_profile` (`read_only` or `workspace_write`), optional `model`, optional `effort`, optional `name`.

Output: stable `agent_id`, `session_id`, current agent state, first `turn_id`, and current event cursor.

### `send_message`

Adds a message to an existing agent. For a live streaming Claude process, the message is delivered with `shouldQuery: false`, so it joins the agent context without starting a model turn. For a disconnected or queued agent it remains pending. The response explicitly reports `queued_only` and mailbox depth.

### `followup_task`

Adds a message with `shouldQuery: true`. If the agent is idle it begins the next turn; if it is running, the message is durably ordered and starts after the current turn reaches a boundary.

### `wait_agent`

Long-polls a durable event stream. It accepts one to eight agent IDs, an optional cursor, and a bounded timeout. The cursor is a global monotonically increasing event sequence encoded as a decimal string. A timeout returns normally with the unchanged/new cursor.

### `interrupt_agent`

Moves the active turn to `cancelling`, gracefully closes the stdin pipe (or sends Ctrl+C through the ConPTY fallback), then escalates after a bounded grace period with Windows `taskkill /PID /T /F`. Completion and cancellation race through a single transactional terminal-state update. Escalated descendant cleanup is explicitly best-effort in v1; reliable Job Object ownership requires a future native launcher.

### `list_agents`

Lists logical agents, state, last turn outcome, pending-message count, workspace, permission profile, and timestamps.

### `read_agent`

Reads persisted turn results and events for one agent, with pagination. Raw CLI events may be retained for diagnostics but are not returned unless requested.

## State model

Agent states are independent from turn outcomes.

- Agent: `new | queued | running | idle | cancelling | disconnected | needs_attention | closed`
- Turn: `queued | running | succeeded | failed | interrupted | timed_out`
- Message: `pending | leased | acknowledged`

Every message has an immutable UUID. A scheduler transaction leases ordered pending messages to an immutable turn input manifest. Messages are acknowledged only after a terminal turn record is committed. Delivery is **at least once** after a crash; the server never claims exactly-once execution.

## Process model

Each live agent owns one long-running Claude CLI process launched with `-p`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--replay-user-messages`, and a caller-generated `--session-id`. Reconnected agents use `--resume` with that session ID.

At most four Claude processes run concurrently. Idle processes may be evicted to make room and later resumed. A canonical workspace reader/writer lock permits concurrent `read_only` agents but makes a `workspace_write` agent exclusive against both readers and writers for the same physical workspace.

The Claude executable is resolved once to an absolute path, version-checked, and recorded. A process lease contains server ID, PID, process creation time, and expiry. On restart, an agent whose previous process may still be alive enters `needs_attention`; it is never automatically resumed into a possible duplicate session.

## Stall detection

Every `running` agent tracks `last_activity_at`, updated whenever its currently owned, still-running Claude turn emits a JSON frame (or when its turn starts). If a configurable timeout (`CLAUDE_MCP_STALL_TIMEOUT_MS`, default 300000ms) elapses with no activity, the process-lease owner appends exactly one advisory `agent.stalled` public event and leaves the agent `running`; it never interrupts or kills the Claude process and never releases scheduler ownership on its own. The event records `turnId`, `lastActivityAt`, and the measured `stalledForMs`. Matching new activity clears the stall marker and re-arms detection for the next inactivity period; a stale frame is retained in the raw audit log but cannot re-arm a successor. `agent.stalled` is advisory only — Codex must inspect the situation and decide whether to keep waiting or call `interrupt_agent`. Detection runs on the existing pump and is safe across MCP process restarts and multiple concurrent MCP instances sharing one SQLite database: each instance checks only its own leases and a conditional transactional update prevents duplicate events. `list_agents` and `read_agent` expose `last_activity_at` and a derived `stalled` boolean.

## Permission profiles

`read_only` uses Claude tool allow/deny flags and `dontAsk`; it permits Read, Glob, and Grep and denies Bash, Edit, Write, NotebookEdit, Agent, and MCP tools.

`workspace_write` uses Claude `auto` mode and permits Read, Glob, Grep, Edit, Write, NotebookEdit, and Bash while denying Agent and MCP tools.

Both profiles pass an empty strict MCP configuration and disable ordinary hooks. Managed policy hooks may still execute. These profiles are Claude application-level controls, **not an OS sandbox**; the documentation must not claim otherwise.

## Persistence and privacy

SQLite in WAL mode is the source of truth for agents, turns, messages, leases, locks, and the append-only event log. State transitions and event creation occur in one transaction. Prompt and output payloads are stored locally because follow-up and recovery require them. The state directory receives a current-user-only Windows ACL when possible. Logs never include environment variables, auth output, or full prompts.

## Acceptance criteria

1. Fake-CLI integration tests cover spawn, multiple streaming messages, malformed/unknown JSON events, completion, crash, resume failure, interrupt escalation, and best-effort descendant cleanup.
2. State tests cover ordered mailbox leasing, at-least-once crash recovery, one terminal outcome, global cursor waits without lost wakeups, and two server instances sharing one database.
3. Workspace lock tests cover Windows case normalization and repo-root/subdirectory aliases.
4. A real Claude CLI smoke test proves initial stream input, non-query message delivery, follow-up query, session resume, and graceful interrupt; it is opt-in to avoid unrequested model usage in ordinary test runs.
5. The full automated test suite, typecheck, and build pass.
