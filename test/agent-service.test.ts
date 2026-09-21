import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentService,
  AgentServiceError,
  type RuntimeProcessInspection,
} from '../src/agent-service.js';
import { ClaudeResumeError } from '../src/claude/runtime.js';
import type { Agent, Message, ProcessIdentity, Turn } from '../src/domain.js';
import { EventWaiter } from '../src/event-waiter.js';
import {
  RuntimeProcessContainmentError,
  Scheduler,
  type AgentRuntime,
  type RuntimeInterruptResult,
} from '../src/scheduler.js';
import { AgentStore, openStore } from '../src/store.js';

const temporaryDirectories: string[] = [];
const stores: AgentStore[] = [];
const services: AgentService[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mcp-service-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.sqlite');
}

function trackedStore(path: string): AgentStore {
  const store = openStore(path);
  stores.push(store);
  return store;
}

function closeTrackedStore(store: AgentStore): void {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  store.close();
}

class RecordingRuntime implements AgentRuntime {
  readonly starts: Array<{ agent: Agent; turn: Turn; messages: readonly Message[] }> = [];
  readonly deliveries: Array<{ agentId: string; message: Message; shouldQuery: boolean }> = [];
  readonly interruptions: string[] = [];
  interruptResult: RuntimeInterruptResult | void = undefined;

  async start(agent: Agent, turn: Turn, messages: readonly Message[]): Promise<void> {
    this.starts.push({ agent, turn, messages: [...messages] });
  }

  async deliver(agent: Agent, message: Message, shouldQuery: boolean): Promise<void> {
    this.deliveries.push({ agentId: agent.id, message, shouldQuery });
  }

  async interrupt(agentId: string): Promise<RuntimeInterruptResult | void> {
    this.interruptions.push(agentId);
    return this.interruptResult;
  }
}

interface ServiceFixture {
  service: AgentService;
  scheduler: Scheduler;
  store: AgentStore;
}

function makeService(
  path: string,
  runtime: AgentRuntime = new RecordingRuntime(),
  options: {
    serverId?: string;
    inspectRuntimeProcess?: (identity: ProcessIdentity) => RuntimeProcessInspection;
    pumpIntervalMs?: number;
    ownerHeartbeatStaleMs?: number;
    now?: () => Date;
  } = {},
): ServiceFixture {
  const store = trackedStore(path);
  const scheduler = new Scheduler(store, runtime, {
    serverId: options.serverId ?? `server-${services.length + 1}`,
  });
  const service = new AgentService(store, scheduler, new EventWaiter(store, 10), {
    inspectRuntimeProcess: options.inspectRuntimeProcess ?? (() => 'unknown'),
    pumpIntervalMs: options.pumpIntervalMs,
    ownerHeartbeatStaleMs: options.ownerHeartbeatStaleMs,
    now: options.now,
    onDiagnostic: () => undefined,
  });
  services.push(service);
  return { service, scheduler, store };
}

async function closeTrackedService(service: AgentService): Promise<void> {
  const index = services.indexOf(service);
  if (index >= 0) services.splice(index, 1);
  await service.close();
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('AgentService', () => {
  it('persists the initial task as the first followup before the first turn starts', async () => {
    const path = temporaryDatabase();
    const runtime = new RecordingRuntime();
    const { service } = makeService(path, runtime);

    const spawned = await service.spawnAgent({ task: 'Build the durable service' });

    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.turn.id).toBe(spawned.turnId);
    expect(runtime.starts[0]?.messages.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: 'followup', content: 'Build the durable service' },
    ]);
    const database = new Database(path);
    const row = database.prepare(`
      SELECT a.id AS agent_id, t.id AS turn_id, m.kind, m.content, tm.ordinal
      FROM agents a
      JOIN turns t ON t.agent_id = a.id
      JOIN turn_messages tm ON tm.turn_id = t.id
      JOIN messages m ON m.id = tm.message_id
      WHERE a.id = ?
    `).get(spawned.agentId) as Record<string, string | number>;
    database.close();
    expect(row).toEqual({
      agent_id: spawned.agentId,
      content: 'Build the durable service',
      kind: 'followup',
      ordinal: 0,
      turn_id: spawned.turnId,
    });
  });

  it('rolls back the agent and first turn if initial followup persistence fails', async () => {
    const path = temporaryDatabase();
    const { service } = makeService(path);
    const database = new Database(path);
    database.exec(`
      CREATE TRIGGER reject_initial_message
      BEFORE INSERT ON messages
      BEGIN
        SELECT RAISE(ABORT, 'forced message failure');
      END;
    `);

    const failure = await service.spawnAgent({ task: 'never leave an empty turn' })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'internal_error' });
    const counts = database.prepare(`
      SELECT
        (SELECT count(*) FROM agents) AS agents,
        (SELECT count(*) FROM turns) AS turns,
        (SELECT count(*) FROM messages) AS messages
    `).get() as Record<string, number>;
    database.close();
    expect(counts).toEqual({ agents: 0, messages: 0, turns: 0 });
  });

  it('pumps context and followups committed by another service only through the runtime owner', async () => {
    const path = temporaryDatabase();
    const ownerRuntime = new RecordingRuntime();
    const otherRuntime = new RecordingRuntime();
    const owner = makeService(path, ownerRuntime, { serverId: 'owner' });
    const other = makeService(path, otherRuntime, { serverId: 'other' });
    const agent = await owner.service.spawnAgent({ task: 'initial owner query' });

    const context = await other.service.sendMessage(agent.agentId, 'cross-instance context');
    const followup = await other.service.followupTask(agent.agentId, 'cross-instance query');

    expect(context.queuedOnly).toBe(true);
    expect(context.mailboxDepth).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => {
      expect(owner.store.getMessage(context.messageId)?.state).toBe('pending');
      expect(owner.store.getMessage(followup.messageId)?.state).toBe('pending');
    }, { timeout: 1_000 });
    expect(ownerRuntime.deliveries).toEqual([]);

    owner.store.completeTurn(agent.turnId, 'succeeded');
    await owner.scheduler.onTurnBoundary(agent.agentId);

    expect(ownerRuntime.starts[1]?.messages.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: context.messageId, kind: 'message' },
      { id: followup.messageId, kind: 'followup' },
    ]);
    expect(otherRuntime.starts).toEqual([]);
    expect(otherRuntime.deliveries).toEqual([]);
  });

  it.each([
    ['send_message', (service: AgentService, agentId: string) => service.sendMessage(agentId, 'late context')],
    ['followup_task', (service: AgentService, agentId: string) => service.followupTask(agentId, 'late query')],
  ])('revalidates agent state transactionally when %s races with interruption', async (_name, send) => {
    const path = temporaryDatabase();
    const fixture = makeService(path, new RecordingRuntime(), { serverId: 'mail-state-race' });
    const spawned = await fixture.service.spawnAgent({ task: 'running query' });
    const originalGetAgent = fixture.store.getAgent.bind(fixture.store);
    vi.spyOn(fixture.store, 'getAgent').mockImplementationOnce((agentId) => {
      const snapshot = originalGetAgent(agentId);
      fixture.store.requestInterrupt(agentId);
      return snapshot;
    });

    await expect(send(fixture.service, spawned.agentId)).rejects.toMatchObject({
      code: 'invalid_state',
      details: { agentId: spawned.agentId, state: 'cancelling' },
    });

    expect(fixture.store.readPendingMessages(spawned.agentId)).toEqual([]);
  });

  it('reports queuedOnly from the persisted message state after draining', async () => {
    const path = temporaryDatabase();
    const fixture = makeService(path, new RecordingRuntime(), { serverId: 'queued-only-state' });
    const { agent } = fixture.store.createAgent({ task: 'context-only claim' });

    const sent = await fixture.service.sendMessage(agent.id, 'context that is immediately leased');

    expect(fixture.store.getMessage(sent.messageId)?.state).toBe('leased');
    expect(sent).toMatchObject({ queuedOnly: false, mailboxDepth: 1 });
  });

  it('uses a durable owner-only interrupt request and commits one interrupted outcome', async () => {
    const path = temporaryDatabase();
    const ownerRuntime = new RecordingRuntime();
    const otherRuntime = new RecordingRuntime();
    const owner = makeService(path, ownerRuntime, { serverId: 'interrupt-owner' });
    const other = makeService(path, otherRuntime, { serverId: 'interrupt-other' });
    const spawned = await owner.service.spawnAgent({ task: 'long running turn' });

    const requested = await other.service.interruptAgent(spawned.agentId);

    expect(requested).toMatchObject({ interrupted: false, state: 'cancelling' });
    await vi.waitFor(() => {
      expect(ownerRuntime.interruptions).toEqual([spawned.agentId]);
      expect(owner.store.getTurn(spawned.turnId)?.status).toBe('interrupted');
    }, { timeout: 1_000 });
    expect(otherRuntime.interruptions).toEqual([]);
    const database = new Database(path);
    const durable = database.prepare(`
      SELECT
        (SELECT count(*) FROM events WHERE agent_id = ? AND type = 'turn.interrupted') AS outcomes,
        (SELECT acknowledged_at FROM interrupt_requests WHERE agent_id = ?) AS acknowledged_at
    `).get(spawned.agentId, spawned.agentId) as { acknowledged_at: string | null; outcomes: number };
    database.close();
    expect(durable.outcomes).toBe(1);
    expect(durable.acknowledged_at).not.toBeNull();
    await expect(other.service.interruptAgent(spawned.agentId)).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it('receives a semantic completion event committed by another store without a lost wakeup', async () => {
    const path = temporaryDatabase();
    const first = makeService(path, new RecordingRuntime(), { serverId: 'completion-owner' });
    const second = makeService(path, new RecordingRuntime(), { serverId: 'completion-waiter' });
    const spawned = await first.service.spawnAgent({ task: 'complete elsewhere' });
    const after = second.store.latestCursor();

    const waiting = second.service.waitAgent([spawned.agentId], after, 500);
    first.store.completeTurn(spawned.turnId, 'succeeded');
    const result = await waiting;

    expect(result.timedOut).toBe(false);
    expect(result.events).toMatchObject([
      { agentId: spawned.agentId, type: 'turn.completed', payload: { turnId: spawned.turnId, status: 'succeeded' } },
    ]);
    await first.scheduler.onTurnBoundary(spawned.agentId);
  });

  it('keeps idle context queued until a followup creates the next turn', async () => {
    const path = temporaryDatabase();
    const runtime = new RecordingRuntime();
    const fixture = makeService(path, runtime, { serverId: 'queued-only' });
    const spawned = await fixture.service.spawnAgent({ task: 'first query' });
    fixture.store.completeTurn(spawned.turnId, 'succeeded');
    await fixture.scheduler.onTurnBoundary(spawned.agentId);

    const context = await fixture.service.sendMessage(spawned.agentId, 'extra context');
    expect(context.queuedOnly).toBe(true);
    expect(fixture.store.readPendingMessages(spawned.agentId).map(({ id }) => id)).toContain(context.messageId);

    const followup = await fixture.service.followupTask(spawned.agentId, 'continue');

    expect(runtime.starts).toHaveLength(2);
    expect(runtime.starts[1]?.messages.map(({ id }) => id)).toEqual([context.messageId, followup.messageId]);
    expect(runtime.starts[1]?.messages.map(({ kind }) => kind)).toEqual(['message', 'followup']);
  });

  it('returns a normal timeout with an unchanged cursor', async () => {
    const path = temporaryDatabase();
    const fixture = makeService(path);
    const spawned = await fixture.service.spawnAgent({ task: 'wait timeout' });
    const after = fixture.store.latestCursor();

    const result = await fixture.service.waitAgent([spawned.agentId], after, 20);

    expect(result).toEqual({ cursor: after, events: [], timedOut: true });
  });

  it('reads persisted turn outcomes and hides raw Claude frames by default', async () => {
    const path = temporaryDatabase();
    const fixture = makeService(path);
    const spawned = await fixture.service.spawnAgent({ task: 'persisted result' });
    fixture.store.appendClaudeEvent(
      spawned.agentId,
      spawned.turnId,
      fixture.scheduler.serverId,
      'result',
      { type: 'result', subtype: 'success' },
      '{"type":"result","subtype":"success"}',
    );
    fixture.store.completeTurn(spawned.turnId, 'succeeded');

    const ordinary = fixture.service.readAgent(spawned.agentId, '0', 100, false);
    const diagnostic = fixture.service.readAgent(spawned.agentId, '0', 100, true);

    expect(ordinary.turns).toMatchObject([{ id: spawned.turnId, status: 'succeeded' }]);
    expect(ordinary.events.some(({ type }) => type === 'turn.completed')).toBe(true);
    expect(ordinary.rawEvents).toBeUndefined();
    expect(diagnostic.rawEvents).toMatchObject([{
      turnId: spawned.turnId,
      type: 'result',
      raw: '{"type":"result","subtype":"success"}',
    }]);
  });

  it('exposes the latest reply without raw history and skips context-only acknowledgements', async () => {
    const fixture = makeService(temporaryDatabase());
    const spawned = await fixture.service.spawnAgent({ task: 'result retrieval' });
    const append = (payload: object) => fixture.store.appendClaudeEvent(
      spawned.agentId, spawned.turnId, fixture.scheduler.serverId, 'result', payload, JSON.stringify(payload),
    );
    const reply = { type: 'result', subtype: 'success', is_error: false, result: 'Saved the file.', num_turns: 1 };
    append(reply);
    append({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0 });
    const page = fixture.service.readAgent(spawned.agentId, '0', 1, false);
    expect(page.latestResult?.payload).toEqual(reply);
    expect(page.rawEvents).toBeUndefined();
    const failure = { type: 'result', subtype: 'success', is_error: true, result: 'ECONNRESET', num_turns: 0 };
    append(failure);
    expect(fixture.service.readAgent(spawned.agentId, '0', 1, false).latestResult?.payload).toEqual(failure);
  });

  it('reports only still-pending messages in agent summaries', async () => {
    const fixture = makeService(temporaryDatabase());
    const spawned = await fixture.service.spawnAgent({ task: 'leased initial query' });

    expect(fixture.service.listAgents()).toMatchObject([{
      id: spawned.agentId,
      pendingMessageCount: 0,
    }]);
    fixture.store.enqueueMessage(spawned.agentId, 'message', 'not yet pumped');
    expect(fixture.service.listAgents()).toMatchObject([{
      id: spawned.agentId,
      pendingMessageCount: 1,
    }]);
  });

  it('marks exact-alive, unknown, and PID-only startup ownership as needs_attention', async () => {
    const inspections: Array<RuntimeProcessInspection | 'pid-only'> = ['alive', 'unknown', 'pid-only'];
    for (const [index, inspection] of inspections.entries()) {
      const path = temporaryDatabase();
      const oldStore = trackedStore(path);
      const { agent } = oldStore.createAgent({ task: `old runtime ${inspection}` });
      const message = oldStore.enqueueMessage(agent.id, 'followup', 'durable input').message;
      oldStore.scheduleAgent(agent.id, `C:\\workspace-${index}`, 'writer');
      const claim = oldStore.claimNextScheduled(`old-server-${index}`);
      if (!claim) throw new Error('fixture runtime was not claimed');
      if (inspection === 'pid-only') {
        oldStore.retainUnconfirmedRuntimeProcess(
          agent.id,
          `old-server-${index}`,
          7000 + index,
          '2020-01-01T00:00:00.000Z',
        );
      } else {
        oldStore.attachRuntimeProcess(
          agent.id,
          `old-server-${index}`,
          { pid: 7000 + index, startedAt: '2026-09-01T00:00:00.000Z' },
          '2020-01-01T00:00:00.000Z',
        );
      }
      closeTrackedStore(oldStore);
      const inspector = vi.fn(() => inspection === 'pid-only' ? 'dead' : inspection);

      const replacement = makeService(path, new RecordingRuntime(), {
        serverId: `replacement-${index}`,
        inspectRuntimeProcess: inspector,
        pumpIntervalMs: 60_000,
      });

      expect(replacement.store.getAgent(agent.id)?.state).toBe('needs_attention');
      expect(replacement.store.getTurn(claim.turn.id)?.status).toBe('running');
      expect(replacement.store.getMessage(message.id)?.state).toBe('leased');
      expect(replacement.store.listRuntimeLeases()).toHaveLength(1);
      if (inspection === 'pid-only') expect(inspector).not.toHaveBeenCalled();
      else expect(inspector).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves a healthy foreign owner running when another service starts', async () => {
    const path = temporaryDatabase();
    let nowMs = Date.parse('2026-09-02T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const owner = makeService(path, new RecordingRuntime(), {
      serverId: 'healthy-owner',
      pumpIntervalMs: 60_000,
      ownerHeartbeatStaleMs: 1_000,
      now,
    });
    const spawned = await owner.service.spawnAgent({ task: 'remain owned' });
    const inspector = vi.fn((): RuntimeProcessInspection => 'dead');

    const observer = makeService(path, new RecordingRuntime(), {
      serverId: 'observer',
      inspectRuntimeProcess: inspector,
      pumpIntervalMs: 60_000,
      ownerHeartbeatStaleMs: 1_000,
      now,
    });

    expect(observer.store.getAgent(spawned.agentId)?.state).toBe('running');
    expect(observer.store.getTurn(spawned.turnId)?.status).toBe('running');
    expect(observer.store.listRuntimeLeases()).toMatchObject([{
      agentId: spawned.agentId,
      serverId: 'healthy-owner',
    }]);
    expect(inspector).not.toHaveBeenCalled();

    nowMs += 1_001;
    const staleObserver = makeService(path, new RecordingRuntime(), {
      serverId: 'stale-observer',
      inspectRuntimeProcess: inspector,
      pumpIntervalMs: 60_000,
      ownerHeartbeatStaleMs: 1_000,
      now,
    });
    expect(staleObserver.store.getAgent(spawned.agentId)?.state).toBe('needs_attention');
    expect(staleObserver.store.getTurn(spawned.turnId)?.status).toBe('running');
    expect(staleObserver.store.listRuntimeLeases()).toHaveLength(1);
    expect(inspector).not.toHaveBeenCalled();
  });

  it('uses the owner heartbeat as a CAS guard after inspecting a stale process', async () => {
    const path = temporaryDatabase();
    let nowMs = Date.parse('2026-09-02T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const owner = makeService(path, new RecordingRuntime(), {
      serverId: 'reviving-owner',
      pumpIntervalMs: 60_000,
      ownerHeartbeatStaleMs: 1_000,
      now,
    });
    const spawned = await owner.service.spawnAgent({ task: 'survive stale inspection' });
    const identity = { pid: 7444, startedAt: '2026-09-02T00:00:00.000Z' };
    owner.store.attachRuntimeProcess(
      spawned.agentId,
      'reviving-owner',
      identity,
      '2099-01-01T00:00:00.000Z',
    );
    nowMs += 1_001;
    const inspector = vi.fn((): RuntimeProcessInspection => {
      owner.store.heartbeatServerInstance('reviving-owner', now().toISOString());
      return 'dead';
    });

    const observer = makeService(path, new RecordingRuntime(), {
      serverId: 'cas-observer',
      inspectRuntimeProcess: inspector,
      pumpIntervalMs: 60_000,
      ownerHeartbeatStaleMs: 1_000,
      now,
    });

    expect(inspector).toHaveBeenCalledWith(identity);
    expect(observer.store.getAgent(spawned.agentId)?.state).toBe('running');
    expect(observer.store.getTurn(spawned.turnId)?.status).toBe('running');
    expect(observer.store.listRuntimeLeases()).toMatchObject([{
      agentId: spawned.agentId,
      serverId: 'reviving-owner',
      pid: identity.pid,
    }]);
  });

  it('refreshes the durable owner heartbeat from the service pump', async () => {
    vi.useFakeTimers();
    try {
      const path = temporaryDatabase();
      let nowMs = Date.parse('2026-09-02T00:00:00.000Z');
      const now = () => new Date(nowMs);
      const owner = makeService(path, new RecordingRuntime(), {
        serverId: 'pumping-owner',
        pumpIntervalMs: 10,
        ownerHeartbeatStaleMs: 1_000,
        now,
      });
      const spawned = await owner.service.spawnAgent({ task: 'keep heartbeat fresh' });

      nowMs += 1_001;
      await vi.advanceTimersByTimeAsync(10);
      const inspector = vi.fn((): RuntimeProcessInspection => 'dead');
      const observer = makeService(path, new RecordingRuntime(), {
        serverId: 'post-pump-observer',
        inspectRuntimeProcess: inspector,
        pumpIntervalMs: 60_000,
        ownerHeartbeatStaleMs: 1_000,
        now,
      });

      expect(observer.store.getAgent(spawned.agentId)?.state).toBe('running');
      expect(inspector).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('atomically requeues exact-dead startup ownership regardless of lease expiry', () => {
    const path = temporaryDatabase();
    const oldStore = trackedStore(path);
    const { agent } = oldStore.createAgent({ task: 'dead exact runtime' });
    const message = oldStore.enqueueMessage(agent.id, 'followup', 'retry exact input').message;
    oldStore.scheduleAgent(agent.id, 'C:\\dead-workspace', 'writer');
    const claim = oldStore.claimNextScheduled('old-dead-server');
    if (!claim) throw new Error('fixture runtime was not claimed');
    const identity = { pid: 7555, startedAt: '2026-09-01T00:00:00.000Z' };
    oldStore.attachRuntimeProcess(agent.id, 'old-dead-server', identity, '2099-01-01T00:00:00.000Z');
    closeTrackedStore(oldStore);

    const replacement = makeService(path, new RecordingRuntime(), {
      serverId: 'dead-replacement',
      inspectRuntimeProcess: () => 'dead',
      pumpIntervalMs: 60_000,
    });

    expect(replacement.store.getAgent(agent.id)?.state).toBe('queued');
    expect(replacement.store.getTurn(claim.turn.id)?.status).toBe('queued');
    expect(replacement.store.getMessage(message.id)?.state).toBe('pending');
    expect(replacement.store.listRuntimeLeases()).toEqual([]);
  });

  it('returns stable errors for unknown agents and invalid cursors', async () => {
    const fixture = makeService(temporaryDatabase());

    await expect(fixture.service.sendMessage('missing-agent', 'context')).rejects.toMatchObject({
      code: 'agent_not_found',
    });
    await expect(fixture.service.waitAgent(['missing-agent'], '0', 0)).rejects.toMatchObject({
      code: 'agent_not_found',
    });
    expect(() => fixture.service.readAgent('missing-agent', '0', 10, false)).toThrowError(
      expect.objectContaining({ code: 'agent_not_found' }),
    );
    const spawned = await fixture.service.spawnAgent({ task: 'cursor validation' });
    await expect(fixture.service.waitAgent([spawned.agentId], 'not-a-cursor', 0)).rejects.toMatchObject({
      code: 'cursor_expired',
    });
  });

  it('maps containment and resume failures without exposing prompts, environment, or auth data', async () => {
    const secrets = 'prompt=TOP_SECRET CLAUDE_API_KEY=AUTH_SECRET';

    class ContainmentRuntime implements AgentRuntime {
      constructor(private readonly store: AgentStore, private readonly serverId: string) {}

      async start(agent: Agent): Promise<void> {
        const identity = { pid: 8111, startedAt: '2026-09-01T00:00:00.000Z' };
        this.store.containRuntimeProcess(
          agent.id,
          this.serverId,
          identity,
          '2099-01-01T00:00:00.000Z',
        );
        throw new RuntimeProcessContainmentError(secrets, identity, true, false, new Error(secrets));
      }

      async deliver(): Promise<void> {}

      async interrupt(): Promise<void> {
        throw new RuntimeProcessContainmentError(
          secrets,
          { pid: 8111, startedAt: '2026-09-01T00:00:00.000Z' },
          true,
          false,
          new Error(secrets),
        );
      }
    }

    const containmentPath = temporaryDatabase();
    const containmentStore = trackedStore(containmentPath);
    const containmentRuntime = new ContainmentRuntime(containmentStore, 'containment-server');
    const containmentScheduler = new Scheduler(containmentStore, containmentRuntime, {
      serverId: 'containment-server',
    });
    const containmentService = new AgentService(
      containmentStore,
      containmentScheduler,
      new EventWaiter(containmentStore),
      { inspectRuntimeProcess: () => 'unknown', onDiagnostic: () => undefined },
    );
    services.push(containmentService);

    const containmentError = await containmentService.spawnAgent({ task: secrets })
      .catch((error: unknown) => error) as AgentServiceError;
    expect(containmentError.code).toBe('internal_error');
    expect(JSON.stringify(containmentError)).not.toContain('TOP_SECRET');
    expect(JSON.stringify(containmentError)).not.toContain('AUTH_SECRET');
    expect(containmentStore.listAgents()).toMatchObject([{ state: 'needs_attention' }]);

    class ResumeRuntime extends RecordingRuntime {
      override async start(): Promise<void> {
        throw new ClaudeResumeError(new Error(secrets));
      }
    }
    const resume = makeService(temporaryDatabase(), new ResumeRuntime(), { serverId: 'resume-server' });
    const resumeError = await resume.service.spawnAgent({ task: secrets })
      .catch((error: unknown) => error) as AgentServiceError;
    expect(resumeError.code).toBe('resume_failed');
    expect(JSON.stringify(resumeError)).not.toContain('TOP_SECRET');
    expect(JSON.stringify(resumeError)).not.toContain('AUTH_SECRET');
    expect(resume.store.listAgents()).toMatchObject([{ state: 'needs_attention' }]);
  });

  it('stops its pump and interrupts only server-owned runtimes on close', async () => {
    const runtime = new RecordingRuntime();
    const fixture = makeService(temporaryDatabase(), runtime, { serverId: 'closing-server' });
    const drain = vi.spyOn(fixture.scheduler, 'drain');
    const spawned = await fixture.service.spawnAgent({ task: 'close owned runtime' });

    await closeTrackedService(fixture.service);
    const callsAfterClose = drain.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(runtime.interruptions).toEqual([spawned.agentId]);
    expect(drain).toHaveBeenCalledTimes(callsAfterClose);
    expect(fixture.store.getTurn(spawned.turnId)?.status).toBe('interrupted');
  });

  it('removes its durable server registration when close finishes', async () => {
    const path = temporaryDatabase();
    const fixture = makeService(path, new RecordingRuntime(), { serverId: 'closing-registration' });
    const registered = new Database(path);
    expect(registered.prepare(
      'SELECT count(*) AS count FROM server_instances WHERE server_id = ?',
    ).pluck().get('closing-registration')).toBe(1);
    registered.close();

    await closeTrackedService(fixture.service);

    const closed = new Database(path);
    expect(closed.prepare(
      'SELECT count(*) AS count FROM server_instances WHERE server_id = ?',
    ).pluck().get('closing-registration')).toBe(0);
    closed.close();
  });

  it('durably completes an owned interrupt when close races with runtime start', async () => {
    let releaseStart!: () => void;
    let reportStarted!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    class BlockingStartRuntime extends RecordingRuntime {
      override async start(agent: Agent, turn: Turn, messages: readonly Message[]): Promise<void> {
        await super.start(agent, turn, messages);
        reportStarted();
        await startGate;
      }
    }
    const runtime = new BlockingStartRuntime();
    const fixture = makeService(temporaryDatabase(), runtime, { serverId: 'close-race' });
    const spawning = fixture.service.spawnAgent({ task: 'start while closing' });
    await started;

    const closing = closeTrackedService(fixture.service);
    releaseStart();
    const spawned = await spawning;
    await closing;

    expect(runtime.interruptions).toEqual([spawned.agentId]);
    expect(fixture.store.getTurn(spawned.turnId)?.status).toBe('interrupted');
    expect(fixture.store.listRuntimeLeases()).toEqual([]);
  });

  it('makes concurrent close callers await the same runtime shutdown', async () => {
    let releaseInterrupt!: () => void;
    let reportInterrupt!: () => void;
    const interruptGate = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    const interruptStarted = new Promise<void>((resolve) => { reportInterrupt = resolve; });
    class BlockingInterruptRuntime extends RecordingRuntime {
      override async interrupt(agentId: string): Promise<void> {
        await super.interrupt(agentId);
        reportInterrupt();
        await interruptGate;
      }
    }
    const fixture = makeService(temporaryDatabase(), new BlockingInterruptRuntime(), {
      serverId: 'concurrent-close',
    });
    await fixture.service.spawnAgent({ task: 'close once' });

    const first = closeTrackedService(fixture.service);
    await interruptStarted;
    let secondFinished = false;
    const second = fixture.service.close().then(() => { secondFinished = true; });
    await Promise.resolve();

    expect(secondFinished).toBe(false);
    releaseInterrupt();
    await Promise.all([first, second]);
    expect(secondFinished).toBe(true);
  });

  it('cancels pending messages at the interrupt boundary so a later send stays queued-only', async () => {
    const path = temporaryDatabase();
    const ownerRuntime = new RecordingRuntime();
    const owner = makeService(path, ownerRuntime, {
      serverId: 'boundary-owner',
      pumpIntervalMs: 60_000,
    });
    const other = makeService(path, new RecordingRuntime(), {
      serverId: 'boundary-other',
      pumpIntervalMs: 60_000,
    });
    const spawned = await owner.service.spawnAgent({ task: 'first turn' });

    const stale = await other.service.followupTask(spawned.agentId, 'stale followup');
    await other.service.interruptAgent(spawned.agentId);
    await owner.scheduler.drain();

    expect(owner.store.getTurn(spawned.turnId)?.status).toBe('interrupted');
    expect(owner.store.getAgent(spawned.agentId)?.state).toBe('idle');
    expect(owner.store.getMessage(stale.messageId)?.state).toBe('acknowledged');
    expect(owner.store.readPendingMessages(spawned.agentId)).toEqual([]);

    const context = await owner.service.sendMessage(spawned.agentId, 'context only');
    await owner.scheduler.drain();

    expect(context.queuedOnly).toBe(true);
    expect(ownerRuntime.starts).toHaveLength(1);
    expect(owner.store.listTurns(spawned.agentId)).toHaveLength(1);
    expect(owner.store.getAgent(spawned.agentId)?.state).toBe('idle');
  });

  it('only acknowledges the interrupt request when the turn completed concurrently', async () => {
    const path = temporaryDatabase();
    const fixture = makeService(path, new RecordingRuntime(), {
      serverId: 'complete-race',
      pumpIntervalMs: 60_000,
    });
    const spawned = await fixture.service.spawnAgent({ task: 'race with completion' });

    expect(fixture.store.requestInterrupt(spawned.agentId)).toMatchObject({ state: 'cancelling' });
    fixture.store.completeTurn(spawned.turnId, 'succeeded');
    const cursorBefore = fixture.store.latestCursor();

    const completed = fixture.store.completeOwnedInterrupt(
      spawned.agentId,
      spawned.turnId,
      'complete-race',
    );

    expect(completed).toBe(false);
    expect(fixture.store.latestCursor()).toBe(cursorBefore);
    expect(fixture.store.listRuntimeLeases()).toHaveLength(1);
    expect(fixture.store.getAgent(spawned.agentId)?.state).toBe('cancelling');
    const database = new Database(path);
    const request = database.prepare(
      'SELECT acknowledged_at FROM interrupt_requests WHERE agent_id = ?',
    ).get(spawned.agentId) as { acknowledged_at: string | null };
    database.close();
    expect(request.acknowledged_at).not.toBeNull();

    await fixture.scheduler.onTurnBoundary(spawned.agentId);
    expect(fixture.store.getAgent(spawned.agentId)?.state).toBe('idle');
    expect(fixture.store.listRuntimeLeases()).toEqual([]);
  });

  it('honors a durable interrupt at startup when the old owner process is exactly dead', () => {
    const path = temporaryDatabase();
    const oldStore = trackedStore(path);
    const { agent } = oldStore.createAgent({ task: 'interrupted before crash' });
    const message = oldStore.enqueueMessage(agent.id, 'followup', 'crashed input').message;
    oldStore.scheduleAgent(agent.id, 'C:\\interrupted-workspace', 'writer');
    const claim = oldStore.claimNextScheduled('old-interrupt-server');
    if (!claim) throw new Error('fixture runtime was not claimed');
    const identity = { pid: 7777, startedAt: '2026-09-01T00:00:00.000Z' };
    oldStore.attachRuntimeProcess(agent.id, 'old-interrupt-server', identity, '2099-01-01T00:00:00.000Z');
    expect(oldStore.requestInterrupt(agent.id)).toMatchObject({ state: 'cancelling', interrupted: false });
    closeTrackedStore(oldStore);
    const inspector = vi.fn((): RuntimeProcessInspection => 'dead');
    const runtime = new RecordingRuntime();

    const successor = makeService(path, runtime, {
      serverId: 'interrupt-successor',
      inspectRuntimeProcess: inspector,
      pumpIntervalMs: 60_000,
    });

    expect(inspector).toHaveBeenCalledWith(identity);
    expect(successor.store.getTurn(claim.turn.id)?.status).toBe('interrupted');
    expect(successor.store.getAgent(agent.id)?.state).toBe('idle');
    expect(successor.store.getMessage(message.id)?.state).toBe('acknowledged');
    expect(successor.store.listRuntimeLeases()).toEqual([]);
    expect(runtime.starts).toEqual([]);
    const events = successor.store.readEvents({ agentIds: [agent.id], after: '0', limit: 100 });
    expect(events.filter(({ type }) => type === 'turn.interrupted')).toHaveLength(1);
  });

  it('paginates raw Claude events with a dedicated raw cursor', async () => {
    const fixture = makeService(temporaryDatabase());
    const spawned = await fixture.service.spawnAgent({ task: 'raw pages' });
    for (const frame of ['one', 'two', 'three']) {
      fixture.store.appendClaudeEvent(
        spawned.agentId,
        spawned.turnId,
        fixture.scheduler.serverId,
        'stream',
        { frame },
        `{"frame":"${frame}"}`,
      );
    }

    const first = fixture.service.readAgent(spawned.agentId, '0', 2, true);
    expect(first.rawEvents?.map(({ payload }) => payload)).toEqual([{ frame: 'one' }, { frame: 'two' }]);
    expect(first.rawCursor).toBe(first.rawEvents?.at(-1)?.sequence);

    const second = fixture.service.readAgent(spawned.agentId, '0', 2, true, first.rawCursor);
    expect(second.rawEvents?.map(({ payload }) => payload)).toEqual([{ frame: 'three' }]);
    expect(second.rawCursor).toBe(second.rawEvents?.at(-1)?.sequence);
  });

  it('rejects a raw cursor beyond this agent latest raw sequence', async () => {
    const fixture = makeService(temporaryDatabase());
    const spawned = await fixture.service.spawnAgent({ task: 'raw cursor bounds' });

    expect(() => fixture.service.readAgent(spawned.agentId, '0', 10, true, '1')).toThrowError(
      expect.objectContaining({ code: 'cursor_expired' }),
    );

    fixture.store.appendClaudeEvent(
      spawned.agentId,
      spawned.turnId,
      fixture.scheduler.serverId,
      'stream',
      { frame: 'only' },
      '{"frame":"only"}',
    );
    const latest = fixture.store.readClaudeEvents(spawned.agentId, '0', 10).at(-1)?.sequence;
    if (!latest) throw new Error('fixture raw event was not written');

    expect(fixture.service.readAgent(spawned.agentId, '0', 10, true, latest).rawEvents).toEqual([]);
    expect(() => fixture.service.readAgent(
      spawned.agentId,
      '0',
      10,
      true,
      (BigInt(latest) + 1n).toString(),
    )).toThrowError(expect.objectContaining({ code: 'cursor_expired' }));
  });
});

describe('AgentService stall detection', () => {
  function makeStallService(path: string, runtime: RecordingRuntime, stallTimeoutMs: number): ServiceFixture {
    const store = trackedStore(path);
    const scheduler = new Scheduler(store, runtime, { serverId: `stall-server-${services.length + 1}` });
    const service = new AgentService(store, scheduler, new EventWaiter(store, 5), {
      inspectRuntimeProcess: () => 'unknown',
      onDiagnostic: () => undefined,
      pumpIntervalMs: 10,
      stallTimeoutMs,
    });
    services.push(service);
    return { service, scheduler, store };
  }

  it('does not report a stall before the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const path = temporaryDatabase();
      const runtime = new RecordingRuntime();
      const { service } = makeStallService(path, runtime, 200);

      const spawned = await service.spawnAgent({ task: 'Watch for stalls' });
      await vi.advanceTimersByTimeAsync(150);

      const result = await service.waitAgent([spawned.agentId], spawned.cursor, 0);
      expect(result.events.some((event) => event.type === 'agent.stalled')).toBe(false);
      expect(runtime.interruptions).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits exactly one agent.stalled event after the timeout without interrupting or changing state', async () => {
    vi.useFakeTimers();
    try {
      const path = temporaryDatabase();
      const runtime = new RecordingRuntime();
      const { service } = makeStallService(path, runtime, 200);

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
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms after Claude activity so a later inactivity period reports again', async () => {
    vi.useFakeTimers();
    try {
      const path = temporaryDatabase();
      const runtime = new RecordingRuntime();
      const { service, scheduler, store } = makeStallService(path, runtime, 200);

      const spawned = await service.spawnAgent({ task: 'Watch for stalls' });
      await vi.advanceTimersByTimeAsync(250);
      const firstWait = await service.waitAgent([spawned.agentId], spawned.cursor, 0);
      expect(firstWait.events.filter((event) => event.type === 'agent.stalled')).toHaveLength(1);

      const active = runtime.starts[0];
      if (!active) throw new Error('fixture runtime did not start');
      store.appendClaudeEvent(
        active.agent.id,
        active.turn.id,
        scheduler.serverId,
        'assistant',
        { type: 'assistant' },
        '{}',
      );

      await vi.advanceTimersByTimeAsync(250);
      const secondWait = await service.waitAgent([spawned.agentId], firstWait.cursor, 0);
      expect(secondWait.events.filter((event) => event.type === 'agent.stalled')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
