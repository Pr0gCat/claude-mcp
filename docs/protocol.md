# Claude CLI streaming protocol

## Pinned executable and launch shape

The Windows runtime resolves one absolute Claude executable and rejects versions older than Claude Code 2.1.238. By default it uses `%USERPROFILE%\.local\bin\claude.exe`; `CLAUDE_MCP_CLAUDE_EXECUTABLE` can override that path.

Every process is launched with an argv array, never a composed shell command. The common arguments are:

```text
-p --verbose
--input-format stream-json
--output-format stream-json
--replay-user-messages
--safe-mode
--strict-mcp-config --mcp-config <empty-json-file>
```

A new process adds `--session-id <uuid>`. A reconnect adds `--resume <uuid>` instead. The two flags are never combined.

`read_only` uses `--permission-mode dontAsk` and exposes only `Read,Glob,Grep`. `workspace_write` uses `--permission-mode auto` and exposes only `Read,Glob,Grep,Edit,Write,NotebookEdit,Bash`. Both deny `Agent` and `mcp__*`; read-only also explicitly denies the write tools. Safe mode disables ordinary hooks and customizations, while managed policy can still apply. These are Claude application controls, not an OS sandbox.

## Verified input and output behavior

The input is one JSON object per line:

```json
{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"text","text":"context"}]},"shouldQuery":false}
```

With `--replay-user-messages`, Claude first replays the user frame. For `shouldQuery:false`, Claude Code 2.1.238 then emits an empty success `result` with `num_turns:0` and continues reading the same stdin stream. Omitting `shouldQuery` starts a model query. A `result` frame is therefore an acknowledgement/completion boundary for one input line; it is not an EOF signal and the runtime must not close stdin merely because any result arrived.

The line decoder retains fragmented JSON across transport chunks and accepts unknown JSON event types. All JSON frames, including unknown types and results, are stored with their raw line. Non-JSON output is truncated to a bounded diagnostic and is never forwarded as protocol stdout.

## Windows interruption and reconciliation

Graceful interruption closes the stdin pipe; the ConPTY fallback writes Ctrl+C (`\x03`). If no exit event arrives before the grace deadline, the runtime invokes `taskkill` with the argv `[/PID, <pid>, /T, /F]`. This is best-effort process-tree termination only; v1 does not claim a Windows Job Object guarantee.

The durable lease records server ID, PID, process creation time, acquisition time, and expiry. Cleanup/reconciliation requires the exact PID and creation-time identity plus a confirmed-dead marker. An expired lease alone is insufficient to auto-resume a session. Confirmed-dead reconciliation atomically restores the same running turn and message IDs to queued/pending state before releasing its lease and workspace lock; missing recovery invariants retain ownership and move the agent to `needs_attention`.

Runtime interruption returns the exact identity only after process exit confirmation. Scheduler failure recovery uses that identity to mark and atomically reconcile the confirmed-dead lease; PID-less runtimes retain the legacy recovery path. If interruption is unconfirmed, or if process identity cannot be durably attached, the runtime retains the exact identity when possible, moves the agent to `needs_attention`, and raises an identity-bearing containment error. Scheduler must not release that ownership or create a duplicate process.

A child that exits inside the launch window raises the same identity-bearing error with `ownershipContained=true` and `confirmedDead=true`, allowing Scheduler to reconcile it without another runtime interrupt. If interruption cannot be confirmed and containment persistence itself fails, Scheduler propagates the typed identity error to its caller with both the original operation failure and containment failure retained as causes; it does not run generic recovery.

Whether a CLI session has started is persisted independently from the turn number. A crash/retry of the same turn therefore uses `--resume`; a resume failure is surfaced as a resume-specific error and never falls back to a new `--session-id` process.

The default runtime resolves and version-checks the executable once when its runner factory is created, then records the absolute path and exact version for that server. Process events emitted during process identity lookup or runtime lease attachment are buffered in order and persisted after ownership is ready. Initialization failure closes stdin (or sends Ctrl+C through ConPTY), escalates with best-effort taskkill, and retains an unconfirmed PID lease as `needs_attention` until death can be proven.

## Stall detection

`agent.stalled` is appended when a service-owned `running` turn produces no Claude JSON frame for longer than `CLAUDE_MCP_STALL_TIMEOUT_MS` (default 300000ms). Its payload contains `turnId`, `lastActivityAt`, and the measured `stalledForMs`. The event does not change agent or turn state and does not touch the Claude process; it is purely advisory so a caller polling `wait_agent` can decide to keep waiting or call `interrupt_agent`. A JSON frame only clears the marker when its agent, running turn, and process-lease owner all still match; stale frames remain available in the raw event log for audit but cannot re-arm a successor turn.

## Opt-in live smoke

`npm run smoke:claude` is skipped unless `CLAUDE_MCP_RUN_REAL_CLI_TESTS=1`. When explicitly enabled, it performs an initial read-only query, verifies a zero-turn `shouldQuery:false` context acknowledgement without closing the stream, performs a follow-up query boundary, interrupts, resumes the same session ID, and performs one resumed query. Ordinary automated tests use fake process/CLI implementations and do not make Claude model queries.
