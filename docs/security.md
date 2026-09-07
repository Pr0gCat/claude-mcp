# Security

This document describes the security boundary of `claude-code-subagent-mcp`:
what it protects against, what it explicitly does not, and how to operate it
safely. Read this before pointing `permission_profile: workspace_write` at
anything you don't fully trust.

## Threat model summary

This server is a **local orchestration layer**, not a sandbox. It runs as
your Windows user, launches the Claude Code CLI as your Windows user, and any
tool Claude is allowed to use (in particular `Bash` under `workspace_write`)
runs with your Windows user's full file-system and network access. There is
no containerization, no restricted token, and no network policy.

Treat every agent you spawn as "a process running as me, doing what I told
it, with whatever tools the profile allows" — the same trust level as running
the Claude Code CLI yourself in a terminal.

## Platform and prerequisites

- **Windows 11 only.** Descendant-process cleanup, ACL hardening, and process
  identity confirmation are implemented with Windows-specific mechanisms
  (`taskkill`, PowerShell `Get-Acl`/`Set-Acl`, `Get-Process`/`StartTime`) and
  have no equivalent on other platforms in this version.
- **Node.js 22+**, **Claude Code CLI 2.1.238+**, logged in with a **Claude
  subscription**. The server never reads, stores, or transmits an API key —
  it drives whatever authenticated session the installed CLI already has.
  Anthropic API usage/billing is whatever your Claude Code CLI session
  incurs, not something this server adds on top.

## Permission profiles are not an OS sandbox

`permission_profile` (`read_only` | `workspace_write`) selects **Claude
Code's own application-level tool allow/deny flags** — `--permission-mode`,
`--allowedTools`, `--disallowedTools`. Claude Code enforces these inside its
own process; this server does not additionally sandbox the process at the OS
level (no restricted job, no AppContainer, no network firewall rule, no
filesystem ACL scoped to a workspace).

- `read_only`: `--permission-mode dontAsk`, allows `Read,Glob,Grep`, denies
  `Bash,Edit,Write,NotebookEdit,Agent,mcp__*`.
- `workspace_write`: `--permission-mode auto`, allows
  `Read,Glob,Grep,Edit,Write,NotebookEdit,Bash`, denies `Agent,mcp__*`.

Both profiles also pass `--strict-mcp-config` with an empty, server-generated
MCP config file, so a spawned Claude process cannot see or call any other MCP
server — including this one — and cannot spawn nested subagents via `Agent`.

**Do not treat either profile as a security boundary against a hostile task
prompt or a hostile repository.** In particular:

- `workspace_write` grants `Bash`. Any command Claude decides to run,
  executes as your user with your permissions, against whatever `cwd` you
  passed. There is no allowlist of shell commands.
- Even `read_only` still lets Claude read arbitrary files reachable from
  `cwd` via `Read`/`Glob`/`Grep` — including files outside the intended
  workspace if the model chooses to look, since there is no filesystem
  jail.

## Safe mode, prompts, and managed policy

Every launched Claude process uses `--safe-mode`. Claude Code therefore
starts with its normal customizations disabled, including automatic
repository `CLAUDE.md` discovery, skills, plugins, hooks, configured MCP
servers, custom commands, and agents. Task and follow-up content explicitly
sent through this MCP server still reaches Claude without filtering or
sanitization.

**Managed policy** configured by system or enterprise Claude Code policy is
outside this server's control and may still apply. If you operate in an
environment with an untrusted or attacker-controlled repository, or with
managed policy you don't fully trust, do not rely on this server's
`permission_profile` flags alone to contain it — apply your own OS-level
isolation (a disposable VM, a restricted user account, a container) around
the whole `claude.exe` process tree instead.

## Process containment (best effort)

`interrupt_agent` and turn-boundary cleanup work by:

1. Gracefully closing the Claude process's stdin pipe, or sending `Ctrl+C`
   through the ConPTY fallback, then waiting a short grace period for exit.
2. If it hasn't exited, escalating with `taskkill /PID <pid> /T /F` (a
   Windows process-tree kill).
3. Waiting up to a bounded confirmation window (default 5000 ms) for the exit
   event before giving up on confirming the kill.

This is **best effort, not a guarantee**:

- `taskkill /T` kills the process tree it can enumerate at the moment it
  runs. A descendant process that has already detached from that tree (e.g.
  reparented, or spawned with `DETACHED_PROCESS`) is not guaranteed to be
  reached.
- There is **no Windows Job Object** associating descendants with the
  Claude CLI process's lifetime in this version. Reliable descendant
  containment across abrupt exits (crash, forced kill of the MCP server
  itself) would require a native launcher that assigns the process to a
  kill-on-close Job Object — that is future work, not implemented here.
- If the MCP server process itself is killed ungracefully (e.g. `taskkill
  /F` on the server, not through its SIGINT/SIGTERM/stdin-close shutdown
  path), spawned Claude processes and their descendants are not cleaned up
  by that shutdown path at all; startup reconciliation (below) is what
  eventually reconciles them on the next server start.

Because of this, running `workspace_write` tasks that themselves spawn
long-lived or detaching child processes should be treated as "may outlive
the agent" — check Task Manager / `Get-Process` if you need certainty that
nothing is still running.

## Startup process reconciliation and `needs_attention`

On every server startup, each persisted runtime lease is checked against the
live Windows process table by exact PID **and** exact process creation time
(via PowerShell `Get-Process`). Only a lease that is positively confirmed
dead by that exact match is safely requeued automatically.

Any lease the server cannot positively confirm dead — missing
PID/creation-time, an inconclusive inspection, or a live process whose
creation time still matches — moves the agent to `needs_attention` rather
than being auto-resumed. This is a deliberate safety choice: the server will
never risk `--resume`-ing a Claude session that might still be an actively
running process elsewhere, since two processes sharing one Claude session id
could corrupt session state. An agent in `needs_attention` refuses new
messages/followups (`invalid_state`) until you resolve it (confirm the old
process is gone, then interrupt or otherwise clear it).

## State, persistence, and privacy

- All state lives in one local SQLite database (WAL mode) under the state
  directory (default `%USERPROFILE%\.claude-mcp`, overridable with
  `CLAUDE_MCP_STATE_DIR`). This includes task prompts, queued messages, and
  Claude's turn output — stored locally because follow-up turns and crash
  recovery need them.
- On startup the server best-effort restricts that directory to a
  current-user-only Windows ACL (removes inherited rules, grants
  `FullControl` only to the identity running the server) via PowerShell
  `Get-Acl`/`Set-Acl`. This can silently fail under local policy that
  forbids ACL changes — it reduces exposure to other local accounts on
  shared machines, it does not guarantee it.
- Diagnostics/logs (stderr) never include environment variables, auth
  output, or full prompt/output content — only sanitized identifiers such as
  agent IDs and stable error codes.
- There is no automatic retention limit or expiry. Deleting history means
  stopping every server/client process using the state directory and
  manually deleting the directory (see the README's
  [State retention and cleanup](../README.md#state-retention-and-cleanup)).
  There is no per-agent delete/redact tool.

## Error surface

All tool errors are sanitized to one of seven stable codes
(`agent_not_found`, `invalid_state`, `cursor_expired`, `cli_unavailable`,
`resume_failed`, `permission_denied`, `internal_error`) with a generic
message and only non-sensitive `details` (`agent_id`, `state`,
`process.{pid,started_at}`). Raw exception messages, stack traces, and
environment values are never surfaced to the MCP client.

## Reporting a concern

This is a local developer tool without a hosted service or bug bounty. If
you find a security issue, open it as a normal issue/PR against this
repository with reproduction steps.
