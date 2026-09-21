import type { Agent, Message, Turn } from '../domain.js';
import {
  RuntimeProcessContainmentError,
  type AgentRuntime,
  type RuntimeInterruptResult,
} from '../scheduler.js';
import type { AgentStore } from '../store.js';
import { buildClaudeArgs } from './arguments.js';
import {
  ClaudeRunner,
  inspectClaudeExecutable,
  type ClaudeExecutableIdentity,
} from './runner.js';

export interface ClaudeRunnerLaunch {
  args: string[];
  cwd: string;
  onJson(value: unknown, raw: string): void;
  onDiagnostic(text: string): void;
  onExit(event: { exitCode: number; signal?: number }): void;
}

export interface ClaudeRuntimeRunner {
  readonly identity: { pid: number; startedAt: string };
  readonly exited: boolean;
  sendUserMessage(text: string, shouldQuery: boolean): void;
  interrupt(graceMs: number): Promise<boolean>;
}

export type ClaudeRunnerFactory = (launch: ClaudeRunnerLaunch) => Promise<ClaudeRuntimeRunner>;
export type ResolvedRunnerSpawner = (
  executable: string,
  launch: ClaudeRunnerLaunch,
) => Promise<ClaudeRuntimeRunner>;

export interface ClaudeRuntimeOptions {
  serverId: string;
  emptyMcpConfig: string;
  createRunner?: ClaudeRunnerFactory;
  executable?: string;
  resolveExecutable?(path?: string): ClaudeExecutableIdentity;
  spawnResolvedRunner?: ResolvedRunnerSpawner;
  onTurnBoundary(agentId: string): Promise<void>;
  onDiagnostic?(agentId: string, text: string): void;
  onProcessExit?(agentId: string, event: { exitCode: number; signal?: number }): void;
  leaseMs?: number;
  interruptGraceMs?: number;
}

interface PendingInput {
  shouldQuery: boolean;
}

interface ActiveRuntime {
  runner: ClaudeRuntimeRunner;
  turn: Turn;
  pending: PendingInput[];
  launchToken: symbol;
  starting: boolean;
  stopping: boolean;
}

type LaunchEvent =
  | { kind: 'json'; value: unknown; raw: string }
  | { kind: 'diagnostic'; text: string }
  | { kind: 'exit'; event: { exitCode: number; signal?: number } };

export class ClaudeResumeError extends Error {
  constructor(cause: unknown) {
    super('Claude session resume failed', { cause });
    this.name = 'ClaudeResumeError';
  }
}

function eventType(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === 'string' && type !== '') return type;
  }
  return 'unknown';
}

function resultSucceeded(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as { subtype?: unknown; is_error?: unknown; terminal_reason?: unknown };
  // Claude can emit subtype=success for a completed transport turn containing an API error.
  return result.subtype === 'success'
    && result.is_error !== true
    && result.terminal_reason !== 'api_error';
}

function unconfirmedSpawnPid(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { name?: unknown; pid?: unknown };
  return candidate.name === 'ClaudeSpawnCleanupError'
    && typeof candidate.pid === 'number'
    && Number.isSafeInteger(candidate.pid)
    && candidate.pid > 0
    ? candidate.pid
    : undefined;
}

export class ClaudeRuntime implements AgentRuntime {
  readonly #active = new Map<string, ActiveRuntime>();
  readonly #createRunner: ClaudeRunnerFactory;
  readonly #leaseMs: number;
  readonly #interruptGraceMs: number;

  constructor(
    private readonly store: AgentStore,
    private readonly options: ClaudeRuntimeOptions,
  ) {
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#interruptGraceMs = options.interruptGraceMs ?? 1_000;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1) {
      throw new Error('runtime lease duration must be a positive integer');
    }
    if (!Number.isSafeInteger(this.#interruptGraceMs) || this.#interruptGraceMs < 0) {
      throw new Error('interrupt grace must be a non-negative integer');
    }
    if (options.createRunner) {
      this.#createRunner = options.createRunner;
    } else {
      const executable = (options.resolveExecutable ?? inspectClaudeExecutable)(options.executable);
      this.store.recordRuntimeExecutable(options.serverId, executable.path, executable.version);
      const spawnResolved = options.spawnResolvedRunner
        ?? (async (path: string, launch: ClaudeRunnerLaunch) => ClaudeRunner.spawn({
          ...launch,
          executable: path,
          versionCheck: () => undefined,
        }));
      this.#createRunner = (launch) => spawnResolved(executable.path, launch);
    }
  }

  async start(agent: Agent, turn: Turn, messages: readonly Message[]): Promise<void> {
    if (this.#active.has(agent.id)) throw new Error('Claude runtime is already active');
    const pending: PendingInput[] = [];
    const launchToken = Symbol('claude-runtime-launch');
    const resume = this.store.isClaudeSessionStarted(agent.id);
    const launchEvents: LaunchEvent[] = [];
    let launchReady = false;
    const acceptLaunchEvent = (event: LaunchEvent): void => {
      if (!launchReady) {
        launchEvents.push(event);
        return;
      }
      this.dispatchLaunchEvent(agent.id, launchToken, event);
    };
    const launch: ClaudeRunnerLaunch = {
      args: buildClaudeArgs(agent.permissionProfile, {
        sessionId: agent.sessionId,
        resume,
        emptyMcpConfig: this.options.emptyMcpConfig,
        model: agent.model,
        effort: agent.effort,
      }),
      cwd: agent.cwd ?? process.cwd(),
      onJson: (value, raw) => acceptLaunchEvent({ kind: 'json', value, raw }),
      onDiagnostic: (text) => acceptLaunchEvent({ kind: 'diagnostic', text }),
      onExit: (event) => acceptLaunchEvent({ kind: 'exit', event }),
    };
    let runner: ClaudeRuntimeRunner;
    try {
      runner = await this.#createRunner(launch);
    } catch (error) {
      const unconfirmedPid = unconfirmedSpawnPid(error);
      if (unconfirmedPid !== undefined) {
        this.store.retainUnconfirmedRuntimeProcess(
          agent.id,
          this.options.serverId,
          unconfirmedPid,
          new Date(Date.now() + this.#leaseMs).toISOString(),
        );
      }
      if (resume) throw new ClaudeResumeError(error);
      throw error;
    }
    const expiresAt = new Date(Date.now() + this.#leaseMs).toISOString();
    let attached = false;
    let attachFailure: unknown;
    try {
      attached = this.store.attachRuntimeProcess(
        agent.id,
        this.options.serverId,
        runner.identity,
        expiresAt,
      );
    } catch (error) {
      attachFailure = error;
    }
    if (!attached) {
      let ownershipContained = false;
      let containmentFailure: unknown;
      try {
        ownershipContained = this.store.containRuntimeProcess(
          agent.id,
          this.options.serverId,
          runner.identity,
          expiresAt,
        );
      } catch (error) {
        containmentFailure = error;
      }
      let confirmedDead = false;
      let interruptFailure: unknown;
      try {
        confirmedDead = await runner.interrupt(this.#interruptGraceMs);
      } catch (error) {
        interruptFailure = error;
      }
      if (confirmedDead && ownershipContained) {
        this.store.confirmRuntimeProcessDead(agent.id, runner.identity);
      }
      throw new RuntimeProcessContainmentError(
        'Claude runtime identity attachment failed',
        runner.identity,
        ownershipContained,
        confirmedDead,
        containmentFailure ?? attachFailure ?? interruptFailure,
      );
    }
    this.#active.set(agent.id, {
      runner,
      turn,
      pending,
      launchToken,
      starting: true,
      stopping: false,
    });
    this.store.markClaudeSessionStarted(agent.id);
    launchReady = true;
    for (const event of launchEvents) this.dispatchLaunchEvent(agent.id, launchToken, event);
    if (runner.exited) {
      this.store.confirmRuntimeProcessDead(agent.id, runner.identity);
      this.#active.delete(agent.id);
      throw new RuntimeProcessContainmentError(
        'Claude process exited during launch',
        runner.identity,
        true,
        true,
      );
    }
    this.#active.get(agent.id)!.starting = false;
    for (const message of messages) {
      this.send(this.#active.get(agent.id)!, message.content, message.kind === 'followup');
    }
  }

  async deliver(agent: Agent, message: Message, shouldQuery: boolean): Promise<void> {
    const active = this.#active.get(agent.id);
    if (!active) throw new Error('Claude runtime is not active');
    this.send(active, message.content, shouldQuery);
  }

  async interrupt(agentId: string): Promise<RuntimeInterruptResult | void> {
    const active = this.#active.get(agentId);
    if (!active) return;
    const identity = active.runner.identity;
    active.stopping = true;
    let confirmedExited = false;
    let interruptFailure: unknown;
    try {
      confirmedExited = await active.runner.interrupt(this.#interruptGraceMs);
    } catch (error) {
      interruptFailure = error;
    }
    if (!confirmedExited) {
      let ownershipContained = false;
      let containmentFailure: unknown;
      try {
        ownershipContained = this.store.containRuntimeProcess(
          agentId,
          this.options.serverId,
          identity,
          new Date(Date.now() + this.#leaseMs).toISOString(),
        );
      } catch (error) {
        containmentFailure = error;
      }
      throw new RuntimeProcessContainmentError(
        'Claude process exit was not confirmed after best-effort process-tree termination',
        identity,
        ownershipContained,
        false,
        containmentFailure ?? interruptFailure,
      );
    }
    this.store.confirmRuntimeProcessDead(agentId, identity);
    this.#active.delete(agentId);
    return { status: 'confirmed_dead', identity };
  }

  private send(active: ActiveRuntime, text: string, shouldQuery: boolean): void {
    active.pending.push({ shouldQuery });
    try {
      active.runner.sendUserMessage(text, shouldQuery);
    } catch (error) {
      active.pending.pop();
      throw error;
    }
  }

  private dispatchLaunchEvent(agentId: string, launchToken: symbol, event: LaunchEvent): void {
    if (this.#active.get(agentId)?.launchToken !== launchToken) return;
    if (event.kind === 'json') this.handleJson(agentId, launchToken, event.value, event.raw);
    else if (event.kind === 'diagnostic') this.options.onDiagnostic?.(agentId, event.text);
    else this.handleExit(agentId, launchToken, event.event);
  }

  private handleJson(agentId: string, launchToken: symbol, value: unknown, raw: string): void {
    const active = this.#active.get(agentId);
    if (!active || active.launchToken !== launchToken) return;
    const type = eventType(value);
    this.store.appendClaudeEvent(
      agentId,
      active.turn.id,
      this.options.serverId,
      type,
      value,
      raw,
    );
    if (type !== 'result') return;
    const input = active.pending.shift();
    if (!input) {
      this.options.onDiagnostic?.(agentId, 'Claude emitted a result without a pending input');
      return;
    }
    if (!input.shouldQuery) return;
    const status = resultSucceeded(value) ? 'succeeded' : 'failed';
    const completion = this.store.completeTurn(active.turn.id, status);
    if (!completion.completed) return;
    void this.options.onTurnBoundary(agentId).catch(() => {
      this.options.onDiagnostic?.(agentId, 'scheduler boundary callback failed');
    });
  }

  private handleExit(
    agentId: string,
    launchToken: symbol,
    event: { exitCode: number; signal?: number },
  ): void {
    const active = this.#active.get(agentId);
    if (!active || active.launchToken !== launchToken) return;
    this.store.confirmRuntimeProcessDead(agentId, active.runner.identity);
    if (!active.starting && !active.stopping) {
      this.#active.delete(agentId);
      const completion = this.store.completeTurn(active.turn.id, 'failed');
      if (completion.completed) {
        void this.options.onTurnBoundary(agentId).catch(() => {
          this.options.onDiagnostic?.(agentId, 'scheduler boundary callback failed');
        });
      }
    }
    this.options.onProcessExit?.(agentId, event);
  }
}
