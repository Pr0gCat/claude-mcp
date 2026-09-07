import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventWaiter } from '../src/event-waiter.js';
import { AgentStore, openStore } from '../src/store.js';

const temporaryDirectories: string[] = [];
const stores: AgentStore[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mcp-waiter-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.sqlite');
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('EventWaiter', () => {
  it('never loses an event committed at the subscription boundary', async () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent } = store.createAgent({ task: 'Wait for mail' });
    const waiter = new EventWaiter(store);
    const after = store.latestCursor();

    const waiting = waiter.wait([agent.id], after, 250);
    store.enqueueMessage(agent.id, 'message', 'context');
    const result = await waiting;

    expect(result.timedOut).toBe(false);
    expect(result.events.map((event) => event.type)).toEqual(['message.enqueued']);
  });

  it('observes events committed by another store without a process-local notification', async () => {
    const path = temporaryDatabase();
    const waitingStore = openStore(path);
    const writingStore = openStore(path);
    stores.push(waitingStore, writingStore);
    const { agent } = writingStore.createAgent({ task: 'Cross-server wait' });
    const waiter = new EventWaiter(waitingStore, 10);
    const after = waitingStore.latestCursor();
    const startedAt = Date.now();
    const waiting = waiter.wait([agent.id], after, 1_000);

    writingStore.enqueueMessage(agent.id, 'message', 'from another server');
    const result = await waiting;

    expect(result.timedOut).toBe(false);
    expect(result.events.map((event) => event.type)).toEqual(['message.enqueued']);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('does not let a process-local notification failure change a committed write', () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent } = store.createAgent({ task: 'Durable notification boundary' });
    store.onEventCommitted(() => {
      throw new Error('listener failed');
    });

    expect(() => store.enqueueMessage(agent.id, 'message', 'still durable')).not.toThrow();
    expect(store.readEvents({ agentIds: [agent.id], after: '1', limit: 10 }))
      .toMatchObject([{ sequence: '2', type: 'message.enqueued' }]);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid timeout %s',
    async (timeoutMs) => {
      const store = openStore(temporaryDatabase());
      stores.push(store);
      const { agent } = store.createAgent({ task: 'Invalid timeout' });

      await expect(new EventWaiter(store).wait([agent.id], store.latestCursor(), timeoutMs))
        .rejects.toThrow('event wait timeout must be a non-negative integer');
    },
  );

  it('rejects a pre-aborted wait without creating timers', async () => {
    vi.useFakeTimers();
    try {
      const store = openStore(temporaryDatabase());
      stores.push(store);
      const { agent } = store.createAgent({ task: 'Pre-aborted wait' });
      const controller = new AbortController();
      controller.abort();

      await expect(new EventWaiter(store).wait(
        [agent.id], store.latestCursor(), 1_000, controller.signal,
      )).rejects.toMatchObject({ name: 'AbortError' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an immediate normal timeout for zero milliseconds', async () => {
    const store = openStore(temporaryDatabase());
    stores.push(store);
    const { agent } = store.createAgent({ task: 'Zero timeout' });
    const after = store.latestCursor();

    await expect(new EventWaiter(store).wait([agent.id], after, 0)).resolves.toEqual({
      cursor: after,
      events: [],
      timedOut: true,
    });
  });

  it('cleans up timeout and polling timers after an event settles the wait', async () => {
    vi.useFakeTimers();
    try {
      const store = openStore(temporaryDatabase());
      stores.push(store);
      const { agent } = store.createAgent({ task: 'Timer cleanup' });
      const waiting = new EventWaiter(store).wait([agent.id], store.latestCursor(), 1_000);
      expect(vi.getTimerCount()).toBe(2);

      store.enqueueMessage(agent.id, 'message', 'settle now');
      await expect(waiting).resolves.toMatchObject({ timedOut: false });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up its listener and timers when aborted after waiting starts', async () => {
    vi.useFakeTimers();
    try {
      const store = openStore(temporaryDatabase());
      stores.push(store);
      const { agent } = store.createAgent({ task: 'Abort cleanup' });
      const originalSubscribe = store.onEventCommitted.bind(store);
      const unsubscribe = vi.fn();
      vi.spyOn(store, 'onEventCommitted').mockImplementation((listener) => {
        const removeListener = originalSubscribe(listener);
        return () => {
          unsubscribe();
          removeListener();
        };
      });
      const controller = new AbortController();
      const waiting = new EventWaiter(store).wait(
        [agent.id], store.latestCursor(), 1_000, controller.signal,
      );
      expect(vi.getTimerCount()).toBe(2);

      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up its listener and timers after a non-zero timeout expires', async () => {
    vi.useFakeTimers();
    try {
      const store = openStore(temporaryDatabase());
      stores.push(store);
      const { agent } = store.createAgent({ task: 'Timeout cleanup' });
      const originalSubscribe = store.onEventCommitted.bind(store);
      const unsubscribe = vi.fn();
      vi.spyOn(store, 'onEventCommitted').mockImplementation((listener) => {
        const removeListener = originalSubscribe(listener);
        return () => {
          unsubscribe();
          removeListener();
        };
      });
      const after = store.latestCursor();
      const waiting = new EventWaiter(store).wait([agent.id], after, 75);
      expect(vi.getTimerCount()).toBe(2);

      await vi.advanceTimersByTimeAsync(75);
      await expect(waiting).resolves.toEqual({ cursor: after, events: [], timedOut: true });

      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
