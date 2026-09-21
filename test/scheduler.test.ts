import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStore, openStore } from '../src/store.js';
import type { Agent, Message, Turn } from '../src/domain.js';
import { Scheduler, type AgentRuntime } from '../src/scheduler.js';
import { ClaudeRuntime, type ClaudeRuntimeRunner } from '../src/claude/runtime.js';
import { EventWaiter } from '../src/event-waiter.js';

const temporaryDirectories: string[] = [];
const stores: AgentStore[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mcp-scheduler-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.sqlite');
}

function temporaryWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mcp-agent-workspace-'));
  temporaryDirectories.push(directory);
  return directory;
}

function closeTrackedStore(store: AgentStore): void {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  store.close();
}

class RecordingRuntime implements AgentRuntime {
  readonly starts: string[] = [];
  readonly startMessageIds: string[][] = [];
  readonly startShouldQuery: boolean[][] = [];
  readonly startTurnNumbers: number[] = [];
  readonly deliveries: Array<{ content: string; shouldQuery: boolean }> = [];
  readonly deliveredMessageIds: string[] = [];
  readonly interruptions: string[] = [];

  async start(agent: Agent, _turn: Turn, messages: readonly Message[]): Promise<void> {
    this.starts.push(agent.id);
    this.startTurnNumbers.push(_turn.number);
    this.startMessageIds.push(messages.map((message) => message.id));
    this.startShouldQuery.push(messages.map((message) => message.kind === 'followup'));
  }

  async deliver(_agent: Agent, message: Message, shouldQuery: boolean): Promise<void> {
    this.deliveredMessageIds.push(message.id);
    this.deliveries.push({ content: message.content, shouldQuery });
  }

  async interrupt(agentId: string): Promise<void> {
    this.interruptions.push(agentId);
  }
}

class FailingRuntime extends RecordingRuntime {
  override async start(agent: Agent, turn: Turn, messages: readonly Message[]): Promise<void> {
    await super.start(agent, turn, messages);
    throw new Error('runtime failed to start');
  }
}

class FailingDeliveryRuntime extends RecordingRuntime {
  override async deliver(agent: Agent, message: Message, shouldQuery: boolean): Promise<void> {
    await super.deliver(agent, message, shouldQuery);
    throw new Error('runtime failed to deliver');
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('durable mailbox', () => {
  it('leases the pending prefix through exactly one followup into a turn manifest', () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent, turn } = store.createAgent({ task: 'Handle mail' });
    const first = store.enqueueMessage(agent.id, 'message', 'first').message;
    const second = store.enqueueMessage(agent.id, 'followup', 'second').message;
    const third = store.enqueueMessage(agent.id, 'message', 'third').message;

    const leased = store.leaseMessages(agent.id, turn.id);

    expect(leased.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(leased.map((message) => message.state)).toEqual(['leased', 'leased']);
    expect(store.getMessage(third.id)?.state).toBe('pending');
  });

  it('acknowledges each leased message only once', () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent, turn } = store.createAgent({ task: 'Handle mail once' });
    store.enqueueMessage(agent.id, 'message', 'only once');
    store.leaseMessages(agent.id, turn.id);

    expect(store.completeTurn(turn.id, 'succeeded')).toEqual({ acknowledged: 1, completed: true });
    expect(store.completeTurn(turn.id, 'succeeded')).toEqual({ acknowledged: 0, completed: false });
    expect(store.leaseMessages(agent.id, turn.id).map((message) => message.state))
      .toEqual(['acknowledged']);
  });

  it('never appends pending messages to a terminal turn manifest', () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const { agent, turn } = store.createAgent({ task: 'Immutable terminal manifest' });
    const initial = store.enqueueMessage(agent.id, 'message', 'initial').message;
    store.leaseMessages(agent.id, turn.id);
    store.completeTurn(turn.id, 'succeeded');
    const later = store.enqueueMessage(agent.id, 'followup', 'later').message;

    expect(store.leaseMessages(agent.id, turn.id).map((message) => message.id)).toEqual([initial.id]);

    const check = new Database(path);
    const row = check.prepare(`SELECT state FROM messages WHERE id = ?`).get(later.id) as { state: string };
    check.close();
    expect(row.state).toBe('pending');
  });
});

describe('Scheduler', () => {
  it.each([0, -1, 1.5])('rejects invalid process limit %s', (processLimit) => {
    const store = openStore(temporaryDatabase());
    stores.push(store);

    expect(() => new Scheduler(store, new RecordingRuntime(), { processLimit }))
      .toThrow('process limit must be a positive integer');
  });

  it('starts no more than four runtime processes', async () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const runtime = new RecordingRuntime();
    const scheduler = new Scheduler(store, runtime, { serverId: 'server-a' });
    const agents = Array.from({ length: 5 }, (_, index) => store.createAgent({
      cwd: temporaryWorkspace(),
      task: `Agent ${index + 1}`,
    }).agent);

    for (const agent of agents) scheduler.enqueue(agent.id);
    await scheduler.drain();

    expect(runtime.starts).toEqual(agents.slice(0, 4).map((agent) => agent.id));
  });

  it('allows configuration to raise the process limit', async () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const runtime = new RecordingRuntime();
    const scheduler = new Scheduler(store, runtime, { processLimit: 99, serverId: 'server-hard-limit' });
    const agents = Array.from({ length: 5 }, (_, index) => store.createAgent({
      cwd: temporaryWorkspace(),
      task: `Hard-limit agent ${index + 1}`,
    }).agent);

    for (const agent of agents) scheduler.enqueue(agent.id);
    await scheduler.drain();

    expect(runtime.starts).toHaveLength(5);
  });

  it('enforces the four-process limit across scheduler instances', async () => {
    const path = temporaryDatabase();
    const firstStore = openStore(path);
    const secondStore = openStore(path);
    stores.push(firstStore, secondStore);
    const firstRuntime = new RecordingRuntime();
    const secondRuntime = new RecordingRuntime();
    const firstScheduler = new Scheduler(firstStore, firstRuntime, { serverId: 'limit-server-one' });
    const secondScheduler = new Scheduler(secondStore, secondRuntime, { serverId: 'limit-server-two' });
    const firstAgents = Array.from({ length: 3 }, (_, index) => firstStore.createAgent({
      cwd: temporaryWorkspace(),
      task: `First server ${index + 1}`,
    }).agent);
    const secondAgents = Array.from({ length: 3 }, (_, index) => firstStore.createAgent({
      cwd: temporaryWorkspace(),
      task: `Second server ${index + 1}`,
    }).agent);

    for (const agent of firstAgents) firstScheduler.enqueue(agent.id);
    await firstScheduler.drain();
    for (const agent of secondAgents) secondScheduler.enqueue(agent.id);
    await secondScheduler.drain();

    expect(firstRuntime.starts).toHaveLength(3);
    expect(secondRuntime.starts).toHaveLength(1);
  });

  it('does not run a writer beside a reader for the same workspace across servers', async () => {
    const path = temporaryDatabase();
    const firstStore = openStore(path);
    const secondStore = openStore(path);
    stores.push(firstStore, secondStore);
    const workspace = temporaryWorkspace();
    const reader = firstStore.createAgent({
      cwd: workspace,
      permissionProfile: 'read_only',
      task: 'Read',
    }).agent;
    const writer = firstStore.createAgent({
      cwd: workspace,
      permissionProfile: 'workspace_write',
      task: 'Write',
    }).agent;
    const readerRuntime = new RecordingRuntime();
    const writerRuntime = new RecordingRuntime();
    const firstScheduler = new Scheduler(firstStore, readerRuntime, { serverId: 'server-reader' });
    const secondScheduler = new Scheduler(secondStore, writerRuntime, { serverId: 'server-writer' });

    firstScheduler.enqueue(reader.id);
    await firstScheduler.drain();
    secondScheduler.enqueue(writer.id);
    await secondScheduler.drain();

    expect(readerRuntime.starts).toEqual([reader.id]);
    expect(writerRuntime.starts).toEqual([]);
  });

  it('does not run a reader beside an existing writer across servers', async () => {
    const path = temporaryDatabase();
    const firstStore = openStore(path);
    const secondStore = openStore(path);
    stores.push(firstStore, secondStore);
    const workspace = temporaryWorkspace();
    const writer = firstStore.createAgent({
      cwd: workspace,
      permissionProfile: 'workspace_write',
      task: 'Writer first',
    }).agent;
    const reader = firstStore.createAgent({
      cwd: workspace,
      permissionProfile: 'read_only',
      task: 'Reader second',
    }).agent;
    const writerRuntime = new RecordingRuntime();
    const readerRuntime = new RecordingRuntime();
    const writerScheduler = new Scheduler(firstStore, writerRuntime, { serverId: 'writer-first' });
    const readerScheduler = new Scheduler(secondStore, readerRuntime, { serverId: 'reader-second' });

    writerScheduler.enqueue(writer.id);
    await writerScheduler.drain();
    readerScheduler.enqueue(reader.id);
    await readerScheduler.drain();

    expect(writerRuntime.starts).toEqual([writer.id]);
    expect(readerRuntime.starts).toEqual([]);
  });

  it('does not run two writers for the same workspace across servers', async () => {
    const path = temporaryDatabase();
    const firstStore = openStore(path);
    const secondStore = openStore(path);
    stores.push(firstStore, secondStore);
    const workspace = temporaryWorkspace();
    const first = firstStore.createAgent({
      cwd: workspace,
      permissionProfile: 'workspace_write',
      task: 'Writer one',
    }).agent;
    const second = firstStore.createAgent({
      cwd: workspace,
      permissionProfile: 'workspace_write',
      task: 'Writer two',
    }).agent;
    const firstRuntime = new RecordingRuntime();
    const secondRuntime = new RecordingRuntime();
    const firstScheduler = new Scheduler(firstStore, firstRuntime, { serverId: 'writer-one' });
    const secondScheduler = new Scheduler(secondStore, secondRuntime, { serverId: 'writer-two' });

    firstScheduler.enqueue(first.id);
    await firstScheduler.drain();
    secondScheduler.enqueue(second.id);
    await secondScheduler.drain();

    expect(firstRuntime.starts).toEqual([first.id]);
    expect(secondRuntime.starts).toEqual([]);
  });

  it('allows readers to coexist for the same workspace across servers', async () => {
    const path = temporaryDatabase();
    const firstStore = openStore(path);
    const secondStore = openStore(path);
    stores.push(firstStore, secondStore);
    const workspace = temporaryWorkspace();
    const first = firstStore.createAgent({
      cwd: workspace,
      permissionProfile: 'read_only',
      task: 'Read one',
    }).agent;
    const second = firstStore.createAgent({
      cwd: workspace,
      permissionProfile: 'read_only',
      task: 'Read two',
    }).agent;
    const firstRuntime = new RecordingRuntime();
    const secondRuntime = new RecordingRuntime();
    const firstScheduler = new Scheduler(firstStore, firstRuntime, { serverId: 'server-one' });
    const secondScheduler = new Scheduler(secondStore, secondRuntime, { serverId: 'server-two' });

    firstScheduler.enqueue(first.id);
    await firstScheduler.drain();
    secondScheduler.enqueue(second.id);
    await secondScheduler.drain();

    expect(firstRuntime.starts).toEqual([first.id]);
    expect(secondRuntime.starts).toEqual([second.id]);
  });

  it('releases durable capacity at a turn boundary before draining the queue', async () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const runtime = new RecordingRuntime();
    const scheduler = new Scheduler(store, runtime, { serverId: 'boundary-server' });
    const agents = Array.from({ length: 5 }, (_, index) => store.createAgent({
      cwd: temporaryWorkspace(),
      task: `Boundary agent ${index + 1}`,
    }).agent);
    for (const agent of agents) scheduler.enqueue(agent.id);
    await scheduler.drain();

    await scheduler.onTurnBoundary(agents[0]!.id);

    expect(runtime.interruptions).toEqual([agents[0]!.id]);
    expect(runtime.starts).toEqual(agents.map((agent) => agent.id));
  });

  it('delivers newly leased live messages in order with the correct query flag', async () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const runtime = new RecordingRuntime();
    const scheduler = new Scheduler(store, runtime, { serverId: 'delivery-server' });
    const { agent } = store.createAgent({ cwd: temporaryWorkspace(), task: 'Live agent' });
    scheduler.enqueue(agent.id);
    await scheduler.drain();
    store.enqueueMessage(agent.id, 'message', 'context only');
    store.enqueueMessage(agent.id, 'followup', 'answer this');

    scheduler.enqueue(agent.id);
    await scheduler.drain();

    expect(runtime.starts).toEqual([agent.id]);
    expect(runtime.deliveries).toEqual([
      { content: 'context only', shouldQuery: false },
      { content: 'answer this', shouldQuery: true },
    ]);
  });

  it('keeps a second followup durable for the next turn after the first query completes', async () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const runtime = new RecordingRuntime();
    const scheduler = new Scheduler(store, runtime, { serverId: 'query-boundary-server' });
    const { agent, turn } = store.createAgent({ cwd: temporaryWorkspace(), task: 'Query boundaries' });
    const first = store.enqueueMessage(agent.id, 'followup', 'first query').message;
    scheduler.enqueue(agent.id);
    await scheduler.drain();

    const second = store.enqueueMessage(agent.id, 'followup', 'second query').message;
    scheduler.enqueue(agent.id);
    await scheduler.drain();

    expect(runtime.startMessageIds).toEqual([[first.id]]);
    expect(runtime.deliveredMessageIds).toEqual([]);
    expect(store.getMessage(second.id)?.state).toBe('pending');

    expect(store.completeTurn(turn.id, 'succeeded')).toEqual({ acknowledged: 1, completed: true });
    expect(store.getMessage(first.id)?.state).toBe('acknowledged');
    expect(store.getMessage(second.id)?.state).toBe('pending');

    await scheduler.onTurnBoundary(agent.id);

    expect(runtime.startMessageIds).toEqual([[first.id], [second.id]]);
    expect(runtime.startTurnNumbers).toEqual([1, 2]);
    expect(store.getMessage(second.id)?.state).toBe('leased');
  });

  it('acknowledges the leased turn manifest once at the turn boundary', async () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const runtime = new RecordingRuntime();
    const scheduler = new Scheduler(store, runtime, { serverId: 'ack-server' });
    const { agent, turn } = store.createAgent({ cwd: temporaryWorkspace(), task: 'Ack agent' });
    store.enqueueMessage(agent.id, 'followup', 'leased input');
    scheduler.enqueue(agent.id);
    await scheduler.drain();

    expect(store.completeTurn(turn.id, 'succeeded')).toEqual({ acknowledged: 1, completed: true });

    await scheduler.onTurnBoundary(agent.id);

    expect(store.completeTurn(turn.id, 'succeeded')).toEqual({ acknowledged: 0, completed: false });
  });

  it('releases its database leases and retries FIFO when the runtime fails to start', async () => {
    const path = temporaryDatabase();
    const firstStore = openStore(path);
    const secondStore = openStore(path);
    stores.push(firstStore, secondStore);
    const workspace = temporaryWorkspace();
    const failed = firstStore.createAgent({
      cwd: workspace,
      permissionProfile: 'workspace_write',
      task: 'Fail startup',
    }).agent;
    const next = firstStore.createAgent({
      cwd: workspace,
      permissionProfile: 'workspace_write',
      task: 'Start next',
    }).agent;
    const failingRuntime = new FailingRuntime();
    const firstScheduler = new Scheduler(firstStore, failingRuntime, { serverId: 'failing-server' });
    const nextRuntime = new RecordingRuntime();
    const secondScheduler = new Scheduler(secondStore, nextRuntime, { serverId: 'next-server' });
    firstScheduler.enqueue(failed.id);

    await expect(firstScheduler.drain()).rejects.toThrow('runtime failed to start');
    secondScheduler.enqueue(next.id);
    await secondScheduler.drain();

    expect(failingRuntime.interruptions).toEqual([failed.id]);
    expect(nextRuntime.starts).toEqual([failed.id]);
  });

  it('durably restores the same turn and message for retry after start failure', async () => {
    const path = temporaryDatabase();
    const firstStore = openStore(path);
    const secondStore = openStore(path);
    stores.push(firstStore, secondStore);
    const { agent, turn } = firstStore.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Retry startup durably',
    });
    const message = firstStore.enqueueMessage(agent.id, 'followup', 'same immutable message').message;
    const failingScheduler = new Scheduler(firstStore, new FailingRuntime(), { serverId: 'start-failure' });
    failingScheduler.enqueue(agent.id);

    await expect(failingScheduler.drain()).rejects.toThrow('runtime failed to start');

    const check = new Database(path);
    const state = check.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT status FROM turns WHERE id = ?) AS turn_status,
        (SELECT state FROM messages WHERE id = ?) AS message_state,
        (SELECT count(*) FROM turn_messages WHERE turn_id = ?) AS manifest_count,
        (SELECT count(*) FROM process_leases WHERE agent_id = ?) AS process_count,
        (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
    `).get(agent.id, turn.id, message.id, turn.id, agent.id, agent.id) as {
      agent_state: string;
      turn_status: string;
      message_state: string;
      manifest_count: number;
      process_count: number;
      queue_count: number;
    };
    check.close();
    expect(state).toEqual({
      agent_state: 'queued',
      manifest_count: 0,
      message_state: 'pending',
      process_count: 0,
      queue_count: 1,
      turn_status: 'queued',
    });

    const retryRuntime = new RecordingRuntime();
    const retryScheduler = new Scheduler(secondStore, retryRuntime, { serverId: 'start-retry' });
    await retryScheduler.drain();

    expect(retryRuntime.startMessageIds).toEqual([[message.id]]);
  });

  it('requeues exact turn and message identities after a real ClaudeRuntime confirms failed-start exit', async () => {
    const path = temporaryDatabase();
    const firstStore = openStore(path);
    const retryStore = openStore(path);
    stores.push(firstStore, retryStore);
    const serverId = 'claude-confirmed-failure';
    const { agent, turn } = firstStore.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Retry exact Claude owner',
    });
    const message = firstStore.enqueueMessage(agent.id, 'followup', 'same query').message;
    const failedIdentity = { pid: 9301, startedAt: '2026-09-01T04:05:06.000Z' };
    const failedRunner: ClaudeRuntimeRunner = {
      identity: failedIdentity,
      exited: false,
      sendUserMessage: () => { throw new Error('Claude stdin failed'); },
      interrupt: async () => true,
    };
    const runtime = new ClaudeRuntime(firstStore, {
      serverId,
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async () => failedRunner,
      onTurnBoundary: async () => undefined,
    });
    const scheduler = new Scheduler(firstStore, runtime, { serverId });
    scheduler.enqueue(agent.id);

    await expect(scheduler.drain()).rejects.toThrow('Claude stdin failed');

    const failedCheck = new Database(path);
    const recovered = failedCheck.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT status FROM turns WHERE id = ?) AS turn_status,
        (SELECT state FROM messages WHERE id = ?) AS message_state,
        (SELECT count(*) FROM turn_messages WHERE turn_id = ?) AS manifest_count,
        (SELECT count(*) FROM process_leases WHERE agent_id = ?) AS lease_count,
        (SELECT count(*) FROM workspace_locks WHERE agent_id = ?) AS lock_count,
        (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
    `).get(agent.id, turn.id, message.id, turn.id, agent.id, agent.id, agent.id) as Record<string, string | number>;
    failedCheck.close();
    expect(recovered).toEqual({
      agent_state: 'queued',
      lease_count: 0,
      lock_count: 0,
      manifest_count: 0,
      message_state: 'pending',
      queue_count: 1,
      turn_status: 'queued',
    });

    const retryIdentity = { pid: 9302, startedAt: '2026-09-01T04:05:07.000Z' };
    const retryRunner: ClaudeRuntimeRunner = {
      identity: retryIdentity,
      exited: false,
      sendUserMessage: () => undefined,
      interrupt: async () => true,
    };
    const retryRuntime = new ClaudeRuntime(retryStore, {
      serverId: 'claude-confirmed-retry',
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async () => retryRunner,
      onTurnBoundary: async () => undefined,
    });
    const retryScheduler = new Scheduler(retryStore, retryRuntime, {
      serverId: 'claude-confirmed-retry',
    });
    await retryScheduler.drain();

    const retryCheck = new Database(path);
    const retried = retryCheck.prepare(`
      SELECT tm.turn_id, tm.message_id, m.state AS message_state, t.status AS turn_status
      FROM turn_messages tm
      JOIN messages m ON m.id = tm.message_id
      JOIN turns t ON t.id = tm.turn_id
      WHERE tm.turn_id = ?
    `).get(turn.id) as Record<string, string>;
    retryCheck.close();
    expect(retried).toEqual({
      message_id: message.id,
      message_state: 'leased',
      turn_id: turn.id,
      turn_status: 'running',
    });
  });

  it('requeues exact identities when Claude exits inside the launch window', async () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const serverId = 'claude-launch-exit';
    const { agent, turn } = store.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Recover launch exit',
    });
    const message = store.enqueueMessage(agent.id, 'followup', 'same launch input').message;
    const identity = { pid: 9351, startedAt: '2026-09-01T04:15:16.000Z' };
    const runtime = new ClaudeRuntime(store, {
      serverId,
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async (launch) => {
        launch.onExit({ exitCode: 1 });
        return {
          identity,
          exited: true,
          sendUserMessage: () => undefined,
          interrupt: async () => true,
        };
      },
      onTurnBoundary: async () => undefined,
    });
    const scheduler = new Scheduler(store, runtime, { serverId });
    scheduler.enqueue(agent.id);

    const error = await scheduler.drain().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'RuntimeProcessContainmentError',
      identity,
      ownershipContained: true,
      confirmedDead: true,
    });
    const check = new Database(path);
    const recovered = check.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT status FROM turns WHERE id = ?) AS turn_status,
        (SELECT state FROM messages WHERE id = ?) AS message_state,
        (SELECT count(*) FROM turn_messages WHERE turn_id = ?) AS manifest_count,
        (SELECT count(*) FROM process_leases WHERE agent_id = ?) AS lease_count,
        (SELECT count(*) FROM workspace_locks WHERE agent_id = ?) AS lock_count,
        (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
    `).get(agent.id, turn.id, message.id, turn.id, agent.id, agent.id, agent.id) as Record<string, string | number>;
    check.close();
    expect(recovered).toEqual({
      agent_state: 'queued',
      lease_count: 0,
      lock_count: 0,
      manifest_count: 0,
      message_state: 'pending',
      queue_count: 1,
      turn_status: 'queued',
    });
  });

  it.each([0, 17])(
    'fails and releases a live turn exactly once when Claude exits mid-turn with code %s',
    async (exitCode) => {
      const path = temporaryDatabase();
      const store = openStore(path);
      stores.push(store);
      const serverId = `claude-mid-turn-exit-${exitCode}`;
      const { agent, turn } = store.createAgent({
        cwd: temporaryWorkspace(),
        task: `Observe mid-turn exit ${exitCode}`,
      });
      const message = store.enqueueMessage(agent.id, 'followup', 'leased query').message;
      const identity = {
        pid: 9360 + exitCode,
        startedAt: '2026-09-01T04:25:26.000Z',
      };
      let launch: Parameters<NonNullable<ConstructorParameters<typeof ClaudeRuntime>[1]['createRunner']>>[0]
        | undefined;
      let scheduler!: Scheduler;
      const processExits: number[] = [];
      const runtime = new ClaudeRuntime(store, {
        serverId,
        emptyMcpConfig: 'C:\\state\\empty-mcp.json',
        createRunner: async (createdLaunch) => {
          launch = createdLaunch;
          return {
            identity,
            exited: false,
            sendUserMessage: () => undefined,
            interrupt: async () => true,
          };
        },
        onTurnBoundary: (agentId) => scheduler.onTurnBoundary(agentId),
        onProcessExit: (_agentId, event) => { processExits.push(event.exitCode); },
      });
      scheduler = new Scheduler(store, runtime, { serverId });
      scheduler.enqueue(agent.id);
      await scheduler.drain();
      const after = store.latestCursor();
      const waiting = new EventWaiter(store).wait([agent.id], after, 1_000);

      launch?.onExit({ exitCode });
      launch?.onExit({ exitCode });
      const observed = await waiting;
      await vi.waitFor(() => expect(store.getAgent(agent.id)?.state).toBe('idle'));

      expect(observed.events.map((event) => event.type)).toContain('turn.failed');
      expect(processExits).toEqual([exitCode]);
      expect(store.listTurns(agent.id)).toMatchObject([{ id: turn.id, status: 'failed' }]);
      expect(store.readEvents({ agentIds: [agent.id], after, limit: 20 })
        .filter((event) => event.type === 'turn.failed')).toHaveLength(1);
      const check = new Database(path);
      const state = check.prepare(`
        SELECT
          (SELECT state FROM messages WHERE id = ?) AS message_state,
          (SELECT count(*) FROM process_leases WHERE agent_id = ?) AS lease_count,
          (SELECT count(*) FROM workspace_locks WHERE agent_id = ?) AS lock_count,
          (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
      `).get(message.id, agent.id, agent.id, agent.id) as Record<string, string | number>;
      check.close();
      expect(state).toEqual({
        lease_count: 0,
        lock_count: 0,
        message_state: 'acknowledged',
        queue_count: 0,
      });
      await expect(runtime.deliver(agent, message, true)).rejects
        .toThrow('Claude runtime is not active');
    },
  );

  it('keeps an interrupt-triggered Claude exit on the single interrupted boundary', async () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const serverId = 'claude-expected-interrupt-exit';
    const { agent, turn } = store.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Interrupt without a failed duplicate',
    });
    const identity = { pid: 9388, startedAt: '2026-09-01T04:35:36.000Z' };
    let launch: Parameters<NonNullable<ConstructorParameters<typeof ClaudeRuntime>[1]['createRunner']>>[0]
      | undefined;
    let scheduler!: Scheduler;
    const runtime = new ClaudeRuntime(store, {
      serverId,
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async (createdLaunch) => {
        launch = createdLaunch;
        return {
          identity,
          exited: false,
          sendUserMessage: () => undefined,
          interrupt: async () => {
            launch?.onExit({ exitCode: 130 });
            return true;
          },
        };
      },
      onTurnBoundary: (agentId) => scheduler.onTurnBoundary(agentId),
    });
    scheduler = new Scheduler(store, runtime, { serverId });
    scheduler.enqueue(agent.id);
    await scheduler.drain();

    store.requestInterrupt(agent.id);
    await scheduler.drain();

    expect(store.listTurns(agent.id)).toMatchObject([{ id: turn.id, status: 'interrupted' }]);
    expect(store.readEvents({ agentIds: [agent.id], after: '0', limit: 50 })
      .filter((event) => event.type === 'turn.failed')).toEqual([]);
    const check = new Database(path);
    const state = check.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT count(*) FROM process_leases WHERE agent_id = ?) AS lease_count,
        (SELECT count(*) FROM workspace_locks WHERE agent_id = ?) AS lock_count
    `).get(agent.id, agent.id, agent.id) as Record<string, string | number>;
    check.close();
    expect(state).toEqual({ agent_state: 'idle', lease_count: 0, lock_count: 0 });
  });

  it('retains exact ClaudeRuntime ownership as needs-attention when failed-start exit is unconfirmed', async () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const serverId = 'claude-unconfirmed-failure';
    const { agent, turn } = store.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Contain live Claude owner',
    });
    const message = store.enqueueMessage(agent.id, 'followup', 'do not duplicate').message;
    const identity = { pid: 9401, startedAt: '2026-09-01T05:06:07.000Z' };
    const runtime = new ClaudeRuntime(store, {
      serverId,
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async () => ({
        identity,
        exited: false,
        sendUserMessage: () => { throw new Error('Claude stdin failed'); },
        interrupt: async () => false,
      }),
      onTurnBoundary: async () => undefined,
    });
    const scheduler = new Scheduler(store, runtime, { serverId });
    scheduler.enqueue(agent.id);

    await expect(scheduler.drain()).rejects.toThrow();

    const check = new Database(path);
    const retained = check.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT status FROM turns WHERE id = ?) AS turn_status,
        (SELECT state FROM messages WHERE id = ?) AS message_state,
        (SELECT count(*) FROM turn_messages WHERE turn_id = ?) AS manifest_count,
        (SELECT pid FROM process_leases WHERE agent_id = ?) AS pid,
        (SELECT process_started_at FROM process_leases WHERE agent_id = ?) AS process_started_at,
        (SELECT count(*) FROM workspace_locks WHERE agent_id = ?) AS lock_count,
        (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
    `).get(agent.id, turn.id, message.id, turn.id, agent.id, agent.id, agent.id, agent.id) as Record<string, string | number>;
    check.close();
    expect(retained).toEqual({
      agent_state: 'needs_attention',
      lock_count: 1,
      manifest_count: 1,
      message_state: 'leased',
      pid: identity.pid,
      process_started_at: identity.startedAt,
      queue_count: 0,
      turn_status: 'running',
    });
  });

  it('propagates exact identity when unconfirmed interrupt containment persistence fails', async () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const serverId = 'claude-uncontained-interrupt';
    const { agent, turn } = store.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Expose uncontained process',
    });
    const message = store.enqueueMessage(agent.id, 'followup', 'preserve caller evidence').message;
    const identity = { pid: 9451, startedAt: '2026-09-01T05:16:17.000Z' };
    Object.defineProperty(store, 'containRuntimeProcess', {
      configurable: true,
      value: () => { throw new Error('containment database write failed'); },
    });
    const runtime = new ClaudeRuntime(store, {
      serverId,
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async () => ({
        identity,
        exited: false,
        sendUserMessage: () => { throw new Error('Claude stdin failed'); },
        interrupt: async () => false,
      }),
      onTurnBoundary: async () => undefined,
    });
    const scheduler = new Scheduler(store, runtime, { serverId });
    scheduler.enqueue(agent.id);

    const error = await scheduler.drain().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'RuntimeProcessContainmentError',
      identity,
      ownershipContained: false,
      confirmedDead: false,
    });
    expect((error as Error & { cause?: AggregateError }).cause).toBeInstanceOf(AggregateError);
    expect((error as Error & { cause: AggregateError }).cause.errors.map((cause) =>
      cause instanceof Error ? cause.message : String(cause)))
      .toEqual(['Claude stdin failed', 'containment database write failed']);
    const check = new Database(path);
    const retained = check.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT status FROM turns WHERE id = ?) AS turn_status,
        (SELECT state FROM messages WHERE id = ?) AS message_state,
        (SELECT pid FROM process_leases WHERE agent_id = ?) AS pid,
        (SELECT process_started_at FROM process_leases WHERE agent_id = ?) AS process_started_at,
        (SELECT count(*) FROM workspace_locks WHERE agent_id = ?) AS lock_count,
        (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
    `).get(agent.id, turn.id, message.id, agent.id, agent.id, agent.id, agent.id) as Record<string, string | number>;
    check.close();
    expect(retained).toEqual({
      agent_state: 'running',
      lock_count: 1,
      message_state: 'leased',
      pid: identity.pid,
      process_started_at: identity.startedAt,
      queue_count: 0,
      turn_status: 'running',
    });
  });

  it('does not release scheduler ownership when attach-failure containment persistence fails', async () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const serverId = 'claude-containment-write-failure';
    const { agent, turn } = store.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Retain ownership on database failure',
    });
    const message = store.enqueueMessage(agent.id, 'followup', 'still owned').message;
    const identity = { pid: 9501, startedAt: '2026-09-01T06:07:08.000Z' };
    vi.spyOn(store, 'attachRuntimeProcess').mockReturnValueOnce(false);
    Object.defineProperty(store, 'containRuntimeProcess', {
      configurable: true,
      value: () => { throw new Error('containment database write failed'); },
    });
    const runtime = new ClaudeRuntime(store, {
      serverId,
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async () => ({
        identity,
        exited: false,
        sendUserMessage: () => undefined,
        interrupt: async () => false,
      }),
      onTurnBoundary: async () => undefined,
    });
    const scheduler = new Scheduler(store, runtime, { serverId });
    scheduler.enqueue(agent.id);

    const error = await scheduler.drain().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'RuntimeProcessContainmentError',
      identity,
      ownershipContained: false,
      confirmedDead: false,
    });
    const check = new Database(path);
    const retained = check.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT status FROM turns WHERE id = ?) AS turn_status,
        (SELECT state FROM messages WHERE id = ?) AS message_state,
        (SELECT count(*) FROM process_leases WHERE agent_id = ?) AS lease_count,
        (SELECT count(*) FROM workspace_locks WHERE agent_id = ?) AS lock_count,
        (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
    `).get(agent.id, turn.id, message.id, agent.id, agent.id, agent.id) as Record<string, string | number>;
    check.close();
    expect(retained).toEqual({
      agent_state: 'running',
      lease_count: 1,
      lock_count: 1,
      message_state: 'leased',
      queue_count: 0,
      turn_status: 'running',
    });
  });

  it('recovers an unacknowledged lease after its confirmed process owner crashes', async () => {
    const path = temporaryDatabase();
    const crashedStore = openStore(path);
    stores.push(crashedStore);
    const { agent, turn } = crashedStore.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Crash recovery',
    });
    const message = crashedStore.enqueueMessage(agent.id, 'followup', 'retry after crash').message;
    const crashedScheduler = new Scheduler(
      crashedStore,
      new RecordingRuntime(),
      { serverId: 'confirmed-dead-owner' },
    );
    crashedScheduler.enqueue(agent.id);
    await crashedScheduler.drain();
    closeTrackedStore(crashedStore);

    const recoveredStore = openStore(path);
    stores.push(recoveredStore);
    expect(recoveredStore.recoverRuntimeFailure(
      agent.id, turn.id, 'confirmed-dead-owner',
    )).toBe(true);
    const recoveredCheck = new Database(path);
    const recovered = recoveredCheck.prepare(`
      SELECT t.status AS turn_status, m.state AS message_state
      FROM turns t, messages m
      WHERE t.id = ? AND m.id = ?
    `).get(turn.id, message.id) as { message_state: string; turn_status: string };
    recoveredCheck.close();
    expect(recovered).toEqual({ message_state: 'pending', turn_status: 'queued' });
    const retryRuntime = new RecordingRuntime();
    const retryScheduler = new Scheduler(
      recoveredStore,
      retryRuntime,
      { serverId: 'replacement-owner' },
    );
    await retryScheduler.drain();

    expect(retryRuntime.startTurnNumbers).toEqual([1]);
    expect(retryRuntime.startMessageIds).toEqual([[message.id]]);
    const check = new Database(path);
    const row = check.prepare(`
      SELECT t.status AS turn_status, m.state AS message_state
      FROM turns t, messages m
      WHERE t.id = ? AND m.id = ?
    `).get(turn.id, message.id) as { message_state: string; turn_status: string };
    check.close();
    expect(row).toEqual({ message_state: 'leased', turn_status: 'running' });
  });

  it('durably restores unacknowledged live messages for retry after delivery failure', async () => {
    const path = temporaryDatabase();
    const firstStore = openStore(path);
    const secondStore = openStore(path);
    stores.push(firstStore, secondStore);
    const { agent, turn } = firstStore.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Retry delivery durably',
    });
    const failingRuntime = new FailingDeliveryRuntime();
    const scheduler = new Scheduler(firstStore, failingRuntime, { serverId: 'delivery-failure' });
    scheduler.enqueue(agent.id);
    await scheduler.drain();
    const first = secondStore.enqueueMessage(agent.id, 'message', 'context').message;
    const second = secondStore.enqueueMessage(agent.id, 'followup', 'query').message;
    scheduler.enqueue(agent.id);

    await expect(scheduler.drain()).rejects.toThrow('runtime failed to deliver');

    const check = new Database(path);
    const rows = check.prepare(`
      SELECT id, state FROM messages WHERE agent_id = ? ORDER BY rowid ASC
    `).all(agent.id) as Array<{ id: string; state: string }>;
    const lifecycle = check.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT status FROM turns WHERE id = ?) AS turn_status,
        (SELECT count(*) FROM turn_messages WHERE turn_id = ?) AS manifest_count,
        (SELECT count(*) FROM process_leases WHERE agent_id = ?) AS process_count,
        (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
    `).get(agent.id, turn.id, turn.id, agent.id, agent.id) as Record<string, string | number>;
    check.close();
    expect(rows).toEqual([
      { id: first.id, state: 'pending' },
      { id: second.id, state: 'pending' },
    ]);
    expect(lifecycle).toEqual({
      agent_state: 'queued',
      manifest_count: 0,
      process_count: 0,
      queue_count: 1,
      turn_status: 'queued',
    });

    const retryRuntime = new RecordingRuntime();
    const retryScheduler = new Scheduler(secondStore, retryRuntime, { serverId: 'delivery-retry' });
    await retryScheduler.drain();

    expect(failingRuntime.interruptions).toEqual([agent.id]);
    expect(retryRuntime.startMessageIds).toEqual([[first.id, second.id]]);
  });

  it('lets only the database lease owner pump cross-instance messages in order', async () => {
    const path = temporaryDatabase();
    const ownerStore = openStore(path);
    const otherStore = openStore(path);
    stores.push(ownerStore, otherStore);
    const { agent, turn } = ownerStore.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Cross-instance mailbox owner',
    });
    const ownerRuntime = new RecordingRuntime();
    const otherRuntime = new RecordingRuntime();
    const owner = new Scheduler(ownerStore, ownerRuntime, { serverId: 'mailbox-owner' });
    const other = new Scheduler(otherStore, otherRuntime, { serverId: 'mailbox-other' });
    owner.enqueue(agent.id);
    await owner.drain();
    const first = otherStore.enqueueMessage(agent.id, 'message', 'remote context').message;
    const second = otherStore.enqueueMessage(agent.id, 'followup', 'remote query').message;

    expect(() => otherStore.leasePendingMessages(agent.id, turn.id, 'mailbox-other'))
      .toThrow('runtime lease is not owned by server');
    other.enqueue(agent.id);
    await other.drain();
    await owner.drain();

    expect(ownerRuntime.starts).toEqual([agent.id]);
    expect(otherRuntime.starts).toEqual([]);
    expect(otherRuntime.deliveries).toEqual([]);
    expect(ownerRuntime.deliveredMessageIds).toEqual([first.id, second.id]);
    expect(ownerRuntime.deliveries).toEqual([
      { content: 'remote context', shouldQuery: false },
      { content: 'remote query', shouldQuery: true },
    ]);
  });

  it('creates a new queued turn for a followup after a terminal boundary', async () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const { agent, turn } = store.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Multiple immutable turns',
    });
    const initial = store.enqueueMessage(agent.id, 'followup', 'first turn').message;
    const runtime = new RecordingRuntime();
    const scheduler = new Scheduler(store, runtime, { serverId: 'next-turn-server' });
    scheduler.enqueue(agent.id);
    await scheduler.drain();
    store.completeTurn(turn.id, 'succeeded');
    const followup = store.enqueueMessage(agent.id, 'followup', 'second turn').message;

    scheduler.enqueue(agent.id);
    await scheduler.onTurnBoundary(agent.id);

    expect(runtime.startTurnNumbers).toEqual([1, 2]);
    expect(runtime.startMessageIds).toEqual([[initial.id], [followup.id]]);
    const check = new Database(path);
    const manifests = check.prepare(`
      SELECT t.number, t.status, tm.message_id, m.state AS message_state
      FROM turns t
      JOIN turn_messages tm ON tm.turn_id = t.id
      JOIN messages m ON m.id = tm.message_id
      WHERE t.agent_id = ?
      ORDER BY t.number, tm.ordinal
    `).all(agent.id) as Array<{
      message_id: string;
      message_state: string;
      number: number;
      status: string;
    }>;
    check.close();
    expect(manifests).toEqual([
      { message_id: initial.id, message_state: 'acknowledged', number: 1, status: 'succeeded' },
      { message_id: followup.id, message_state: 'leased', number: 2, status: 'running' },
    ]);
  });

  it('keeps a context-only terminal-gap message pending without starting turn two', async () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const { agent, turn } = store.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Context stays queued only',
    });
    const runtime = new RecordingRuntime();
    const scheduler = new Scheduler(store, runtime, { serverId: 'context-only-server' });
    scheduler.enqueue(agent.id);
    await scheduler.drain();
    store.completeTurn(turn.id, 'succeeded');
    const context = store.enqueueMessage(agent.id, 'message', 'do not query').message;

    scheduler.enqueue(agent.id);
    await scheduler.onTurnBoundary(agent.id);

    expect(runtime.startTurnNumbers).toEqual([1]);
    const check = new Database(path);
    const state = check.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT state FROM messages WHERE id = ?) AS message_state,
        (SELECT count(*) FROM turns WHERE agent_id = ?) AS turn_count,
        (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
    `).get(agent.id, context.id, agent.id, agent.id) as Record<string, string | number>;
    check.close();
    expect(state).toEqual({
      agent_state: 'idle',
      message_state: 'pending',
      queue_count: 0,
      turn_count: 1,
    });
  });

  it('keeps a context-only message queued-only when the agent is already idle', async () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const { agent, turn } = store.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Idle context stays queued only',
    });
    const runtime = new RecordingRuntime();
    const scheduler = new Scheduler(store, runtime, { serverId: 'idle-context-server' });
    scheduler.enqueue(agent.id);
    await scheduler.drain();
    store.completeTurn(turn.id, 'succeeded');
    await scheduler.onTurnBoundary(agent.id);
    const context = store.enqueueMessage(agent.id, 'message', 'idle context').message;

    scheduler.enqueue(agent.id);
    await scheduler.drain();

    expect(runtime.startTurnNumbers).toEqual([1]);
    const check = new Database(path);
    const state = check.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT state FROM messages WHERE id = ?) AS message_state,
        (SELECT count(*) FROM turns WHERE agent_id = ?) AS turn_count,
        (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
    `).get(agent.id, context.id, agent.id, agent.id) as Record<string, string | number>;
    check.close();
    expect(state).toEqual({
      agent_state: 'idle',
      message_state: 'pending',
      queue_count: 0,
      turn_count: 1,
    });
  });

  it('starts one new turn with earlier context when a later followup arrives', async () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const { agent, turn } = store.createAgent({
      cwd: temporaryWorkspace(),
      task: 'Batch idle context with followup',
    });
    const runtime = new RecordingRuntime();
    const scheduler = new Scheduler(store, runtime, { serverId: 'context-followup-server' });
    scheduler.enqueue(agent.id);
    await scheduler.drain();
    store.completeTurn(turn.id, 'succeeded');
    await scheduler.onTurnBoundary(agent.id);
    const context = store.enqueueMessage(agent.id, 'message', 'earlier context').message;
    scheduler.enqueue(agent.id);
    await scheduler.drain();
    const followup = store.enqueueMessage(agent.id, 'followup', 'later query').message;

    scheduler.enqueue(agent.id);
    await scheduler.drain();

    expect(runtime.startTurnNumbers).toEqual([1, 2]);
    expect(runtime.startMessageIds).toEqual([[], [context.id, followup.id]]);
    expect(runtime.startShouldQuery).toEqual([[], [false, true]]);
    const check = new Database(path);
    const manifest = check.prepare(`
      SELECT tm.ordinal, tm.message_id, m.kind, m.state
      FROM turn_messages tm
      JOIN turns t ON t.id = tm.turn_id
      JOIN messages m ON m.id = tm.message_id
      WHERE t.agent_id = ? AND t.number = 2
      ORDER BY tm.ordinal
    `).all(agent.id) as Array<{
      kind: string;
      message_id: string;
      ordinal: number;
      state: string;
    }>;
    check.close();
    expect(manifest).toEqual([
      { kind: 'message', message_id: context.id, ordinal: 0, state: 'leased' },
      { kind: 'followup', message_id: followup.id, ordinal: 1, state: 'leased' },
    ]);
  });
});
