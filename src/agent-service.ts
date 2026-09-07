import { execFileSync } from 'node:child_process';

import { ClaudeResumeError } from './claude/runtime.js';
import type {
  AgentState,
  ClaudeEvent,
  CreateAgentInput,
  Event,
  PermissionProfile,
  ProcessIdentity,
  Turn,
  TurnStatus,
} from './domain.js';
import { EventWaiter, type WaitResult } from './event-waiter.js';
import { RuntimeProcessContainmentError, Scheduler } from './scheduler.js';
import { AgentMailStateError, AgentStore } from './store.js';

const mailAcceptingStates: readonly AgentState[] = [
  'new',
  'queued',
  'running',
  'idle',
  'disconnected',
];

export const agentServiceErrorCodes = [
  'agent_not_found',
  'invalid_state',
  'cursor_expired',
  'cli_unavailable',
  'resume_failed',
  'permission_denied',
  'internal_error',
] as const;

export type AgentServiceErrorCode = (typeof agentServiceErrorCodes)[number];

export interface AgentServiceErrorDetails {
  agentId?: string;
  state?: AgentState;
  process?: ProcessIdentity;
}

export class AgentServiceError extends Error {
  constructor(
    readonly code: AgentServiceErrorCode,
    message: string,
    readonly details?: AgentServiceErrorDetails,
  ) {
    super(message);
    this.name = 'AgentServiceError';
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export interface SpawnAgentInput {
  task: string;
  cwd?: string;
  permissionProfile?: PermissionProfile;
  model?: string;
  effort?: string;
  name?: string;
}

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

export interface AgentReadPage {
  agent: AgentSummary;
  turns: Turn[];
  events: Event[];
  cursor: string;
  hasMore: boolean;
  rawEvents?: ClaudeEvent[];
  rawCursor?: string;
}

export interface AgentServiceApi {
  spawnAgent(input: SpawnAgentInput): Promise<{
    agentId: string;
    sessionId: string;
    turnId: string;
    state: AgentState;
    cursor: string;
  }>;
  sendMessage(agentId: string, message: string): Promise<{
    messageId: string;
    queuedOnly: boolean;
    mailboxDepth: number;
    cursor: string;
  }>;
  followupTask(agentId: string, message: string): Promise<{
    messageId: string;
    state: AgentState;
    cursor: string;
  }>;
  waitAgent(agentIds: readonly string[], afterCursor: string, timeoutMs: number): Promise<WaitResult>;
  interruptAgent(agentId: string): Promise<{
    state: AgentState;
    interrupted: boolean;
    cursor: string;
  }>;
  listAgents(): AgentSummary[];
  readAgent(
    agentId: string,
    afterCursor: string,
    limit: number,
    includeRaw: boolean,
    afterRawCursor?: string,
  ): AgentReadPage;
}

export type RuntimeProcessInspection = 'alive' | 'dead' | 'unknown';

export interface AgentServiceOptions {
  inspectRuntimeProcess?: (identity: ProcessIdentity) => RuntimeProcessInspection;
  pumpIntervalMs?: number;
  stallTimeoutMs?: number;
  ownerHeartbeatStaleMs?: number;
  now?: () => Date;
  onDiagnostic?: (message: string) => void;
}

function powershellProcessInspection(identity: ProcessIdentity): RuntimeProcessInspection {
  if (process.platform !== 'win32') return 'unknown';
  const script = [
    '$candidate = Get-Process -Id ([int]$env:CLAUDE_MCP_INSPECT_PID) -ErrorAction SilentlyContinue',
    'if ($null -eq $candidate) { "dead"; exit 0 }',
    'try { "alive|" + $candidate.StartTime.ToUniversalTime().ToString("o") } catch { "unknown" }',
  ].join('; ');
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, CLAUDE_MCP_INSPECT_PID: String(identity.pid) },
    }).trim();
    if (output === 'dead') return 'dead';
    if (output === 'unknown') return 'unknown';
    if (!output.startsWith('alive|')) return 'unknown';
    const observed = new Date(output.slice('alive|'.length));
    const expected = new Date(identity.startedAt);
    if (Number.isNaN(observed.valueOf()) || Number.isNaN(expected.valueOf())) return 'unknown';
    return observed.toISOString() === expected.toISOString() ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function sanitizeAgentServiceError(
  error: unknown,
  details?: AgentServiceErrorDetails,
): AgentServiceError {
  if (error instanceof AgentServiceError) return error;
  if (error instanceof ClaudeResumeError) {
    return new AgentServiceError('resume_failed', 'Claude session could not be resumed.', details);
  }
  if (error instanceof RuntimeProcessContainmentError) {
    return new AgentServiceError('internal_error', 'The operation failed.', {
      ...details,
      process: error.identity,
    });
  }
  const code = systemErrorCode(error);
  if (code === 'ENOENT') {
    return new AgentServiceError('cli_unavailable', 'Claude Code CLI is unavailable.', details);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new AgentServiceError('permission_denied', 'The operation is not permitted.', details);
  }
  if (error instanceof Error
    && (error.message.includes('Claude executable') || error.message.includes('Claude Code 2.1.238'))) {
    return new AgentServiceError('cli_unavailable', 'Claude Code CLI is unavailable.', details);
  }
  return new AgentServiceError('internal_error', 'The operation failed.', details);
}

export class AgentService implements AgentServiceApi {
  readonly #inspectRuntimeProcess: (identity: ProcessIdentity) => RuntimeProcessInspection;
  readonly #onDiagnostic: (message: string) => void;
  readonly #stallTimeoutMs: number;
  readonly #ownerHeartbeatStaleMs: number;
  readonly #now: () => Date;
  readonly #pumpTimer: NodeJS.Timeout;
  #pump: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;

  constructor(
    private readonly store: AgentStore,
    private readonly scheduler: Scheduler,
    private readonly waiter: EventWaiter,
    options: AgentServiceOptions = {},
  ) {
    const pumpIntervalMs = options.pumpIntervalMs ?? 100;
    if (!Number.isSafeInteger(pumpIntervalMs) || pumpIntervalMs < 1) {
      throw new Error('service pump interval must be a positive integer');
    }
    const stallTimeoutMs = options.stallTimeoutMs ?? 300_000;
    if (!Number.isSafeInteger(stallTimeoutMs) || stallTimeoutMs < 1) {
      throw new Error('stall timeout must be a positive integer');
    }
    this.#stallTimeoutMs = stallTimeoutMs;
    const ownerHeartbeatStaleMs = options.ownerHeartbeatStaleMs ?? 30_000;
    if (!Number.isSafeInteger(ownerHeartbeatStaleMs) || ownerHeartbeatStaleMs < 1) {
      throw new Error('owner heartbeat stale interval must be a positive integer');
    }
    this.#ownerHeartbeatStaleMs = ownerHeartbeatStaleMs;
    this.#now = options.now ?? (() => new Date());
    this.#inspectRuntimeProcess = options.inspectRuntimeProcess ?? powershellProcessInspection;
    this.#onDiagnostic = options.onDiagnostic ?? ((message) => console.error(message));
    this.store.registerServerInstance(this.scheduler.serverId, this.#now().toISOString());
    this.reconcileStartupOwnership();
    this.#pumpTimer = setInterval(() => this.schedulePump(), pumpIntervalMs);
    this.#pumpTimer.unref();
  }

  async spawnAgent(input: SpawnAgentInput): Promise<{
    agentId: string;
    sessionId: string;
    turnId: string;
    state: AgentState;
    cursor: string;
  }> {
    let identity: { agentId: string; turnId: string } | undefined;
    try {
      const created = this.store.createAgentWithInitialTask(input as CreateAgentInput);
      identity = { agentId: created.agent.id, turnId: created.turn.id };
      this.scheduler.enqueue(created.agent.id);
      await this.scheduler.drain();
      const current = this.store.getAgent(created.agent.id) ?? created.agent;
      return {
        agentId: created.agent.id,
        sessionId: created.agent.sessionId,
        turnId: created.turn.id,
        state: current.state,
        cursor: this.store.latestCursor(),
      };
    } catch (error) {
      const agent = identity ? this.store.getAgent(identity.agentId) : undefined;
      throw sanitizeAgentServiceError(error, agent ? { agentId: agent.id, state: agent.state } : undefined);
    }
  }

  async sendMessage(agentId: string, message: string): Promise<{
    messageId: string;
    queuedOnly: boolean;
    mailboxDepth: number;
    cursor: string;
  }> {
    const agent = this.requireAgent(agentId);
    this.assertAcceptsMail(agent.state);
    try {
      const enqueued = this.store.enqueueMessage(agentId, 'message', message, mailAcceptingStates);
      this.scheduler.enqueue(agentId);
      await this.scheduler.drain();
      const receipt = this.store.mailboxReceipt(agentId, enqueued.message.id);
      return {
        messageId: enqueued.message.id,
        queuedOnly: receipt.queuedOnly,
        mailboxDepth: receipt.mailboxDepth,
        cursor: this.store.latestCursor(),
      };
    } catch (error) {
      if (error instanceof AgentMailStateError) {
        throw new AgentServiceError('invalid_state', 'Agent state does not allow this operation.', {
          agentId,
          state: error.state,
        });
      }
      const current = this.store.getAgent(agentId);
      throw sanitizeAgentServiceError(error, current ? { agentId, state: current.state } : { agentId });
    }
  }

  async followupTask(agentId: string, message: string): Promise<{
    messageId: string;
    state: AgentState;
    cursor: string;
  }> {
    const agent = this.requireAgent(agentId);
    this.assertAcceptsMail(agent.state);
    try {
      const enqueued = this.store.enqueueMessage(agentId, 'followup', message, mailAcceptingStates);
      this.scheduler.enqueue(agentId);
      await this.scheduler.drain();
      const current = this.requireAgent(agentId);
      return {
        messageId: enqueued.message.id,
        state: current.state,
        cursor: this.store.latestCursor(),
      };
    } catch (error) {
      if (error instanceof AgentMailStateError) {
        throw new AgentServiceError('invalid_state', 'Agent state does not allow this operation.', {
          agentId,
          state: error.state,
        });
      }
      const current = this.store.getAgent(agentId);
      throw sanitizeAgentServiceError(error, current ? { agentId, state: current.state } : { agentId });
    }
  }

  async waitAgent(
    agentIds: readonly string[],
    afterCursor: string,
    timeoutMs: number,
  ): Promise<WaitResult> {
    for (const agentId of agentIds) this.requireAgent(agentId);
    this.assertCursor(afterCursor);
    try {
      return await this.waiter.wait(agentIds, afterCursor, timeoutMs);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('event cursor')) {
        throw new AgentServiceError(
          'cursor_expired',
          'Event cursor is invalid or no longer available.',
        );
      }
      throw sanitizeAgentServiceError(error);
    }
  }

  async interruptAgent(agentId: string): Promise<{
    state: AgentState;
    interrupted: boolean;
    cursor: string;
  }> {
    this.requireAgent(agentId);
    try {
      const requested = this.store.requestInterrupt(agentId);
      if (!requested) {
        throw new AgentServiceError('invalid_state', 'Agent state does not allow this operation.', {
          agentId,
          state: this.requireAgent(agentId).state,
        });
      }
      await this.scheduler.drain();
      const current = this.requireAgent(agentId);
      const interrupted = requested.interrupted
        || this.store.listTurns(agentId).at(-1)?.status === 'interrupted';
      return {
        state: current.state,
        interrupted,
        cursor: this.store.latestCursor(),
      };
    } catch (error) {
      if (error instanceof AgentServiceError) throw error;
      const current = this.store.getAgent(agentId);
      throw sanitizeAgentServiceError(error, current ? { agentId, state: current.state } : { agentId });
    }
  }

  listAgents(): AgentSummary[] {
    return this.store.listAgents().map((agent) => this.summary(agent.id));
  }

  readAgent(
    agentId: string,
    afterCursor: string,
    limit: number,
    includeRaw: boolean,
    afterRawCursor = '0',
  ): AgentReadPage {
    this.requireAgent(agentId);
    this.assertCursor(afterCursor);
    if (!/^(0|[1-9]\d*)$/.test(afterRawCursor)) {
      throw new AgentServiceError('cursor_expired', 'Event cursor is invalid or no longer available.');
    }
    if (BigInt(afterRawCursor) > BigInt(this.store.latestClaudeCursor(agentId))) {
      throw new AgentServiceError('cursor_expired', 'Event cursor is invalid or no longer available.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new AgentServiceError('invalid_state', 'Read limit must be a positive integer.');
    }
    try {
      const page = this.store.readEvents({ agentIds: [agentId], after: afterCursor, limit: limit + 1 });
      const events = page.slice(0, limit);
      const rawEvents = includeRaw
        ? this.store.readClaudeEvents(agentId, afterRawCursor, limit)
        : undefined;
      return {
        agent: this.summary(agentId),
        turns: this.store.listTurns(agentId),
        events,
        cursor: events.at(-1)?.sequence ?? afterCursor,
        hasMore: page.length > limit,
        ...(rawEvents
          ? { rawEvents, rawCursor: rawEvents.at(-1)?.sequence ?? afterRawCursor }
          : {}),
      };
    } catch (error) {
      if (error instanceof AgentServiceError) throw error;
      throw sanitizeAgentServiceError(error, { agentId, state: this.requireAgent(agentId).state });
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearInterval(this.#pumpTimer);
    this.#closing = (async () => {
      await this.#pump;
      try {
        await this.scheduler.close();
      } finally {
        this.store.unregisterServerInstance(this.scheduler.serverId);
      }
    })();
    return this.#closing;
  }

  private requireAgent(agentId: string) {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new AgentServiceError('agent_not_found', 'Agent was not found.');
    return agent;
  }

  private assertAcceptsMail(state: AgentState): void {
    if (state === 'closed' || state === 'cancelling' || state === 'needs_attention') {
      throw new AgentServiceError('invalid_state', 'Agent state does not allow this operation.', { state });
    }
  }

  private assertCursor(cursor: string): void {
    if (!/^(0|[1-9]\d*)$/.test(cursor)) {
      throw new AgentServiceError('cursor_expired', 'Event cursor is invalid or no longer available.');
    }
    if (BigInt(cursor) > BigInt(this.store.latestCursor())) {
      throw new AgentServiceError('cursor_expired', 'Event cursor is invalid or no longer available.');
    }
  }

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

  private reconcileStartupOwnership(): void {
    const staleBefore = new Date(
      this.#now().valueOf() - this.#ownerHeartbeatStaleMs,
    ).toISOString();
    for (const lease of this.store.listRuntimeLeases()) {
      if (lease.serverId === this.scheduler.serverId) continue;
      if (this.store.isServerInstanceFresh(lease.serverId, staleBefore)) continue;
      if (lease.pid === null || lease.processStartedAt === null) {
        this.store.markRuntimeNeedsAttentionIfOwnerStale(lease, staleBefore);
        continue;
      }
      const identity = { pid: lease.pid, startedAt: lease.processStartedAt };
      const inspection = lease.confirmedDeadAt === null
        ? this.#inspectRuntimeProcess(identity)
        : 'dead';
      if (inspection === 'dead') {
        this.store.reconcileDeadRuntime(lease.agentId, identity, {
          serverId: lease.serverId,
          staleBefore,
        });
      } else {
        this.store.markRuntimeNeedsAttentionIfOwnerStale(lease, staleBefore);
      }
    }
  }

  private schedulePump(): void {
    if (this.#closed) return;
    try {
      this.store.heartbeatServerInstance(this.scheduler.serverId, this.#now().toISOString());
    } catch (error) {
      const sanitized = sanitizeAgentServiceError(error);
      this.#onDiagnostic(`server heartbeat failed: ${sanitized.code}`);
    }
    if (this.#pump) return;
    this.checkStalls();
    this.#pump = this.scheduler.drain()
      .catch((error: unknown) => {
        const sanitized = sanitizeAgentServiceError(error);
        this.#onDiagnostic(`agent service pump failed: ${sanitized.code}`);
      })
      .finally(() => { this.#pump = undefined; });
  }

  private checkStalls(): void {
    try {
      this.store.detectStalledAgents(this.scheduler.serverId, this.#stallTimeoutMs);
    } catch (error) {
      const sanitized = sanitizeAgentServiceError(error);
      this.#onDiagnostic(`stall detection failed: ${sanitized.code}`);
    }
  }
}
