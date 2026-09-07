import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStore, openStore } from '../src/store.js';

const temporaryDirectories: string[] = [];
const stores: AgentStore[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mcp-store-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.sqlite');
}

function closeStore(store: AgentStore): void {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  store.close();
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('AgentStore', () => {
  it('atomically requeues the same running turn and message IDs after confirmed process death', () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const { agent, turn } = store.createAgent({ task: 'Recover exact durable work' });
    const message = store.enqueueMessage(agent.id, 'followup', 'same message').message;
    store.scheduleAgent(agent.id, 'C:\\workspace', 'writer');
    const claim = store.claimNextScheduled('dead-server');
    if (!claim) throw new Error('fixture runtime was not claimed');
    const identity = { pid: 6123, startedAt: '2026-09-01T01:02:03.000Z' };
    expect(store.attachRuntimeProcess(
      agent.id,
      'dead-server',
      identity,
      '2026-09-01T01:03:03.000Z',
    )).toBe(true);
    expect(store.confirmRuntimeProcessDead(agent.id, identity)).toBe(true);

    expect(store.reconcileConfirmedDeadRuntime(agent.id, identity)).toBe(true);

    const check = new Database(path);
    check.defaultSafeIntegers(true);
    const state = check.prepare(`
      SELECT
        (SELECT state FROM agents WHERE id = ?) AS agent_state,
        (SELECT status FROM turns WHERE id = ?) AS turn_status,
        (SELECT state FROM messages WHERE id = ?) AS message_state,
        (SELECT count(*) FROM turn_messages WHERE turn_id = ?) AS manifest_count,
        (SELECT count(*) FROM process_leases WHERE agent_id = ?) AS lease_count,
        (SELECT count(*) FROM workspace_locks WHERE agent_id = ?) AS lock_count,
        (SELECT count(*) FROM scheduler_queue WHERE agent_id = ?) AS queue_count
    `).get(agent.id, turn.id, message.id, turn.id, agent.id, agent.id, agent.id) as Record<string, bigint | string>;
    check.close();
    expect(state).toEqual({
      agent_state: 'queued',
      lease_count: 0n,
      lock_count: 0n,
      manifest_count: 0n,
      message_state: 'pending',
      queue_count: 1n,
      turn_status: 'queued',
    });

    const retry = store.claimNextScheduled('replacement-server');
    expect(retry?.turn.id).toBe(turn.id);
    expect(retry?.messages.map((entry) => entry.id)).toEqual([message.id]);
  });

  it('keeps confirmed ownership and marks needs-attention when recovery invariants are incomplete', () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const { agent } = store.createAgent({ task: 'Missing recovery lock' });
    store.scheduleAgent(agent.id, 'C:\\workspace', 'writer');
    expect(store.claimNextScheduled('dead-server')).toBeDefined();
    const identity = { pid: 6124, startedAt: '2026-09-01T01:02:03.000Z' };
    store.attachRuntimeProcess(agent.id, 'dead-server', identity, '2026-09-01T01:03:03.000Z');
    store.confirmRuntimeProcessDead(agent.id, identity);
    const raw = new Database(path);
    raw.prepare(`DELETE FROM workspace_locks WHERE agent_id = ?`).run(agent.id);
    raw.close();

    expect(store.reconcileConfirmedDeadRuntime(agent.id, identity)).toBe(false);

    expect(store.getAgent(agent.id)?.state).toBe('needs_attention');
    expect(store.listRuntimeLeases()).toHaveLength(1);
  });

  it('creates an agent and its first turn in one durable transaction', () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);

    const { agent, turn } = store.createAgent({
      cwd: 'C:\\work',
      permissionProfile: 'read_only',
      task: 'Inspect the repository',
    });

    expect(agent.state).toBe('queued');
    expect(turn.status).toBe('queued');
    expect(turn.agentId).toBe(agent.id);
    expect(store.readEvents({ agentIds: [agent.id], after: '0', limit: 10 })[0]?.type)
      .toBe('agent.created');
  });

  it('defaults both agent creation paths to the read-only permission profile', () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);

    const plain = store.createAgent({ task: 'Inspect only' }).agent;
    const initial = store.createAgentWithInitialTask({ task: 'Inspect with a first query' }).agent;

    expect(plain.permissionProfile).toBe('read_only');
    expect(initial.permissionProfile).toBe('read_only');
  });

  it('persists a created agent event after close and reopen', () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const { agent } = store.createAgent({ task: 'Persist me' });
    closeStore(store);

    const reopened = openStore(path);
    stores.push(reopened);

    expect(reopened.readEvents({ agentIds: [agent.id], after: '0', limit: 10 }))
      .toMatchObject([{ agentId: agent.id, sequence: '1', type: 'agent.created' }]);
  });

  it('rolls back the agent insert when its first turn cannot be inserted', () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const fault = new Database(path);
    fault.exec(`
      CREATE TRIGGER reject_first_turn
      BEFORE INSERT ON turns
      BEGIN SELECT RAISE(ABORT, 'turn insert prevented'); END;
    `);
    fault.close();

    expect(() => store.createAgent({ task: 'Must roll back' })).toThrow('turn insert prevented');
    closeStore(store);

    const check = new Database(path);
    const rawRow = check.prepare('SELECT (SELECT count(*) FROM agents) AS agents, (SELECT count(*) FROM events) AS events').get();
    const row = rawRow as { agents: number; events: number };
    check.close();
    expect(row).toEqual({ agents: 0, events: 0 });
  });

  it('enables WAL mode for the durable database', () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const check = new Database(path);

    const row = check.prepare('PRAGMA journal_mode').get() as { journal_mode: string };

    check.close();
    expect(row.journal_mode).toBe('wal');
  });

  it('enqueues immutable messages and returns their event cursor', () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent } = store.createAgent({ task: 'Inspect the repository' });

    const { cursor, message } = store.enqueueMessage(agent.id, 'followup', 'Check package.json');

    expect(message).toMatchObject({
      agentId: agent.id,
      content: 'Check package.json',
      kind: 'followup',
      state: 'pending',
    });
    expect(cursor).toMatch(/^\d+$/);
    expect(store.readEvents({ agentIds: [agent.id], after: '0', limit: 10 }).map((event) => event.type))
      .toEqual(['agent.created', 'message.enqueued']);
  });

  it('reads events for multiple agents in global decimal-string sequence order after a cursor', () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent: first } = store.createAgent({ task: 'First' });
    const { agent: second } = store.createAgent({ task: 'Second' });
    const firstMessage = store.enqueueMessage(first.id, 'message', 'First message');
    const secondMessage = store.enqueueMessage(second.id, 'message', 'Second message');

    const events = store.readEvents({ agentIds: [first.id, second.id], after: '1', limit: 2 });

    expect(events.map((event) => event.sequence)).toEqual(['2', '3']);
    expect(events.map((event) => event.type)).toEqual(['agent.created', 'message.enqueued']);
    expect(events[1]?.sequence).toBe(firstMessage.cursor);
    expect(firstMessage.cursor).toBe('3');
  });

  it('accepts zero as a numeric event cursor without changing event results', () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent } = store.createAgent({ task: 'Numeric cursor' });

    const events = store.readEvents({ agentIds: [agent.id], after: 0, limit: 10 });

    expect(events).toMatchObject([{ sequence: '1', type: 'agent.created' }]);
  });

  it('rejects an unsafe numeric event cursor instead of rounding it', () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent } = store.createAgent({ task: 'Unsafe cursor' });

    expect(() => store.readEvents({
      agentIds: [agent.id],
      after: Number.MAX_SAFE_INTEGER + 1,
      limit: 10,
    })).toThrow('event cursor must be a non-negative safe integer');
  });

  it.each([-1, 0.5])('rejects non-integer numeric cursor %s', (after) => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent } = store.createAgent({ task: 'Invalid numeric cursor' });

    expect(() => store.readEvents({ agentIds: [agent.id], after, limit: 10 }))
      .toThrow('event cursor must be a non-negative safe integer');
  });

  it('returns a JavaScript number for the persisted first turn number', () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);

    const { turn } = store.createAgent({ task: 'Mapped turn number' });

    expect(turn.number).toBe(1);
    expect(typeof turn.number).toBe('number');
  });

  it('rolls back agent, turn, and event when persisted-turn mapping fails', () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const fault = new Database(path);
    fault.exec(`
      CREATE TRIGGER remove_created_turn
      AFTER INSERT ON turns
      BEGIN DELETE FROM turns WHERE id = NEW.id; END;
    `);
    fault.close();

    expect(() => store.createAgent({ task: 'Missing mapped turn' }))
      .toThrow('created turn could not be read');
    closeStore(store);

    const check = new Database(path);
    const rawRow = check.prepare(`
      SELECT
        (SELECT count(*) FROM agents) AS agents,
        (SELECT count(*) FROM turns) AS turns,
        (SELECT count(*) FROM events) AS events
    `).get();
    const row = rawRow as { agents: number; turns: number; events: number };
    check.close();
    expect(row).toEqual({ agents: 0, turns: 0, events: 0 });
  });

  it('keeps a sequence beyond JavaScript safe integers as a decimal string', () => {
    const path = temporaryDatabase();
    const store = openStore(path);
    stores.push(store);
    const { agent } = store.createAgent({ task: 'Large cursor' });
    const raw = new Database(path);
    raw.prepare(`
      INSERT INTO events (sequence, agent_id, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('9007199254740993', agent.id, 'message.enqueued', '{}', new Date().toISOString());
    raw.close();

    const [event] = store.readEvents({
      agentIds: [agent.id],
      after: '9007199254740992',
      limit: 1,
    });

    expect(event?.sequence).toBe('9007199254740993');
  });
});

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
    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([]);
    expect(store.getAgent(agent.id)?.state).toBe('running');
    expect(store.readEvents({ agentIds: [agent.id], after: '0', limit: 10 })
      .some((event) => event.type === 'agent.stalled')).toBe(false);
  });

  it('emits exactly one agent.stalled event once inactivity exceeds the timeout', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent, turn } = runningAgent(store);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([agent.id]);
    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([]);

    const stalledEvents = store.readEvents({ agentIds: [agent.id], after: '0', limit: 10 })
      .filter((event) => event.type === 'agent.stalled');
    expect(stalledEvents).toHaveLength(1);
    expect(stalledEvents[0]?.payload).toMatchObject({
      turnId: turn.id,
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      stalledForMs: 300_000,
    });
    expect(store.getAgent(agent.id)).toMatchObject({ state: 'running', stallReportedAt: expect.any(String) });
  });

  it('does not change turn or agent state, and does not touch process leases', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent, turn } = runningAgent(store);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    store.detectStalledAgents('server-1', 300_000);

    expect(store.getAgent(agent.id)?.state).toBe('running');
    expect(store.getTurn(turn.id)?.status).toBe('running');
    expect(store.listRuntimeLeases()).toMatchObject([{
      agentId: agent.id,
      serverId: 'server-1',
      confirmedDeadAt: null,
    }]);
  });

  it('re-arms detection after new Claude activity is recorded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent, turn } = runningAgent(store);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([agent.id]);

    store.appendClaudeEvent(
      agent.id,
      turn.id,
      'server-1',
      'assistant',
      { type: 'assistant' },
      '{"type":"assistant"}',
    );
    expect(store.getAgent(agent.id)?.stallReportedAt).toBeNull();

    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([]);
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([agent.id]);

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
    const first = store.detectStalledAgents('server-1', 300_000);
    const race = second.detectStalledAgents('server-1', 300_000);

    expect([...first, ...race]).toEqual([agent.id]);
    const stalledEvents = store.readEvents({ agentIds: [agent.id], after: '0', limit: 10 })
      .filter((event) => event.type === 'agent.stalled');
    expect(stalledEvents).toHaveLength(1);
  });

  it('only lets the process-lease owner report a running turn as stalled', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const path = temporaryDatabase();
    const owner = openStore(path);
    const other = openStore(path);
    stores.push(owner, other);
    const { agent } = runningAgent(owner);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    expect(other.detectStalledAgents('server-2', 60_000)).toEqual([]);
    expect(owner.getAgent(agent.id)?.stallReportedAt).toBeNull();
    expect(owner.detectStalledAgents('server-1', 300_000)).toEqual([agent.id]);
  });

  it('does not report the terminal-turn window even while agent and lease still say running', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent, turn } = runningAgent(store);
    expect(store.completeTurn(turn.id, 'succeeded').completed).toBe(true);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    expect(store.getAgent(agent.id)?.state).toBe('running');
    expect(store.listRuntimeLeases()).toHaveLength(1);
    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([]);
    expect(store.getAgent(agent.id)?.stallReportedAt).toBeNull();
  });

  it('does not report a running turn after its owned process is confirmed dead', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent } = runningAgent(store);
    const identity = { pid: 9201, startedAt: '2026-01-01T00:00:00.000Z' };
    expect(store.attachRuntimeProcess(
      agent.id,
      'server-1',
      identity,
      '2026-01-01T00:10:00.000Z',
    )).toBe(true);
    expect(store.confirmRuntimeProcessDead(agent.id, identity)).toBe(true);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([]);
    expect(store.getAgent(agent.id)?.stallReportedAt).toBeNull();
    expect(store.readEvents({ agentIds: [agent.id], after: '0', limit: 20 })
      .some((event) => event.type === 'agent.stalled')).toBe(false);
  });

  it('keeps a confirmed-dead runtime frame raw without re-arming stall detection', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent, turn } = runningAgent(store);
    const identity = { pid: 9202, startedAt: '2026-01-01T00:00:00.000Z' };
    expect(store.attachRuntimeProcess(
      agent.id,
      'server-1',
      identity,
      '2026-01-01T00:10:00.000Z',
    )).toBe(true);

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([agent.id]);
    const stalled = store.getAgent(agent.id);
    expect(stalled?.stallReportedAt).not.toBeNull();
    expect(store.confirmRuntimeProcessDead(agent.id, identity)).toBe(true);

    vi.setSystemTime(new Date('2026-01-01T00:06:00.000Z'));
    store.appendClaudeEvent(
      agent.id,
      turn.id,
      'server-1',
      'assistant',
      { type: 'assistant', afterExit: true },
      '{"type":"assistant","afterExit":true}',
    );

    expect(store.readClaudeEvents(agent.id, '0', 10)).toMatchObject([{
      turnId: turn.id,
      payload: { type: 'assistant', afterExit: true },
    }]);
    expect(store.getAgent(agent.id)).toMatchObject({
      lastActivityAt: stalled?.lastActivityAt,
      stallReportedAt: stalled?.stallReportedAt,
    });
  });

  it('retains a stale raw frame for audit without re-arming its successor turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent, turn: firstTurn } = runningAgent(store);
    store.enqueueMessage(agent.id, 'followup', 'start a successor');
    expect(store.completeTurn(firstTurn.id, 'succeeded').completed).toBe(true);
    expect(store.releaseRuntimeAtBoundary(agent.id, 'server-1')).toBe(true);
    const successor = store.claimNextScheduled('server-1');
    if (!successor) throw new Error('successor turn was not claimed');

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([agent.id]);
    const reportedAt = store.getAgent(agent.id)?.stallReportedAt;

    store.appendClaudeEvent(
      agent.id,
      firstTurn.id,
      'server-1',
      'assistant',
      { type: 'assistant', stale: true },
      '{"type":"assistant","stale":true}',
    );

    expect(store.readClaudeEvents(agent.id, '0', 10).at(-1)).toMatchObject({
      turnId: firstTurn.id,
      payload: { type: 'assistant', stale: true },
    });
    expect(store.getAgent(agent.id)?.stallReportedAt).toBe(reportedAt);
    expect(store.detectStalledAgents('server-1', 300_000)).toEqual([]);

    store.appendClaudeEvent(
      agent.id,
      successor.turn.id,
      'server-2',
      'assistant',
      { type: 'assistant', wrongOwner: true },
      '{"type":"assistant","wrongOwner":true}',
    );
    expect(store.getAgent(agent.id)?.stallReportedAt).toBe(reportedAt);

    store.appendClaudeEvent(
      agent.id,
      successor.turn.id,
      'server-1',
      'assistant',
      { type: 'assistant', stale: false },
      '{"type":"assistant","stale":false}',
    );
    expect(store.getAgent(agent.id)?.stallReportedAt).toBeNull();
  });
});
