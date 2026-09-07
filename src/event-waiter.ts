import type { Event } from './domain.js';
import type { AgentStore } from './store.js';

export interface WaitResult {
  events: Event[];
  cursor: string;
  timedOut: boolean;
}

function abortError(): Error {
  const error = new Error('event wait aborted');
  error.name = 'AbortError';
  return error;
}

export class EventWaiter {
  constructor(
    private readonly store: AgentStore,
    private readonly pollIntervalMs = 25,
  ) {}

  async wait(
    agentIds: readonly string[],
    after: number | string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error('event wait timeout must be a non-negative integer');
    }
    if (signal?.aborted) throw abortError();

    const initial = this.store.readEvents({ agentIds, after, limit: 1000 });
    if (initial.length > 0) return this.result(initial, false, String(after));
    if (timeoutMs === 0) return this.result([], true, String(after));

    return await new Promise<WaitResult>((resolve, reject) => {
      let finished = false;
      let timeout: NodeJS.Timeout | undefined;
      let poll: NodeJS.Timeout | undefined;
      let unsubscribe = () => {};

      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        if (poll) clearInterval(poll);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (result: WaitResult): void => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };
      const check = (): void => {
        if (finished) return;
        try {
          const events = this.store.readEvents({ agentIds, after, limit: 1000 });
          if (events.length > 0) finish(this.result(events, false, String(after)));
        } catch (error) {
          fail(error);
        }
      };
      const onAbort = (): void => fail(abortError());

      unsubscribe = this.store.onEventCommitted(check);
      signal?.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => {
        check();
        if (!finished) finish(this.result([], true, String(after)));
      }, timeoutMs);
      poll = setInterval(check, Math.min(this.pollIntervalMs, timeoutMs));
      // Close the read/subscribe race: SQLite remains authoritative.
      check();
    });
  }

  private result(events: Event[], timedOut: boolean, after: string): WaitResult {
    return {
      events,
      cursor: events.at(-1)?.sequence ?? after,
      timedOut,
    };
  }
}
