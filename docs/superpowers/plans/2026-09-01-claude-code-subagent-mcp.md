# Claude Code Subagent MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local STDIO MCP server exposing a Codex-like seven-tool subagent interface backed exclusively by Claude Code CLI.

**Architecture:** A TypeScript MCP layer calls a transactional agent service backed by SQLite WAL. A scheduler owns durable mailbox delivery, workspace reader/writer locks, and at most four persistent Claude stream-json processes; a PTY runner supplies Windows Ctrl+C and best-effort process-tree cleanup.

**Tech Stack:** Node.js 22+, TypeScript, Vitest, `@modelcontextprotocol/sdk`, Zod, `better-sqlite3`, `node-pty`

**Spec:** `docs/spec.md`

## Global Constraints

- Windows 11 and Node.js 22 or newer.
- Claude Code CLI 2.1.238 or newer, accessed only through its executable.
- No Anthropic API and no Claude Agent SDK dependency.
- Exactly seven public MCP tools: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`, `read_agent`.
- At most four concurrent Claude processes.
- Permission profiles are `read_only` and `workspace_write`; neither is documented as an OS sandbox.
- Durable message delivery is at least once, never described as exactly once.
- Windows hard-cancel uses `taskkill /PID /T /F` as a documented best-effort fallback; v1 does not claim Job Object guarantees.
- All production behavior is introduced through a witnessed failing test.

---

### Task 1: Project shell and durable store

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/domain.ts`, `src/config.ts`, `src/store.ts`
- Test: `test/store.test.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: `AgentStore`, `openStore(path)`, `loadConfig(env)`, and the domain unions in `src/domain.ts`.
- `AgentStore.createAgent(input)` returns `{agent, turn}` and appends an `agent.created` event transactionally.
- `AgentStore.enqueueMessage(agentId, kind, content)` returns the immutable message and event cursor.
- `AgentStore.readEvents({agentIds, after, limit})` orders rows by global numeric sequence.

- [ ] **Step 1: Write failing store/config tests**

```ts
it('creates an agent and its first turn in one durable transaction', () => {
  const { agent, turn } = store.createAgent(fixture);
  expect(agent.state).toBe('queued');
  expect(turn.status).toBe('queued');
  expect(store.readEvents({ agentIds: [agent.id], after: 0, limit: 10 })[0].type)
    .toBe('agent.created');
});
```

- [ ] **Step 2: Run `npm test -- test/store.test.ts test/config.test.ts` and confirm failure is missing production modules.**
- [ ] **Step 3: Add the schema, WAL initialization, transactions, configuration validation, and current-user state-directory creation.**
- [ ] **Step 4: Re-run the focused tests, then `npm run typecheck`; both must pass.**
- [ ] **Step 5: Commit with `feat: add durable agent store`.**

### Task 2: Mailbox, event cursor, and scheduler

**Files:**
- Create: `src/scheduler.ts`, `src/workspace.ts`, `src/event-waiter.ts`
- Modify: `src/store.ts`, `src/domain.ts`
- Test: `test/scheduler.test.ts`, `test/event-waiter.test.ts`, `test/workspace.test.ts`

**Interfaces:**
- Consumes: `AgentStore` transactions and domain records from Task 1.
- Produces: `Scheduler.enqueue(agentId)`, `Scheduler.onTurnBoundary(agentId)`, `EventWaiter.wait(agentIds, after, timeoutMs, signal)`, and `canonicalWorkspace(cwd)`.
- Scheduler dependencies implement `AgentRuntime.start(agent, turn, messages)` and `AgentRuntime.deliver(agent, message, shouldQuery)`.

```ts
export interface AgentRuntime {
  start(agent: Agent, turn: Turn, messages: readonly Message[]): Promise<void>;
  deliver(agent: Agent, message: Message, shouldQuery: boolean): Promise<void>;
  interrupt(agentId: string): Promise<void>;
}

export interface WaitResult {
  events: Event[];
  cursor: string;
  timedOut: boolean;
}
```

- [ ] **Step 1: Write failing tests proving ordered message leasing, unique acknowledgement, four-process limit, writer exclusivity, reader coexistence, and an event arriving immediately before subscription is not lost.**

```ts
it('never loses an event committed at the subscription boundary', async () => {
  const after = store.latestCursor();
  const waiting = waiter.wait([agent.id], after, 250);
  store.enqueueMessage(agent.id, 'message', 'context');
  const result = await waiting;
  expect(result.timedOut).toBe(false);
  expect(result.events.map((event) => event.type)).toEqual(['message.enqueued']);
});

it('does not run a writer beside a reader for the same git workspace', async () => {
  scheduler.enqueue(reader.id);
  scheduler.enqueue(writer.id);
  await scheduler.drain();
  expect(runtime.startedAgentIds()).toEqual([reader.id]);
});
```
- [ ] **Step 2: Run `npm test -- test/scheduler.test.ts test/event-waiter.test.ts test/workspace.test.ts` and confirm the expected missing-behavior failures.**
- [ ] **Step 3: Implement FIFO scheduling, transactional lease/ack, cross-process database locks, canonical Windows workspace keys, and a condition-variable waiter that always re-reads the event log after waking.**
- [ ] **Step 4: Re-run focused tests and `npm run typecheck`; all must pass without leaked timers or handles.**
- [ ] **Step 5: Commit with `feat: add durable agent scheduler`.**

### Task 3: Claude stream-json and Windows process control

**Files:**
- Create: `src/claude/arguments.ts`, `src/claude/protocol.ts`, `src/claude/runner.ts`, `src/claude/runtime.ts`
- Create: `test/fixtures/fake-claude.mjs`
- Test: `test/claude-arguments.test.ts`, `test/claude-protocol.test.ts`, `test/claude-runtime.test.ts`

**Interfaces:**
- Consumes: `AgentRuntime` from Task 2 and persisted session/turn/message records.
- Produces: `buildClaudeArgs(profile, options)`, `JsonLineDecoder`, `ClaudeRunner`, and `ClaudeRuntime`.
- `ClaudeRunner.sendUserMessage(text, shouldQuery)` writes one structured JSON line; `interrupt(graceMs)` sends Ctrl+C then escalates to documented best-effort process-tree termination.

```ts
export interface StreamUserFrame {
  type: 'user';
  parent_tool_use_id: null;
  message: { role: 'user'; content: Array<{ type: 'text'; text: string }> };
  shouldQuery?: false;
}

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}
```

Initial CLI arguments include `-p --verbose --input-format stream-json --output-format stream-json --replay-user-messages --safe-mode`. A new session uses `--session-id <uuid>`; a resumed session uses `--resume <uuid>`, never both. `read_only` uses `dontAsk` and exposes only Read/Glob/Grep; `workspace_write` uses `auto` and exposes Read/Glob/Grep/Edit/Write/NotebookEdit/Bash. Both deny Agent and `mcp__*`, disable ordinary hooks, and use strict empty MCP configuration.

Every input line produces a result frame. A result corresponding to `shouldQuery:false` acknowledges context delivery but does not close stdin or complete a turn. A result corresponding to a query frame completes the current turn and invokes the scheduler boundary callback. Unknown JSON event types are persisted/tolerated; non-JSON PTY noise goes to bounded diagnostics, not stdout.

- [ ] **Step 1: Write failing tests for exact permission arguments, fragmented JSON lines, unknown event tolerance, stderr separation, initial session versus resume, non-query delivery, and interrupt escalation.**

```ts
it('keeps the stream open after a context-only result', async () => {
  await runtime.start(agent, firstTurn, []);
  await runtime.deliver(agent, contextMessage, false);
  fakePty.emitData('{"type":"result","subtype":"success","result":"","num_turns":0}\r\n');
  expect(fakePty.ended).toBe(false);
  expect(boundaries).toEqual([]);
});

it('uses resume instead of session-id when reconnecting', () => {
  expect(buildClaudeArgs('read_only', { sessionId: 's', resume: true, emptyMcpConfig: 'empty.json' }))
    .toContain('--resume');
});
```
- [ ] **Step 2: Run `npm test -- test/claude-arguments.test.ts test/claude-protocol.test.ts test/claude-runtime.test.ts` and confirm failures name the missing adapter behavior.**
- [ ] **Step 3: Implement the smallest stream-json adapter using argv arrays only, a pinned/version-checked executable, PTY Ctrl+C on Windows, `taskkill /PID /T /F` after the grace deadline, process PID/creation-time lease metadata, and durable raw-event/result handling. Never auto-resume when the previous PID/creation time cannot be proven dead.**
- [ ] **Step 4: Run focused tests and the opt-in `npm run smoke:claude` only when `CLAUDE_MCP_RUN_REAL_CLI_TESTS=1`; record the exact CLI protocol behavior in `docs/protocol.md`.**
- [ ] **Step 5: Commit with `feat: integrate Claude Code streaming CLI`.**

### Task 4: Agent service and MCP tools

**Files:**
- Create: `src/agent-service.ts`, `src/tools.ts`, `src/server.ts`, `src/index.ts`
- Test: `test/agent-service.test.ts`, `test/tools.test.ts`, `test/server.test.ts`

**Interfaces:**
- Consumes: store, scheduler, waiter, and Claude runtime from Tasks 1-3.
- Produces: `AgentService` methods matching the seven tools and `createServer(service)` connected by STDIO in `src/index.ts`.
- Tool errors use stable codes: `agent_not_found`, `invalid_state`, `cursor_expired`, `cli_unavailable`, `resume_failed`, `permission_denied`, `internal_error`.

```ts
export interface AgentServiceApi {
  spawnAgent(input: SpawnAgentInput): Promise<{ agentId: string; sessionId: string; turnId: string; state: AgentState; cursor: string }>;
  sendMessage(agentId: string, message: string): Promise<{ messageId: string; queuedOnly: boolean; mailboxDepth: number; cursor: string }>;
  followupTask(agentId: string, message: string): Promise<{ messageId: string; state: AgentState; cursor: string }>;
  waitAgent(agentIds: readonly string[], afterCursor: string, timeoutMs: number): Promise<WaitResult>;
  interruptAgent(agentId: string): Promise<{ state: AgentState; interrupted: boolean; cursor: string }>;
  listAgents(): AgentSummary[];
  readAgent(agentId: string, afterCursor: string, limit: number, includeRaw: boolean): AgentReadPage;
}
```

`spawnAgent` stores the initial task as a durable `followup` message in the same SQLite transaction that creates the agent and first turn; there is no crash window containing an empty first turn. Every semantic transition appends a public event in its state transaction, including turn start/result/failure/interruption and needs-attention. `wait_agent` consumes these events rather than polling private Claude rows.

AgentService owns an unref'ed 100 ms pump that calls `Scheduler.drain()` so a process owner observes mail committed by another MCP server. Cross-instance interrupt uses a durable interrupt request: the owner pump observes it, performs ClaudeRuntime interruption, commits exactly one interrupted terminal outcome, and acknowledges the request. A non-owner never signals an unrelated PID.

Startup reconciliation inspects every old runtime lease by exact PID and process creation time. Exact-alive and unknown/PID-only ownership become `needs_attention`; exact-dead is marked and atomically reconciled. Lease expiry alone is never proof of death. `RuntimeProcessContainmentError` and `ClaudeResumeError` map to sanitized stable service errors without dropping identity/attention state.

Tool schemas:

```ts
spawn_agent({ task, cwd?, permission_profile?, model?, effort?, name? })
send_message({ agent_id, message })
followup_task({ agent_id, message })
wait_agent({ agent_ids, after_cursor?, timeout_ms? })
interrupt_agent({ agent_id })
list_agents({})
read_agent({ agent_id, after_cursor?, limit?, include_raw? })
```

- [ ] **Step 1: Write failing service/tool tests for all seven schemas, atomic initial task persistence, cross-instance owner pumping and interrupt, semantic completion events, `queued_only`, cursor timeout, persisted reads, startup PID reconciliation, unknown agents, and sanitized errors that never expose prompts or environment variables.**

```ts
it('keeps context queued until a followup triggers a turn', async () => {
  const context = await service.sendMessage(agent.id, 'extra context');
  expect(context.queuedOnly).toBe(true);
  await service.followupTask(agent.id, 'continue');
  expect(store.readPendingMessages(agent.id).map((m) => m.id)).toContain(context.messageId);
});

it('receives a completion committed by another server without a lost wakeup', async () => {
  const waiting = serviceB.waitAgent([agent.id], storeB.latestCursor(), 500);
  storeA.appendPublicEvent(agent.id, 'turn.completed', { turnId: turn.id });
  expect((await waiting).events[0]?.type).toBe('turn.completed');
});
```
- [ ] **Step 2: Run `npm test -- test/agent-service.test.ts test/tools.test.ts test/server.test.ts` and verify failure comes from missing registrations and orchestration.**
- [ ] **Step 3: Implement the service, durable interrupt requests, 100 ms owner pump, Zod tool schemas, MCP registrations, structured text responses, stderr-only diagnostics, exact-identity startup reconciliation, and graceful server shutdown.**
- [ ] **Step 4: Run focused tests, `npm run typecheck`, and an MCP protocol smoke test over child-process STDIO.**
- [ ] **Step 5: Commit with `feat: expose Codex-like MCP agent tools`.**

### Task 5: Packaging, operations, and end-to-end verification

**Files:**
- Create: `README.md`, `docs/security.md`, `test/e2e.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the complete server binary from Task 4.
- Produces: `npm run build`, `npm test`, a Windows Codex MCP configuration example, troubleshooting/retention guidance, and one fake-CLI end-to-end test.

The built entrypoint is `dist/index.js`; package scripts are `build`, `start`, `test`, `typecheck`, and `smoke:claude`. The README must state Windows 11-only, Node.js 22+, Claude Code CLI >=2.1.238, Claude subscription login, and that permission profiles are not an OS sandbox. It includes this Codex configuration shape with absolute Windows paths:

```toml
[mcp_servers.claude_subagents]
command = "node"
args = ["C:\\absolute\\path\\to\\claude-mcp\\dist\\index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 300
```

The e2e test uses a temporary SQLite state directory and a fake Claude executable through dependency/config injection. It performs MCP initialize/listTools, then spawn → wait → read → send context → followup → interrupt → list, and confirms stdout contains protocol frames only. It must not access the Anthropic API or the installed real Claude CLI.

- [ ] **Step 1: Write a failing end-to-end test that starts the built STDIO server with a temporary state directory and fake Claude CLI, then performs initialize, listTools, spawn, wait, read, send context, followup, interrupt, and list.**

```ts
expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
  'followup_task', 'interrupt_agent', 'list_agents', 'read_agent',
  'send_message', 'spawn_agent', 'wait_agent',
]);
```
- [ ] **Step 2: Run `npm test -- test/e2e.test.ts` and confirm the missing packaging/configuration behavior fails.**
- [ ] **Step 3: Add build/start/smoke scripts, package metadata/bin/files, README setup and exact Codex configuration, security boundary, current-user state cleanup/retention instructions, and stable-error troubleshooting.**
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run build`, and `npm pack --dry-run`; all must succeed.**
- [ ] **Step 5: Commit with `docs: finish Claude subagent MCP package`.**
