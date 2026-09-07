import { randomUUID } from 'node:crypto';

import type { Agent, Message, ProcessIdentity, Turn } from './domain.js';
import type { AgentStore } from './store.js';
import { canonicalWorkspace } from './workspace.js';

export interface AgentRuntime {
  start(agent: Agent, turn: Turn, messages: readonly Message[]): Promise<void>;
  deliver(agent: Agent, message: Message, shouldQuery: boolean): Promise<void>;
  interrupt(agentId: string): Promise<RuntimeInterruptResult | void>;
}

export interface RuntimeInterruptResult {
  status: 'confirmed_dead';
  identity: ProcessIdentity;
}

export class RuntimeProcessContainmentError extends Error {
  constructor(
    message: string,
    readonly identity: ProcessIdentity,
    readonly ownershipContained: boolean,
    readonly confirmedDead: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'RuntimeProcessContainmentError';
  }
}

export interface SchedulerOptions {
  serverId?: string;
  processLimit?: number;
}

export class Scheduler {
  readonly #serverId: string;
  readonly #processLimit: number;
  #draining: Promise<void> | undefined;
  readonly #active = new Map<string, { agent: Agent; turn: Turn }>();
  readonly #pendingDeliveries = new Set<string>();
  #closed = false;

  constructor(
    private readonly store: AgentStore,
    private readonly runtime: AgentRuntime,
    options: SchedulerOptions = {},
  ) {
    this.#serverId = options.serverId ?? randomUUID();
    const requestedLimit = options.processLimit ?? 4;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new Error('process limit must be a positive integer');
    }
    this.#processLimit = Math.min(requestedLimit, 4);
  }

  get serverId(): string {
    return this.#serverId;
  }

  enqueue(agentId: string): void {
    if (this.#closed) throw new Error('scheduler is closed');
    if (this.#active.has(agentId)) {
      this.#pendingDeliveries.add(agentId);
      return;
    }
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error('agent not found');
    if (agent.state === 'running') return;
    const workspace = canonicalWorkspace(agent.cwd ?? process.cwd());
    const mode = agent.permissionProfile === 'read_only' ? 'reader' : 'writer';
    this.store.scheduleAgent(agentId, workspace, mode);
  }

  async drain(): Promise<void> {
    if (this.#closed) return;
    if (this.#draining) return this.#draining;
    this.#draining = this.drainAvailable();
    try {
      await this.#draining;
    } finally {
      this.#draining = undefined;
    }
  }

  async onTurnBoundary(agentId: string): Promise<void> {
    if (this.#active.has(agentId)) await this.runtime.interrupt(agentId);
    this.#active.delete(agentId);
    this.#pendingDeliveries.delete(agentId);
    this.store.releaseRuntimeAtBoundary(agentId, this.#serverId);
    await this.drain();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    for (const agentId of this.#active.keys()) {
      try {
        this.store.requestInterrupt(agentId);
      } catch {
        // Closing still attempts the runtime directly below when durable state cannot change.
      }
    }
    try {
      await this.drain();
    } catch {
      // A failed interrupt leaves durable attention state; close must still clear local handles.
    }
    // A concurrent drain may have passed its interrupt scan before close persisted the request.
    // Re-request after it settles, then give the owner path one final transactional drain.
    for (const agentId of this.#active.keys()) {
      try {
        this.store.requestInterrupt(agentId);
      } catch {
        // The direct best-effort pass below remains available for broken durable state.
      }
    }
    try {
      await this.drain();
    } catch {
      // Retained needs-attention ownership is safer than releasing an unconfirmed process.
    }
    for (const agentId of this.#active.keys()) {
      try {
        await this.runtime.interrupt(agentId);
      } catch {
        // Best-effort shutdown cannot erase retained ownership evidence.
      }
    }
    this.#active.clear();
    this.#pendingDeliveries.clear();
    this.#closed = true;
  }

  private async drainAvailable(): Promise<void> {
    await this.handleInterruptRequests();
    // `drain` is also an explicit SQLite mailbox pump for runtimes owned here.
    for (const agentId of this.#active.keys()) {
      if (this.store.getAgent(agentId)?.state === 'running') this.#pendingDeliveries.add(agentId);
    }
    while (true) {
      const deliveryAgentId = this.#pendingDeliveries.values().next().value as string | undefined;
      if (deliveryAgentId) {
        this.#pendingDeliveries.delete(deliveryAgentId);
        const active = this.#active.get(deliveryAgentId);
        if (active && this.store.getAgent(deliveryAgentId)?.state === 'running') {
          try {
            const messages = this.store.leasePendingMessages(
              active.agent.id,
              active.turn.id,
              this.#serverId,
            );
            for (const message of messages) {
              await this.runtime.deliver(active.agent, message, message.kind === 'followup');
            }
          } catch (error) {
            await this.recoverFailedRuntime(active, error);
            throw error;
          }
        }
        continue;
      }
      const claim = this.store.claimNextScheduled(this.#serverId, this.#processLimit);
      if (!claim) return;
      this.#active.set(claim.agent.id, { agent: claim.agent, turn: claim.turn });
      try {
        await this.runtime.start(claim.agent, claim.turn, claim.messages);
      } catch (error) {
        await this.recoverFailedRuntime(claim, error);
        throw error;
      }
    }
  }

  private async handleInterruptRequests(): Promise<void> {
    for (const request of this.store.listOwnedInterruptRequests(this.#serverId)) {
      const active = this.#active.get(request.agentId);
      if (!active || active.turn.id !== request.turnId) {
        this.store.markRuntimeNeedsAttention(request.agentId);
        this.store.acknowledgeOwnedInterruptNeedsAttention(request.agentId, this.#serverId);
        continue;
      }
      let interruption: RuntimeInterruptResult | void;
      try {
        interruption = await this.runtime.interrupt(request.agentId);
      } catch (error) {
        this.store.markRuntimeNeedsAttention(request.agentId);
        this.store.acknowledgeOwnedInterruptNeedsAttention(request.agentId, this.#serverId);
        if (error instanceof RuntimeProcessContainmentError) continue;
        throw error;
      }
      if (interruption?.status === 'confirmed_dead') {
        this.store.confirmRuntimeProcessDead(request.agentId, interruption.identity);
      }
      this.store.completeOwnedInterrupt(request.agentId, request.turnId, this.#serverId);
      this.#active.delete(request.agentId);
      this.#pendingDeliveries.delete(request.agentId);
    }
  }

  private async recoverFailedRuntime(
    active: { agent: Agent; turn: Turn },
    failure: unknown,
  ): Promise<void> {
    if (failure instanceof Error && failure.name === 'ClaudeResumeError') {
      this.#active.delete(active.agent.id);
      this.#pendingDeliveries.delete(active.agent.id);
      this.store.recoverRuntimeFailureNeedsAttention(
        active.agent.id,
        active.turn.id,
        this.#serverId,
        'resume_failed',
      );
      return;
    }
    let interruption: RuntimeInterruptResult | void;
    try {
      interruption = await this.runtime.interrupt(active.agent.id);
    } catch (interruptError) {
      this.#active.delete(active.agent.id);
      if (interruptError instanceof RuntimeProcessContainmentError) {
        if (!interruptError.ownershipContained) {
          const causes = [failure];
          if (interruptError.cause !== undefined) causes.push(interruptError.cause);
          throw new RuntimeProcessContainmentError(
            interruptError.message,
            interruptError.identity,
            false,
            interruptError.confirmedDead,
            new AggregateError(causes, 'runtime operation and process containment both failed'),
          );
        }
        return;
      }
      throw interruptError;
    }
    this.#active.delete(active.agent.id);

    const failedProcess = failure instanceof RuntimeProcessContainmentError ? failure : undefined;
    const confirmedIdentity = interruption?.status === 'confirmed_dead'
      ? interruption.identity
      : failedProcess?.confirmedDead && failedProcess.ownershipContained
        ? failedProcess.identity
        : undefined;
    if (confirmedIdentity) {
      this.store.confirmRuntimeProcessDead(active.agent.id, confirmedIdentity);
      if (!this.store.reconcileConfirmedDeadRuntime(active.agent.id, confirmedIdentity)) {
        this.store.markRuntimeNeedsAttention(active.agent.id);
      }
      return;
    }
    if (failedProcess) return;
    this.store.recoverRuntimeFailure(active.agent.id, active.turn.id, this.#serverId);
  }
}
