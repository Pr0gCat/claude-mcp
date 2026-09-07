# Observable Stalled-Agent Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the MCP server durably detect that a `running` Claude agent has stopped producing activity for longer than a configurable timeout, and surface exactly one advisory `agent.stalled` event per inactivity period without touching agent/turn state or the Claude process.

**Architecture:** Persist `last_activity_at` / `stall_reported_at` on the `agents` row. `AgentStore.appendClaudeEvent` (every raw Claude JSON frame) and `claimNextScheduled` (turn start) update `last_activity_at` and clear `stall_reported_at`. A new `AgentStore.detectStalledAgents(timeoutMs)` runs a conditional `UPDATE ... WHERE state='running' AND stall_reported_at IS NULL AND last_activity_at <= threshold` inside `BEGIN IMMEDIATE`, so concurrent MCP instances racing the same check can only have one succeed, and appends `agent.stalled` only on the winning update. `AgentService`'s existing pump timer calls this every tick using a new `CLAUDE_MCP_STALL_TIMEOUT_MS` config value. `list_agents`/`read_agent` summaries expose `last_activity_at` and a derived `stalled` boolean.

**Tech Stack:** TypeScript, better-sqlite3, vitest (fake timers for deterministic time control, matching `test/claude-runtime.test.ts` / `test/event-waiter.test.ts` conventions).

**Spec:** Task 6 instructions in this conversation (no separate spec file); this plan folds the requirements in directly since they are already fully enumerated.

## Global Constraints

- Config env var: `CLAUDE_MCP_STALL_TIMEOUT_MS`, default `300000`, must validate as a positive safe integer (reuse existing `loadConfig` conventions in `src/config.ts`).
- Do not add an 8th MCP tool; do not rename `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`, `read_agent`.
- `agent.stalled` must never change agent/turn state, must never call `runtime.interrupt`, and must never release scheduler/process-lease ownership.
- Exactly one `agent.stalled` event per inactivity period, even with multiple MCP instances sharing one SQLite file.
- No real Claude CLI invocation in tests; use existing fake-runtime/fake-store test patterns.

---

### Task 1: Domain + store schema + activity/stall primitives

**Files:**
- Modify: `src/domain.ts` (add `'agent.stalled'` to `eventTypes`; add `lastActivityAt`/`stallReportedAt` to `Agent`)
- Modify: `src/store.ts` (schema columns, row mapping, `claimNextScheduled`, `appendClaudeEvent`, new `detectStalledAgents`)
- Test: `test/store.test.ts`

**Interfaces:**
- Produces: `AgentStore#detectStalledAgents(timeoutMs: number): string[]` — returns the agent IDs that were newly marked stalled this call.
- Produces: `Agent.lastActivityAt: string | null`, `Agent.stallReportedAt: string | null`.
- Consumes: existing `insertEvent`, `notifyEventListeners`, `ensureColumn` helpers already in `AgentStore`.

- [ ] **Step 1: Write failing store tests**

Append to `test/store.test.ts` (add `vi` to the vitest import and add a `describe('AgentStore stall detection', ...)` block):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
```

```ts
describe('AgentStore stall detection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function runningAgent(store: AgentStore) {
    const { agent, turn } = store.createAgent({ task: 'Watch for stalls' });
    store.scheduleAgent(agent.id, 'C:\\workspace', 'writer');
    const claim = store.claimNextScheduled('server-1');
    if (!claim) throw new Error('fixture runtime was not claimed');
    return { agent, turn: claim.turn };
  }

  it('reports no stall before the timeout elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent } = runningAgent(store);

    vi.setSystemTime(new Date('2026-01-01T00:04:59.000Z'));
    expect(store.detectStalledAgents(300_000)).toEqual([]);
    expect(store.getAgent(agent.id)?.state).toBe('running');
    expect(store.readEvents({ agentIds: [agent.id], after: '0', limit: 10 })
      .some((event) => event.type === 'agent.stalled')).toBe(false);
  });

  it('emits exactly one agent.stalled event once inactivity exceeds the timeout', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent } = runningAgent(store);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    expect(store.detectStalledAgents(300_000)).toEqual([agent.id]);
    expect(store.detectStalledAgents(300_000)).toEqual([]);

    const stalledEvents = store.readEvents({ agentIds: [agent.id], after: '0', limit: 10 })
      .filter((event) => event.type === 'agent.stalled');
    expect(stalledEvents).toHaveLength(1);
    expect(store.getAgent(agent.id)).toMatchObject({ state: 'running', stallReportedAt: expect.any(String) });
  });

  it('does not change turn or agent state, and does not touch process leases', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent, turn } = runningAgent(store);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    store.detectStalledAgents(300_000);

    expect(store.getTurn(turn.id)?.status).toBe('running');
    expect(store.listRuntimeLeases()).toHaveLength(1);
  });

  it('re-arms detection after new Claude activity is recorded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent, turn } = runningAgent(store);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    expect(store.detectStalledAgents(300_000)).toEqual([agent.id]);

    store.appendClaudeEvent(agent.id, turn.id, 'assistant', { type: 'assistant' }, '{"type":"assistant"}');
    expect(store.getAgent(agent.id)?.stallReportedAt).toBeNull();

    expect(store.detectStalledAgents(300_000)).toEqual([]);
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
    expect(store.detectStalledAgents(300_000)).toEqual([agent.id]);

    const stalledEvents = store.readEvents({ agentIds: [agent.id], after: '0', limit: 20 })
      .filter((event) => event.type === 'agent.stalled');
    expect(stalledEvents).toHaveLength(2);
  });

  it('does not duplicate the stall event across two store instances sharing one database', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const { agent } = runningAgent(store);
    const second = openStore(path);
    stores.push(second);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    const first = store.detectStalledAgents(300_000);
    const race = second.detectStalledAgents(300_000);

    expect([...first, ...race]).toEqual([agent.id]);
    const stalledEvents = store.readEvents({ agentIds: [agent.id], after: '0', limit: 10 })
      .filter((event) => event.type === 'agent.stalled');
    expect(stalledEvents).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `npx vitest run test/store.test.ts -t "stall detection"`
Expected: FAIL — `detectStalledAgents` is not a function / `stallReportedAt` is undefined.

- [ ] **Step 3: Add the `agent.stalled` event type and Agent fields**

In `src/domain.ts`, extend `eventTypes`:

```ts
export const eventTypes = [
  'agent.created',
  'agent.queued',
  'agent.idle',
  'agent.cancelling',
  'agent.needs_attention',
  'agent.stalled',
  'message.enqueued',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
] as const;
```

Extend the `Agent` interface:

```ts
export interface Agent {
  id: string;
  sessionId: string;
  sessionStartedAt: string | null;
  state: AgentState;
  task: string;
  cwd: string | null;
  permissionProfile: PermissionProfile;
  model: string | null;
  effort: string | null;
  name: string | null;
  lastActivityAt: string | null;
  stallReportedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: Add schema columns and row mapping in `src/store.ts`**

Add to the `AgentRow` interface:

```ts
interface AgentRow {
  // ...existing fields...
  last_activity_at: string | null;
  stall_reported_at: string | null;
}
```

Update `asAgent`:

```ts
function asAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionStartedAt: row.session_started_at,
    state: row.state,
    task: row.task,
    cwd: row.cwd,
    permissionProfile: row.permission_profile,
    model: row.model,
    effort: row.effort,
    name: row.name,
    lastActivityAt: row.last_activity_at,
    stallReportedAt: row.stall_reported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

Add migration calls in the constructor after the existing `ensureColumn` calls:

```ts
this.ensureColumn('agents', 'last_activity_at', 'TEXT');
this.ensureColumn('agents', 'stall_reported_at', 'TEXT');
```

Update every explicit agent `SELECT` column list (`getAgent`, `listAgents`, and the `agentRow` query inside `claimNextScheduled`) to also select `last_activity_at, stall_reported_at`.

- [ ] **Step 5: Set the activity baseline when a turn starts running**

In `claimNextScheduled`, change:

```ts
this.#database.prepare(`UPDATE agents SET state = 'running', updated_at = ? WHERE id = ?`)
  .run(acquiredAt, scheduled.agent_id);
```

to:

```ts
this.#database.prepare(`
  UPDATE agents
  SET state = 'running', updated_at = ?, last_activity_at = ?, stall_reported_at = NULL
  WHERE id = ?
`).run(acquiredAt, acquiredAt, scheduled.agent_id);
```

And update the returned agent object construction to include the new fields (it already spreads `asAgent(agentRow)`, so re-select is not required as long as the `SELECT` in Step 4 includes the two new columns — verify the returned object matches by re-running the row through `asAgent` with `state: 'running'` override, same as today's `updatedAt` override).

- [ ] **Step 6: Update `last_activity_at` on every raw Claude event**

Replace `appendClaudeEvent`:

```ts
appendClaudeEvent(
  agentId: string,
  turnId: string,
  type: string,
  payload: unknown,
  raw: string,
): string {
  const createdAt = new Date().toISOString();
  this.#database.exec('BEGIN IMMEDIATE');
  try {
    const result = this.#database.prepare(`
      INSERT INTO claude_events (agent_id, turn_id, type, payload, raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(agentId, turnId, type, JSON.stringify(payload), raw, createdAt);
    this.#database.prepare(`
      UPDATE agents SET last_activity_at = ?, stall_reported_at = NULL WHERE id = ?
    `).run(createdAt, agentId);
    this.#database.exec('COMMIT');
    return String(result.lastInsertRowid);
  } catch (error) {
    this.#database.exec('ROLLBACK');
    throw error;
  }
}
```

- [ ] **Step 7: Implement `detectStalledAgents`**

Add a new public method on `AgentStore` (near `appendPublicEvent`):

```ts
detectStalledAgents(timeoutMs: number): string[] {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('stall timeout must be a positive integer');
  }
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const threshold = new Date(nowMs - timeoutMs).toISOString();
  this.#database.exec('BEGIN IMMEDIATE');
  try {
    const candidates = this.#database.prepare(`
      SELECT id FROM agents
      WHERE state = 'running'
        AND last_activity_at IS NOT NULL
        AND last_activity_at <= ?
        AND stall_reported_at IS NULL
    `).all(threshold) as Array<{ id: string }>;
    const stalledAgentIds: string[] = [];
    for (const { id } of candidates) {
      const claimed = this.#database.prepare(`
        UPDATE agents SET stall_reported_at = ?
        WHERE id = ? AND state = 'running' AND stall_reported_at IS NULL AND last_activity_at <= ?
      `).run(nowIso, id, threshold);
      if (claimed.changes !== 1) continue;
      const agent = this.#database.prepare(`SELECT last_activity_at FROM agents WHERE id = ?`)
        .get(id) as { last_activity_at: string };
      this.insertEvent(id, 'agent.stalled', {
        lastActivityAt: agent.last_activity_at,
        inactiveMs: timeoutMs,
      }, nowIso);
      stalledAgentIds.push(id);
    }
    this.#database.exec('COMMIT');
    if (stalledAgentIds.length > 0) this.notifyEventListeners();
    return stalledAgentIds;
  } catch (error) {
    this.#database.exec('ROLLBACK');
    throw error;
  }
}
```

- [ ] **Step 8: Run the store tests and confirm they pass**

Run: `npx vitest run test/store.test.ts`
Expected: PASS (all prior store tests still pass; all new stall tests pass).

- [ ] **Step 9: Commit**

```bash
git add src/domain.ts src/store.ts test/store.test.ts
git commit -m "feat: persist stall-detection state and add AgentStore.detectStalledAgents"
```

---

### Task 2: Config option

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Config.stallTimeoutMs: number` (always present, default `300000`).

- [ ] **Step 1: Write failing config tests**

Append to `test/config.test.ts`:

```ts
it('defaults the stall timeout to 300000ms', () => {
  const config = loadConfig({ USERPROFILE: temporaryDirectory() });

  expect(config.stallTimeoutMs).toBe(300_000);
});

it('accepts a positive integer override for the stall timeout', () => {
  const config = loadConfig({ USERPROFILE: temporaryDirectory(), CLAUDE_MCP_STALL_TIMEOUT_MS: '60000' });

  expect(config.stallTimeoutMs).toBe(60_000);
});

it.each(['0', '-1', '1.5', 'abc', ''])('rejects an invalid stall timeout override %s', (value) => {
  expect(() => loadConfig({ USERPROFILE: temporaryDirectory(), CLAUDE_MCP_STALL_TIMEOUT_MS: value }))
    .toThrow('CLAUDE_MCP_STALL_TIMEOUT_MS must be a positive integer');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/config.test.ts -t "stall timeout"`
Expected: FAIL — `config.stallTimeoutMs` is `undefined`.

- [ ] **Step 3: Implement the option**

In `src/config.ts`, add to the `Config` interface:

```ts
export interface Config {
  stateDir: string;
  claudeExecutable?: string;
  stallTimeoutMs: number;
}
```

Add parsing/validation in `loadConfig` (near the other env validations):

```ts
const stallTimeoutOverride = env.CLAUDE_MCP_STALL_TIMEOUT_MS;
let stallTimeoutMs = 300_000;
if (stallTimeoutOverride !== undefined) {
  if (!/^[1-9]\d*$/.test(stallTimeoutOverride.trim()) || !Number.isSafeInteger(Number(stallTimeoutOverride))) {
    throw new Error('CLAUDE_MCP_STALL_TIMEOUT_MS must be a positive integer');
  }
  stallTimeoutMs = Number(stallTimeoutOverride);
}
```

Include it in the returned object:

```ts
return {
  stateDir,
  ...(claudeExecutable !== undefined ? { claudeExecutable } : {}),
  stallTimeoutMs,
};
```

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add CLAUDE_MCP_STALL_TIMEOUT_MS config option"
```

---

### Task 3: Wire stall detection into the AgentService pump and surface it in summaries

**Files:**
- Modify: `src/agent-service.ts`
- Modify: `src/tools.ts`
- Modify: `src/index.ts`
- Test: `test/agent-service.test.ts`
- Test: `test/tools.test.ts` (only if summary shape assertions live there; otherwise skip — verify by reading the file before editing)

**Interfaces:**
- Consumes: `AgentStore#detectStalledAgents(timeoutMs)` from Task 1, `Config.stallTimeoutMs` from Task 2.
- Produces: `AgentServiceOptions.stallTimeoutMs?: number`; `AgentSummary.lastActivityAt: string | null`; `AgentSummary.stalled: boolean`.

- [ ] **Step 1: Write failing service tests**

Append to `test/agent-service.test.ts` a new `describe` block:

```ts
describe('AgentService stall detection', () => {
  it('does not report a stall before the configured timeout', async () => {
    vi.useFakeTimers();
    const path = temporaryDatabase();
    const runtime = new RecordingRuntime();
    const store = trackedStore(path);
    const scheduler = new Scheduler(store, runtime, { serverId: 'server-stall-1' });
    const service = new AgentService(store, scheduler, new EventWaiter(store, 5), {
      inspectRuntimeProcess: () => 'unknown',
      onDiagnostic: () => undefined,
      pumpIntervalMs: 10,
      stallTimeoutMs: 200,
    });
    services.push(service);

    const spawned = await service.spawnAgent({ task: 'Watch for stalls' });
    await vi.advanceTimersByTimeAsync(150);

    const result = await service.waitAgent([spawned.agentId], spawned.cursor, 0);
    expect(result.events.some((event) => event.type === 'agent.stalled')).toBe(false);
    expect(runtime.interruptions).toHaveLength(0);
    vi.useRealTimers();
  });

  it('emits exactly one agent.stalled event after the timeout without interrupting or changing state', async () => {
    vi.useFakeTimers();
    const path = temporaryDatabase();
    const runtime = new RecordingRuntime();
    const store = trackedStore(path);
    const scheduler = new Scheduler(store, runtime, { serverId: 'server-stall-2' });
    const service = new AgentService(store, scheduler, new EventWaiter(store, 5), {
      inspectRuntimeProcess: () => 'unknown',
      onDiagnostic: () => undefined,
      pumpIntervalMs: 10,
      stallTimeoutMs: 200,
    });
    services.push(service);

    const spawned = await service.spawnAgent({ task: 'Watch for stalls' });
    await vi.advanceTimersByTimeAsync(250);

    const result = await service.waitAgent([spawned.agentId], spawned.cursor, 0);
    const stalledEvents = result.events.filter((event) => event.type === 'agent.stalled');
    expect(stalledEvents).toHaveLength(1);
    expect(runtime.interruptions).toHaveLength(0);

    const summary = service.listAgents().find((agent) => agent.id === spawned.agentId);
    expect(summary?.state).toBe('running');
    expect(summary?.stalled).toBe(true);
    expect(summary?.lastActivityAt).toEqual(expect.any(String));

    await vi.advanceTimersByTimeAsync(200);
    const later = await service.waitAgent([spawned.agentId], result.cursor, 0);
    expect(later.events.some((event) => event.type === 'agent.stalled')).toBe(false);
    vi.useRealTimers();
  });

  it('re-arms after Claude activity so a later inactivity period reports again', async () => {
    vi.useFakeTimers();
    const path = temporaryDatabase();
    const runtime = new RecordingRuntime();
    const store = trackedStore(path);
    const scheduler = new Scheduler(store, runtime, { serverId: 'server-stall-3' });
    const service = new AgentService(store, scheduler, new EventWaiter(store, 5), {
      inspectRuntimeProcess: () => 'unknown',
      onDiagnostic: () => undefined,
      pumpIntervalMs: 10,
      stallTimeoutMs: 200,
    });
    services.push(service);

    const spawned = await service.spawnAgent({ task: 'Watch for stalls' });
    await vi.advanceTimersByTimeAsync(250);
    const firstWait = await service.waitAgent([spawned.agentId], spawned.cursor, 0);
    expect(firstWait.events.filter((event) => event.type === 'agent.stalled')).toHaveLength(1);

    const active = runtime.starts[0];
    if (!active) throw new Error('fixture runtime did not start');
    store.appendClaudeEvent(active.agent.id, active.turn.id, 'assistant', { type: 'assistant' }, '{}');

    await vi.advanceTimersByTimeAsync(250);
    const secondWait = await service.waitAgent([spawned.agentId], firstWait.cursor, 0);
    expect(secondWait.events.filter((event) => event.type === 'agent.stalled')).toHaveLength(1);
    vi.useRealTimers();
  });
});
```

(Read the top of `test/agent-service.test.ts` again right before editing — reuse whichever `temporaryDatabase`/`trackedStore` helpers already exist verbatim rather than redefining them.)

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/agent-service.test.ts -t "stall detection"`
Expected: FAIL — `stallTimeoutMs` option unknown / `summary.stalled` undefined.

- [ ] **Step 3: Add the option and pump hook in `src/agent-service.ts`**

Extend `AgentServiceOptions`:

```ts
export interface AgentServiceOptions {
  inspectRuntimeProcess?: (identity: ProcessIdentity) => RuntimeProcessInspection;
  pumpIntervalMs?: number;
  stallTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
}
```

Extend `AgentSummary`:

```ts
export interface AgentSummary {
  id: string;
  name: string | null;
  state: AgentState;
  lastTurnStatus: TurnStatus | null;
  pendingMessageCount: number;
  cwd: string | null;
  permissionProfile: PermissionProfile;
  lastActivityAt: string | null;
  stalled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

In the `AgentService` class, add a private field and constructor validation alongside the existing `pumpIntervalMs` check:

```ts
readonly #stallTimeoutMs: number;
```

```ts
const stallTimeoutMs = options.stallTimeoutMs ?? 300_000;
if (!Number.isSafeInteger(stallTimeoutMs) || stallTimeoutMs < 1) {
  throw new Error('stall timeout must be a positive integer');
}
this.#stallTimeoutMs = stallTimeoutMs;
```

Update `schedulePump`:

```ts
private schedulePump(): void {
  if (this.#closed || this.#pump) return;
  this.#pump = (async () => {
    this.checkStalls();
    await this.scheduler.drain();
  })()
    .catch((error: unknown) => {
      const sanitized = sanitizeAgentServiceError(error);
      this.#onDiagnostic(`agent service pump failed: ${sanitized.code}`);
    })
    .finally(() => { this.#pump = undefined; });
}

private checkStalls(): void {
  try {
    this.store.detectStalledAgents(this.#stallTimeoutMs);
  } catch (error) {
    const sanitized = sanitizeAgentServiceError(error);
    this.#onDiagnostic(`stall detection failed: ${sanitized.code}`);
  }
}
```

Update `summary`:

```ts
private summary(agentId: string): AgentSummary {
  const agent = this.requireAgent(agentId);
  const lastTurn = this.store.listTurns(agentId).at(-1);
  return {
    id: agent.id,
    name: agent.name,
    state: agent.state,
    lastTurnStatus: lastTurn?.status ?? null,
    pendingMessageCount: this.store.pendingMessageCount(agentId),
    cwd: agent.cwd,
    permissionProfile: agent.permissionProfile,
    lastActivityAt: agent.lastActivityAt,
    stalled: agent.state === 'running' && agent.stallReportedAt !== null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}
```

- [ ] **Step 4: Expose the fields over MCP in `src/tools.ts`**

Update `summaryOutput`:

```ts
function summaryOutput(summary: AgentSummary): Record<string, unknown> {
  return {
    agent_id: summary.id,
    name: summary.name,
    state: summary.state,
    last_turn_status: summary.lastTurnStatus,
    pending_message_count: summary.pendingMessageCount,
    cwd: summary.cwd,
    permission_profile: summary.permissionProfile,
    last_activity_at: summary.lastActivityAt,
    stalled: summary.stalled,
    created_at: summary.createdAt,
    updated_at: summary.updatedAt,
  };
}
```

Check `test/tools.test.ts` for any fixture that asserts the exact shape of `summaryOutput`/`list_agents`/`read_agent` output (e.g. `toEqual`) — if one exists, add `last_activity_at`/`stalled` to its expected object so it doesn't spuriously fail.

- [ ] **Step 5: Wire config into `src/index.ts`**

Change the `AgentService` construction line to:

```ts
const service = new AgentService(store, scheduler, new EventWaiter(store), {
  stallTimeoutMs: config.stallTimeoutMs,
});
```

- [ ] **Step 6: Run and confirm pass**

Run: `npx vitest run test/agent-service.test.ts test/tools.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agent-service.ts src/tools.ts src/index.ts test/agent-service.test.ts test/tools.test.ts
git commit -m "feat: detect and surface stalled Claude agents via the existing pump"
```

---

### Task 4: Documentation and full verification

**Files:**
- Modify: `docs/protocol.md`
- Modify: `docs/spec.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the behavior**

In `docs/spec.md`, add a new subsection after "## Process model" (or extend "## State model"):

```markdown
## Stall detection

Every `running` agent tracks `last_activity_at`, updated whenever the Claude CLI emits any JSON frame (or when its turn starts). If a configurable timeout (`CLAUDE_MCP_STALL_TIMEOUT_MS`, default 300000ms) elapses with no activity, the server appends exactly one advisory `agent.stalled` public event and leaves the agent `running`; it never interrupts or kills the Claude process and never releases scheduler ownership on its own. New activity clears the stall marker and re-arms detection for the next inactivity period. `agent.stalled` is advisory only — Codex must inspect the situation and decide whether to keep waiting or call `interrupt_agent`. Detection runs on the existing pump and is safe across MCP process restarts and multiple concurrent MCP instances sharing one SQLite database (a conditional transactional update prevents duplicate events).
```

In `docs/protocol.md`, add a short paragraph near the end (after "## Opt-in live smoke" or before it):

```markdown
## Stall detection

`agent.stalled` is appended when a `running` agent produces no Claude JSON frame for longer than `CLAUDE_MCP_STALL_TIMEOUT_MS` (default 300000ms). It does not change agent or turn state and does not touch the Claude process; it is purely advisory so a caller polling `wait_agent` can decide to keep waiting or call `interrupt_agent`. Any further Claude activity clears the marker and re-arms detection.
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS, all suites green including the new stall tests.

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed with no errors.

- [ ] **Step 4: Commit**

```bash
git add docs/spec.md docs/protocol.md
git commit -m "docs: document advisory agent.stalled event and stall timeout config"
```
