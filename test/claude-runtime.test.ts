import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent, Message, Turn } from '../src/domain.js';
import {
  assertSupportedClaudeVersion,
  ClaudeRunner,
  type ClaudePty,
} from '../src/claude/runner.js';
import {
  ClaudeRuntime,
  type ClaudeRunnerFactory,
  type ClaudeRunnerLaunch,
} from '../src/claude/runtime.js';
import { openStore, type AgentStore } from '../src/store.js';

class FakePty implements ClaudePty {
  readonly inputTerminator?: string;
  writes: string[] = [];
  ended = false;
  #dataListeners: Array<(data: string) => void> = [];
  #exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  constructor(readonly pid = 4512, inputTerminator?: string) {
    this.inputTerminator = inputTerminator;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.push(listener);
    return { dispose: () => undefined };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => undefined };
  }

  emitData(data: string): void {
    for (const listener of this.#dataListeners) listener(data);
  }

  emitExit(exitCode = 0): void {
    this.ended = true;
    for (const listener of this.#exitListeners) listener({ exitCode });
  }
}

const directories: string[] = [];
const stores: AgentStore[] = [];

function temporaryStore(): AgentStore {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mcp-runtime-'));
  directories.push(directory);
  const store = openStore(join(directory, 'state.sqlite'));
  stores.push(store);
  return store;
}

function fixtures(store: AgentStore): { agent: Agent; turn: Turn; context: Message; followup: Message } {
  const { agent, turn } = store.createAgent({
    task: 'Inspect the workspace',
    permissionProfile: 'read_only',
    sessionId: '11111111-1111-4111-8111-111111111111',
  });
  store.scheduleAgent(agent.id, process.cwd(), 'reader');
  const claim = store.claimNextScheduled('runtime-test');
  if (!claim) throw new Error('fixture lease was not claimed');
  const context = store.enqueueMessage(agent.id, 'message', 'context only').message;
  const followup = store.enqueueMessage(agent.id, 'followup', 'now answer').message;
  return { agent: claim.agent, turn: claim.turn, context, followup };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('ClaudeRunner', () => {
  it('accepts the pinned minimum Claude Code version and newer patch releases', () => {
    expect(() => assertSupportedClaudeVersion('2.1.238 (Claude Code)')).not.toThrow();
    expect(() => assertSupportedClaudeVersion('2.1.300 (Claude Code)')).not.toThrow();
  });

  it('rejects Claude Code versions older than the pinned protocol version', () => {
    expect(() => assertSupportedClaudeVersion('2.1.237 (Claude Code)'))
      .toThrow('Claude Code 2.1.238 or newer is required');
  });

  it('writes one replayable stream-json user frame per message with the transport line ending', () => {
    const pty = new FakePty(4512, '\n');
    const runner = new ClaudeRunner(pty, {
      startedAt: '2026-09-01T00:00:00.000Z',
      onJson: () => undefined,
      onDiagnostic: () => undefined,
      killTree: async () => undefined,
    });

    runner.sendUserMessage('hello', false);
    runner.sendUserMessage('query', true);

    expect(pty.writes).toEqual([
      '{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"text","text":"hello"}]},"shouldQuery":false}\n',
      '{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"text","text":"query"}]}}\n',
    ]);
  });

  it('sends Ctrl+C, then escalates with a taskkill argv array after grace expires', async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const kills: Array<{ executable: string; args: string[] }> = [];
    const runner = new ClaudeRunner(pty, {
      startedAt: '2026-09-01T00:00:00.000Z',
      onJson: () => undefined,
      onDiagnostic: () => undefined,
      inspectProcessIdentity: () => 'matching',
      killTree: async (executable, args) => {
        kills.push({ executable, args: [...args] });
        pty.emitExit();
      },
    });

    const interrupted = runner.interrupt(25);
    expect(pty.writes).toEqual(['\u0003']);
    await vi.advanceTimersByTimeAsync(25);
    await interrupted;

    expect(kills).toEqual([{
      executable: 'taskkill',
      args: ['/PID', '4512', '/T', '/F'],
    }]);
  });

  it.each(['missing', 'reused'] as const)(
    'does not taskkill when exact identity inspection reports the PID as %s',
    async (inspection) => {
      vi.useFakeTimers();
      const pty = new FakePty();
      const killTree = vi.fn(async () => undefined);
      const runner = new ClaudeRunner(pty, {
        startedAt: '2026-09-01T00:00:00.000Z',
        onJson: () => undefined,
        onDiagnostic: () => undefined,
        inspectProcessIdentity: () => inspection,
        killConfirmationMs: 0,
        killTree,
      });

      const interrupted = runner.interrupt(5);
      await vi.runAllTimersAsync();

      await expect(interrupted).resolves.toBe(true);
      expect(killTree).not.toHaveBeenCalled();
    },
  );

  it('does not taskkill when exact process identity cannot be inspected', async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const killTree = vi.fn(async () => undefined);
    const runner = new ClaudeRunner(pty, {
      startedAt: '2026-09-01T00:00:00.000Z',
      onJson: () => undefined,
      onDiagnostic: () => undefined,
      inspectProcessIdentity: () => 'unknown',
      killConfirmationMs: 0,
      killTree,
    });

    const interrupted = runner.interrupt(5);
    await vi.runAllTimersAsync();

    await expect(interrupted).resolves.toBe(false);
    expect(killTree).not.toHaveBeenCalled();
  });

  it('waits for a delayed exit after taskkill and clears a settled interrupt operation', async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const runner = new ClaudeRunner(pty, {
      startedAt: '2026-09-01T00:00:00.000Z',
      onJson: () => undefined,
      onDiagnostic: () => undefined,
      killConfirmationMs: 25,
      inspectProcessIdentity: () => 'matching',
      killTree: async () => { setTimeout(() => pty.emitExit(), 10); },
    });

    const interrupted = runner.interrupt(5);
    let settled: boolean | undefined;
    void interrupted.then((value) => { settled = value; });
    await vi.advanceTimersByTimeAsync(5);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    await expect(interrupted).resolves.toBe(true);
    await expect(runner.interrupt(5)).resolves.toBe(true);
  });

  it('does not retain a false interrupt result after the process later exits', async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const runner = new ClaudeRunner(pty, {
      startedAt: '2026-09-01T00:00:00.000Z',
      onJson: () => undefined,
      onDiagnostic: () => undefined,
      killConfirmationMs: 5,
      inspectProcessIdentity: () => 'matching',
      killTree: async () => undefined,
    });

    const first = runner.interrupt(5);
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toBe(false);
    pty.emitExit();

    await expect(runner.interrupt(5)).resolves.toBe(true);
  });

  it('escalates to taskkill when writing Ctrl+C itself fails', async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    pty.write = () => { throw new Error('PTY input is closed'); };
    const killTree = vi.fn(async () => { pty.emitExit(1); });
    const runner = new ClaudeRunner(pty, {
      startedAt: '2026-09-01T00:00:00.000Z',
      onJson: () => undefined,
      onDiagnostic: () => undefined,
      inspectProcessIdentity: () => 'matching',
      killTree,
    });

    await expect(runner.interrupt(5)).resolves.toBe(true);
    expect(killTree).toHaveBeenCalledWith('taskkill', ['/PID', '4512', '/T', '/F']);
  });

  it('buffers output and exit emitted during process identity lookup in order', async () => {
    const pty = new FakePty(9922);
    const observed: string[] = [];
    vi.resetModules();
    vi.doMock('node-pty', () => ({ spawn: () => pty }));
    try {
      const { ClaudeRunner: IsolatedRunner } = await import('../src/claude/runner.js');
      const spawned = Promise.resolve(IsolatedRunner.spawn({
        executable: process.execPath,
        args: [],
        cwd: process.cwd(),
        usePty: true,
        versionCheck: () => undefined,
        processStartedAt: () => {
          pty.emitData('{"type":"system","phase":"bootstrap"}\r\n');
          pty.emitExit(7);
          return '2026-09-01T00:00:00.000Z';
        },
        onJson: (value) => { observed.push(`json:${(value as { type: string }).type}`); },
        onDiagnostic: () => undefined,
        onExit: ({ exitCode }) => { observed.push(`exit:${exitCode}`); },
      }));
      const runner = await spawned;

      expect(observed).toEqual(['json:system', 'exit:7']);
      expect(runner.exited).toBe(true);
    } finally {
      vi.doUnmock('node-pty');
      vi.resetModules();
    }
  });

  it('does not force-kill a spawned child when process identity lookup fails', async () => {
    vi.useFakeTimers();
    const pty = new FakePty(9933);
    const kills: string[][] = [];
    vi.resetModules();
    vi.doMock('node-pty', () => ({ spawn: () => pty }));
    try {
      const { ClaudeRunner: IsolatedRunner } = await import('../src/claude/runner.js');
      const spawning = Promise.resolve().then(() => IsolatedRunner.spawn({
        executable: process.execPath,
        args: [],
        cwd: process.cwd(),
        usePty: true,
        versionCheck: () => undefined,
        processStartedAt: () => { throw new Error('creation time lookup failed'); },
        initializationCleanupGraceMs: 5,
        killConfirmationMs: 10,
        killTree: async (_executable, args) => {
          kills.push([...args]);
          setTimeout(() => pty.emitExit(1), 5);
        },
        onJson: () => undefined,
        onDiagnostic: () => undefined,
      }));
      const outcome = spawning.catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      expect(await outcome).toMatchObject({
        name: 'ClaudeSpawnCleanupError',
        pid: 9933,
      });
      expect(pty.writes).toEqual(['\u0003']);
      expect(kills).toEqual([]);
      expect(pty.ended).toBe(false);
    } finally {
      vi.doUnmock('node-pty');
      vi.resetModules();
    }
  });

  it('does not force-kill when listener setup fails before process identity is known', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const rawPty: ClaudePty = {
      pid: 9944,
      write: (data) => { writes.push(data); },
      onExit: () => ({ dispose: () => undefined }),
      onData: () => { throw new Error('data listener registration failed'); },
    };
    vi.resetModules();
    vi.doMock('node-pty', () => ({ spawn: () => rawPty }));
    try {
      const { ClaudeRunner: IsolatedRunner } = await import('../src/claude/runner.js');
      const killTree = vi.fn(async () => undefined);
      const spawning = IsolatedRunner.spawn({
        executable: process.execPath,
        args: [],
        cwd: process.cwd(),
        usePty: true,
        versionCheck: () => undefined,
        initializationCleanupGraceMs: 5,
        killConfirmationMs: 10,
        killTree,
        onJson: () => undefined,
        onDiagnostic: () => undefined,
      });
      const outcome = spawning.catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      expect(await outcome).toMatchObject({
        name: 'ClaudeSpawnCleanupError',
        pid: 9944,
      });
      expect(writes).toEqual(['\u0003']);
      expect(killTree).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node-pty');
      vi.resetModules();
    }
  });

  it('reports the PID when initialization cleanup cannot confirm process exit', async () => {
    vi.useFakeTimers();
    const pty = new FakePty(9955);
    vi.resetModules();
    vi.doMock('node-pty', () => ({ spawn: () => pty }));
    try {
      const { ClaudeRunner: IsolatedRunner } = await import('../src/claude/runner.js');
      const spawning = IsolatedRunner.spawn({
        executable: process.execPath,
        args: [],
        cwd: process.cwd(),
        usePty: true,
        versionCheck: () => undefined,
        processStartedAt: () => { throw new Error('identity unavailable'); },
        initializationCleanupGraceMs: 5,
        killConfirmationMs: 5,
        killTree: async () => undefined,
        onJson: () => undefined,
        onDiagnostic: () => undefined,
      });
      const outcome = spawning.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);

      expect(await outcome).toMatchObject({
        name: 'ClaudeSpawnCleanupError',
        pid: 9955,
      });
    } finally {
      vi.doUnmock('node-pty');
      vi.resetModules();
    }
  });

  it('validates cleanup timing before spawning a child', async () => {
    const spawn = vi.fn(() => new FakePty(9966));
    vi.resetModules();
    vi.doMock('node-pty', () => ({ spawn }));
    try {
      const { ClaudeRunner: IsolatedRunner } = await import('../src/claude/runner.js');

      await expect(IsolatedRunner.spawn({
        executable: process.execPath,
        args: [],
        cwd: process.cwd(),
        usePty: true,
        versionCheck: () => undefined,
        initializationCleanupGraceMs: -1,
        onJson: () => undefined,
        onDiagnostic: () => undefined,
      })).rejects.toThrow('initialization cleanup grace must be a non-negative integer');

      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node-pty');
      vi.resetModules();
    }
  });

  it('does not escalate after the PTY confirms exit during grace', async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const killTree = vi.fn(async () => undefined);
    const runner = new ClaudeRunner(pty, {
      startedAt: '2026-09-01T00:00:00.000Z',
      onJson: () => undefined,
      onDiagnostic: () => undefined,
      killTree,
    });

    const interrupted = runner.interrupt(25);
    pty.emitExit();
    await interrupted;

    expect(killTree).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('streams with the fake CLI through Windows stdio pipes', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
    let resolveReady!: () => void;
    let resolveResult!: (value: unknown) => void;
    const diagnostics: string[] = [];
    const eventTypes: unknown[] = [];
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const result = new Promise<unknown>((resolve) => { resolveResult = resolve; });
    const killTree = vi.fn(async () => undefined);
    const runner = await ClaudeRunner.spawn({
      executable: process.execPath,
      args: [fixture],
      cwd: process.cwd(),
      versionCheck: () => undefined,
      processStartedAt: () => '2026-09-01T00:00:00.000Z',
      inspectProcessIdentity: () => 'matching',
      killTree,
      onJson: (value) => {
        const type = typeof value === 'object' && value !== null
          ? (value as { type?: unknown }).type
          : undefined;
        eventTypes.push(type);
        if (type === 'ready') resolveReady();
        if (type === 'result') resolveResult(value);
      },
      onDiagnostic: (text) => { diagnostics.push(text); },
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`fake CLI protocol timed out: ${JSON.stringify({ diagnostics, eventTypes })}`)), 3_000);
    });
    try {
      await Promise.race([ready, timeout]);
      runner.sendUserMessage('fake context', false);
      await expect(Promise.race([result, timeout])).resolves.toMatchObject({
        type: 'result',
        subtype: 'success',
        num_turns: 0,
      });
      expect(await runner.interrupt(1_000)).toBe(true);
      expect(killTree).not.toHaveBeenCalled();
      expect(() => runner.sendUserMessage('too late', true)).toThrow('Claude input is closed');
    } finally {
      if (!runner.exited) await runner.interrupt(0);
    }
  }, 10_000);

  it.runIf(process.platform === 'win32')('rejects a missing pipe executable without an unhandled process error', async () => {
    await expect(ClaudeRunner.spawn({
      executable: join(tmpdir(), 'claude-mcp-missing', 'claude.exe'),
      args: [],
      cwd: process.cwd(),
      versionCheck: () => undefined,
      onJson: () => undefined,
      onDiagnostic: () => undefined,
    })).rejects.toThrow('Claude process did not expose a PID');
  });
});

describe('ClaudeRuntime', () => {
  function setup(): {
    store: AgentStore;
    pty: FakePty;
    launches: ClaudeRunnerLaunch[];
    boundaries: string[];
    diagnostics: string[];
    runtime: ClaudeRuntime;
  } {
    const store = temporaryStore();
    const pty = new FakePty();
    const launches: ClaudeRunnerLaunch[] = [];
    const boundaries: string[] = [];
    const diagnostics: string[] = [];
    const createRunner: ClaudeRunnerFactory = async (launch) => {
      launches.push(launch);
      return new ClaudeRunner(pty, {
        startedAt: '2026-09-01T00:00:00.000Z',
        onJson: launch.onJson,
        onDiagnostic: launch.onDiagnostic,
        onExit: launch.onExit,
        inspectProcessIdentity: () => 'matching',
        killTree: async () => { pty.emitExit(); },
      });
    };
    const runtime = new ClaudeRuntime(store, {
      serverId: 'runtime-test',
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner,
      onTurnBoundary: async (agentId) => { boundaries.push(agentId); },
      onDiagnostic: (_agentId, text) => { diagnostics.push(text); },
      leaseMs: 60_000,
      interruptGraceMs: 0,
    });
    return { store, pty, launches, boundaries, diagnostics, runtime };
  }

  it('starts an initial session with session-id and reconnects later turns with resume', async () => {
    const { store, launches, runtime } = setup();
    const { agent, turn } = fixtures(store);

    await runtime.start(agent, turn, []);
    await runtime.interrupt(agent.id);
    await runtime.start(agent, turn, []);

    expect(launches[0]?.args).toContain('--session-id');
    expect(launches[0]?.args).not.toContain('--resume');
    expect(launches[1]?.args).toContain('--resume');
    expect(launches[1]?.args).not.toContain('--session-id');
  });

  it('persists startup JSON emitted before runner creation resolves', async () => {
    const store = temporaryStore();
    const { agent, turn } = fixtures(store);
    const createRunner: ClaudeRunnerFactory = async (launch) => {
      launch.onJson(
        { type: 'future_bootstrap_event', payload: 9 },
        '{"type":"future_bootstrap_event","payload":9}',
      );
      return {
        identity: { pid: 8844, startedAt: '2026-09-01T00:00:00.000Z' },
        exited: false,
        sendUserMessage: () => undefined,
        interrupt: async () => false,
      };
    };
    const runtime = new ClaudeRuntime(store, {
      serverId: 'runtime-test',
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner,
      onTurnBoundary: async () => undefined,
    });

    await runtime.start(agent, turn, []);

    expect(store.readClaudeEvents(agent.id, 0, 10)).toMatchObject([{
      turnId: turn.id,
      type: 'future_bootstrap_event',
      raw: '{"type":"future_bootstrap_event","payload":9}',
    }]);
  });

  it('retains an unconfirmed spawned PID lease for needs-attention reconciliation', async () => {
    const store = temporaryStore();
    const { agent, turn } = fixtures(store);
    const spawnError = Object.assign(new Error('spawn cleanup unconfirmed'), {
      name: 'ClaudeSpawnCleanupError',
      pid: 8866,
    });
    const runtime = new ClaudeRuntime(store, {
      serverId: 'runtime-test',
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async () => { throw spawnError; },
      onTurnBoundary: async () => undefined,
    });

    await expect(runtime.start(agent, turn, [])).rejects.toBe(spawnError);

    expect(store.getAgent(agent.id)?.state).toBe('needs_attention');
    expect(store.listRuntimeLeases()).toMatchObject([{
      agentId: agent.id,
      pid: 8866,
      processStartedAt: null,
      confirmedDeadAt: null,
    }]);
    expect(store.recoverRuntimeFailure(agent.id, turn.id, 'runtime-test')).toBe(false);
    expect(store.listRuntimeLeases()).toHaveLength(1);
  });

  it('contains an exact-identity child when lease attachment fails and exit is unconfirmed', async () => {
    const store = temporaryStore();
    const { agent, turn } = fixtures(store);
    const identity = { pid: 8877, startedAt: '2026-09-01T02:03:04.000Z' };
    vi.spyOn(store, 'attachRuntimeProcess').mockReturnValueOnce(false);
    const runtime = new ClaudeRuntime(store, {
      serverId: 'runtime-test',
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async () => ({
        identity,
        exited: false,
        sendUserMessage: () => undefined,
        interrupt: async () => false,
      }),
      onTurnBoundary: async () => undefined,
    });

    const error = await runtime.start(agent, turn, []).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'RuntimeProcessContainmentError',
      identity,
      ownershipContained: true,
      confirmedDead: false,
    });
    expect(store.getAgent(agent.id)?.state).toBe('needs_attention');
    expect(store.listRuntimeLeases()).toMatchObject([{
      agentId: agent.id,
      serverId: 'runtime-test',
      pid: identity.pid,
      processStartedAt: identity.startedAt,
      confirmedDeadAt: null,
    }]);
  });

  it('includes exact child identity when the attach-failure containment write also fails', async () => {
    const store = temporaryStore();
    const { agent, turn } = fixtures(store);
    const identity = { pid: 8888, startedAt: '2026-09-01T03:04:05.000Z' };
    vi.spyOn(store, 'attachRuntimeProcess').mockReturnValueOnce(false);
    Object.defineProperty(store, 'containRuntimeProcess', {
      configurable: true,
      value: () => { throw new Error('containment database write failed'); },
    });
    const runtime = new ClaudeRuntime(store, {
      serverId: 'runtime-test',
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async () => ({
        identity,
        exited: false,
        sendUserMessage: () => undefined,
        interrupt: async () => false,
      }),
      onTurnBoundary: async () => undefined,
    });

    const error = await runtime.start(agent, turn, []).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'RuntimeProcessContainmentError',
      identity,
      ownershipContained: false,
      confirmedDead: false,
    });
    expect((error as Error & { cause?: Error }).cause?.message)
      .toBe('containment database write failed');
  });

  it('surfaces a resume-specific error without falling back to a new session', async () => {
    const { store, runtime, launches } = setup();
    const { agent, turn } = fixtures(store);
    await runtime.start(agent, turn, []);
    await runtime.interrupt(agent.id);
    const failingRuntime = new ClaudeRuntime(store, {
      serverId: 'runtime-test',
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async (launch) => {
        launches.push(launch);
        throw new Error('resume rejected by CLI');
      },
      onTurnBoundary: async () => undefined,
    });

    await expect(failingRuntime.start(agent, turn, [])).rejects.toMatchObject({
      name: 'ClaudeResumeError',
    });
    expect(launches.at(-1)?.args).toContain('--resume');
    expect(launches.at(-1)?.args).not.toContain('--session-id');
  });

  it('resolves and records one executable identity per default runtime factory', async () => {
    const store = temporaryStore();
    const resolveExecutable = vi.fn(() => ({
      path: 'C:\\tools\\claude.exe',
      version: '2.1.238',
    }));
    const spawnResolvedRunner = vi.fn(async (_path: string, launch: ClaudeRunnerLaunch) => ({
      identity: { pid: 7755, startedAt: '2026-09-01T00:00:00.000Z' },
      exited: false,
      sendUserMessage: () => undefined,
      interrupt: async () => false,
      launch,
    }));
    const runtime = new ClaudeRuntime(store, {
      serverId: 'metadata-server',
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      resolveExecutable,
      spawnResolvedRunner,
      onTurnBoundary: async () => undefined,
    });
    const firstCreated = store.createAgent({ task: 'first process', permissionProfile: 'read_only' });
    store.scheduleAgent(firstCreated.agent.id, join(process.cwd(), 'first'), 'reader');
    const first = store.claimNextScheduled('metadata-server');
    if (!first) throw new Error('first fixture lease was not claimed');
    const second = store.createAgent({ task: 'second process', permissionProfile: 'read_only' });
    store.scheduleAgent(second.agent.id, join(process.cwd(), 'second'), 'reader');
    const secondClaim = store.claimNextScheduled('metadata-server');
    if (!secondClaim) throw new Error('second fixture lease was not claimed');

    await runtime.start(first.agent, first.turn, []);
    await runtime.start(secondClaim.agent, secondClaim.turn, []);

    expect(resolveExecutable).toHaveBeenCalledTimes(1);
    expect(store.getRuntimeExecutable('metadata-server')).toMatchObject({
      path: 'C:\\tools\\claude.exe',
      version: '2.1.238',
    });
  });

  it('keeps the stream open after a context-only result', async () => {
    const { store, pty, boundaries, runtime } = setup();
    const { agent, turn, context } = fixtures(store);
    await runtime.start(agent, turn, []);

    await runtime.deliver(agent, context, false);
    pty.emitData('{"type":"result","subtype":"success","result":"","num_turns":0}\r\n');

    expect(pty.ended).toBe(false);
    expect(boundaries).toEqual([]);
  });

  it('persists unknown events and completes a query result at the scheduler boundary', async () => {
    const { store, pty, boundaries, runtime } = setup();
    const { agent, turn, followup } = fixtures(store);
    await runtime.start(agent, turn, []);
    await runtime.deliver(agent, followup, true);

    pty.emitData('{"type":"future_event","payload":7}\r\n');
    pty.emitData('{"type":"result","subtype":"success","result":"done","num_turns":1}\r\n');

    expect(store.readClaudeEvents(agent.id, 0, 10).map((event) => event.type)).toEqual([
      'future_event',
      'result',
    ]);
    expect(boundaries).toEqual([agent.id]);
  });

  it('routes PTY noise only to bounded diagnostics', async () => {
    const { store, pty, diagnostics, runtime } = setup();
    const { agent, turn } = fixtures(store);
    await runtime.start(agent, turn, []);

    pty.emitData('native warning\r\n');

    expect(diagnostics).toEqual(['native warning']);
    expect(store.readClaudeEvents(agent.id, 0, 10)).toEqual([]);
  });

  it('requires matching confirmed-dead identity before a stale lease can be reconciled', async () => {
    const { store, runtime } = setup();
    const { agent, turn } = fixtures(store);
    await runtime.start(agent, turn, []);
    const identity = { pid: 4512, startedAt: '2026-09-01T00:00:00.000Z' };

    expect(store.listRuntimeLeases()).toMatchObject([{
      agentId: agent.id,
      serverId: 'runtime-test',
      pid: 4512,
      processStartedAt: identity.startedAt,
      confirmedDeadAt: null,
    }]);
    expect(store.reconcileConfirmedDeadRuntime(agent.id, identity)).toBe(false);
    expect(store.confirmRuntimeProcessDead(agent.id, { ...identity, startedAt: 'wrong' })).toBe(false);
    expect(store.confirmRuntimeProcessDead(agent.id, identity)).toBe(true);
    expect(store.reconcileConfirmedDeadRuntime(agent.id, identity)).toBe(true);
  });

  it('records a child that exits during launch as confirmed dead instead of active', async () => {
    const store = temporaryStore();
    const { agent, turn } = fixtures(store);
    const identity = { pid: 7788, startedAt: '2026-09-01T00:00:00.000Z' };
    const createRunner: ClaudeRunnerFactory = async (launch) => {
      launch.onExit({ exitCode: 1 });
      return {
        identity,
        exited: true,
        sendUserMessage: () => undefined,
        interrupt: async () => true,
      };
    };
    const runtime = new ClaudeRuntime(store, {
      serverId: 'runtime-test',
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner,
      onTurnBoundary: async () => undefined,
    });

    const error = await runtime.start(agent, turn, []).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'RuntimeProcessContainmentError',
      identity,
      ownershipContained: true,
      confirmedDead: true,
    });
    expect(store.listRuntimeLeases()).toMatchObject([{
      agentId: agent.id,
      pid: identity.pid,
      processStartedAt: identity.startedAt,
    }]);
    expect(store.listRuntimeLeases()[0]?.confirmedDeadAt).not.toBeNull();
  });

  it('ignores callbacks from an old launch after a successor runtime becomes active', async () => {
    const store = temporaryStore();
    const { agent, turn } = fixtures(store);
    const launches: ClaudeRunnerLaunch[] = [];
    let nextPid = 9100;
    const runtime = new ClaudeRuntime(store, {
      serverId: 'runtime-test',
      emptyMcpConfig: 'C:\\state\\empty-mcp.json',
      createRunner: async (launch) => {
        launches.push(launch);
        const identity = {
          pid: nextPid++,
          startedAt: `2026-09-01T00:00:0${launches.length}.000Z`,
        };
        return {
          identity,
          exited: false,
          sendUserMessage: () => undefined,
          interrupt: async () => true,
        };
      },
      onTurnBoundary: async () => undefined,
    });

    await runtime.start(agent, turn, []);
    await runtime.interrupt(agent.id);
    await runtime.start(agent, turn, []);
    const successorLease = store.listRuntimeLeases()[0];
    if (!successorLease) throw new Error('successor lease was not attached');

    launches[0]?.onJson({ type: 'assistant', stale: true }, '{"type":"assistant","stale":true}');
    launches[0]?.onExit({ exitCode: 1 });

    expect(store.readClaudeEvents(agent.id, '0', 10)).toEqual([]);
    expect(store.listRuntimeLeases()[0]).toEqual(successorLease);

    launches[1]?.onJson({ type: 'assistant', stale: false }, '{"type":"assistant","stale":false}');
    expect(store.readClaudeEvents(agent.id, '0', 10)).toMatchObject([{
      turnId: turn.id,
      payload: { type: 'assistant', stale: false },
    }]);
  });
});
