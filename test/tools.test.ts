import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentServiceError,
  type AgentReadPage,
  type AgentServiceApi,
  type AgentSummary,
} from '../src/agent-service.js';
import { createServer } from '../src/server.js';

const closers: Array<() => Promise<void>> = [];

const summary: AgentSummary = {
  id: 'agent-1',
  name: 'worker',
  state: 'idle',
  lastTurnStatus: 'succeeded',
  pendingMessageCount: 0,
  cwd: 'C:\\workspace',
  permissionProfile: 'read_only',
  lastActivityAt: null,
  stalled: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:01.000Z',
};

const readPage: AgentReadPage = {
  agent: summary,
  turns: [{
    id: 'turn-1',
    agentId: 'agent-1',
    number: 1,
    status: 'succeeded',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
  }],
  events: [],
  cursor: '8',
  hasMore: false,
};

function fakeService(overrides: Partial<AgentServiceApi> = {}): AgentServiceApi & { close: () => Promise<void> } {
  return {
    spawnAgent: vi.fn(async () => ({
      agentId: 'agent-1', sessionId: 'session-1', turnId: 'turn-1', state: 'running' as const, cursor: '2',
    })),
    sendMessage: vi.fn(async () => ({ messageId: 'message-1', queuedOnly: true, mailboxDepth: 2, cursor: '3' })),
    followupTask: vi.fn(async () => ({ messageId: 'message-2', state: 'running' as const, cursor: '4' })),
    waitAgent: vi.fn(async () => ({ events: [], cursor: '4', timedOut: true })),
    interruptAgent: vi.fn(async () => ({ state: 'cancelling' as const, interrupted: false, cursor: '5' })),
    listAgents: vi.fn(() => [summary]),
    readAgent: vi.fn(() => readPage),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function connectedClient(service: AgentServiceApi & { close?: () => Promise<void> }): Promise<Client> {
  const server = createServer(service);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

interface DirectToolResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent: Record<string, unknown>;
}

function direct(result: Awaited<ReturnType<Client['callTool']>>): DirectToolResult {
  if (!('structuredContent' in result)
    || typeof result.structuredContent !== 'object'
    || result.structuredContent === null
    || !('content' in result)
    || !Array.isArray(result.content)) {
    throw new Error('tool result had no structuredContent');
  }
  return result as DirectToolResult;
}

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  return direct(result).structuredContent;
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe('MCP tools', () => {
  it('returns the final reply/error without requiring raw diagnostic history', async () => {
    const payload = { type: 'result', subtype: 'success', is_error: true, result: 'API Error: Connection dropped (ECONNRESET)' };
    const client = await connectedClient(fakeService({ readAgent: vi.fn(() => ({
      ...readPage,
      latestResult: { sequence: '9', agentId: 'agent-1', turnId: 'turn-1', type: 'result', payload, raw: JSON.stringify(payload), createdAt: summary.updatedAt },
    })) }));
    const response = await client.callTool({ name: 'read_agent', arguments: { agent_id: 'agent-1' } });
    expect(response.isError).not.toBe(true);
    expect(structured(response).latest_result).toMatchObject({ turn_id: 'turn-1', payload });
    expect(structured(response).raw_events).toBeUndefined();
  });

  it('registers exactly the eight public snake_case schemas', async () => {
    const client = await connectedClient(fakeService());

    const listed = await client.listTools();

    expect(listed.tools.map(({ name }) => name)).toEqual([
      'spawn_agent',
      'send_message',
      'followup_task',
      'wait_agent',
      'interrupt_agent',
      'list_agents',
      'list_models',
      'read_agent',
    ]);
    const properties = Object.fromEntries(listed.tools.map((tool) => [
      tool.name,
      Object.keys(tool.inputSchema.properties ?? {}),
    ]));
    expect(properties).toEqual({
      spawn_agent: ['task', 'cwd', 'permission_profile', 'model', 'effort', 'name'],
      send_message: ['agent_id', 'message'],
      followup_task: ['agent_id', 'message'],
      wait_agent: ['agent_ids', 'after_cursor', 'timeout_ms'],
      interrupt_agent: ['agent_id'],
      list_agents: [],
      list_models: [],
      read_agent: ['agent_id', 'after_cursor', 'limit', 'include_raw', 'after_raw_cursor'],
    });
    for (const tool of listed.tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
    expect(listed.tools.find(({ name }) => name === 'spawn_agent')?.inputSchema).toMatchObject({
      required: ['task'],
      properties: {
        task: { type: 'string', minLength: 1 },
        cwd: { type: 'string', description: expect.stringContaining('distinct Git worktree') },
        permission_profile: {
          type: 'string',
          default: 'read_only',
          description: expect.stringContaining('distinct Git worktree'),
        },
        model: { type: 'string', description: expect.stringContaining('sonnet') },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: expect.stringContaining('debugging/review'),
        },
      },
    });
    expect(listed.tools.find(({ name }) => name === 'spawn_agent')?.description)
      .toContain('Concurrent workspace_write agents require distinct Git worktree');
    expect(listed.tools.find(({ name }) => name === 'wait_agent')?.inputSchema).toMatchObject({
      required: ['agent_ids'],
      properties: {
        agent_ids: { type: 'array', minItems: 1, maxItems: 8 },
        timeout_ms: { type: 'integer', minimum: 0, maximum: 600_000, default: 30_000 },
      },
    });
  });

  it('dispatches all eight tools and returns matching JSON text plus structured content', async () => {
    const service = fakeService();
    const client = await connectedClient(service);

    const calls = [
      await client.callTool({ name: 'spawn_agent', arguments: {
        task: 'task', cwd: 'C:\\workspace', permission_profile: 'read_only', model: 'sonnet', effort: 'high', name: 'worker',
      } }),
      await client.callTool({ name: 'send_message', arguments: { agent_id: 'agent-1', message: 'context' } }),
      await client.callTool({ name: 'followup_task', arguments: { agent_id: 'agent-1', message: 'continue' } }),
      await client.callTool({ name: 'wait_agent', arguments: { agent_ids: ['agent-1'] } }),
      await client.callTool({ name: 'interrupt_agent', arguments: { agent_id: 'agent-1' } }),
      await client.callTool({ name: 'list_agents', arguments: {} }),
      await client.callTool({ name: 'list_models', arguments: {} }),
      await client.callTool({ name: 'read_agent', arguments: { agent_id: 'agent-1' } }),
    ];

    expect(service.spawnAgent).toHaveBeenCalledWith({
      task: 'task', cwd: 'C:\\workspace', permissionProfile: 'read_only', model: 'sonnet', effort: 'high', name: 'worker',
    });
    expect(service.waitAgent).toHaveBeenCalledWith(['agent-1'], '0', 30_000);
    expect(service.readAgent).toHaveBeenCalledWith('agent-1', '0', 100, false, '0');
    expect(structured(calls[0]!)).toEqual({
      agent_id: 'agent-1', session_id: 'session-1', turn_id: 'turn-1', state: 'running', cursor: '2',
    });
    expect(structured(calls[5]!)).toMatchObject({ agents: [{ agent_id: 'agent-1', last_turn_status: 'succeeded' }] });
    expect(structured(calls[6]!)).toMatchObject({
      models: [
        { id: 'default', spawn_value: null },
        { id: 'fable', spawn_value: 'fable' },
        { id: 'sonnet', spawn_value: 'sonnet' },
        { id: 'opus', spawn_value: 'opus' },
      ],
      accepts_full_model_id: true,
    });
    expect(structured(calls[7]!)).toMatchObject({
      agent: { agent_id: 'agent-1' },
      turns: [{ turn_id: 'turn-1', agent_id: 'agent-1' }],
    });
    for (const result of calls) {
      const text = direct(result).content.find((item) => item.type === 'text');
      expect(text?.type === 'text' && text.text !== undefined ? JSON.parse(text.text) : undefined)
        .toEqual(structured(result));
    }
  });

  it('exposes and applies read_only as the default spawn permission profile', async () => {
    const service = fakeService();
    const client = await connectedClient(service);

    const listed = await client.listTools();
    const spawn = listed.tools.find(({ name }) => name === 'spawn_agent');
    expect(spawn?.inputSchema.properties?.permission_profile).toMatchObject({
      default: 'read_only',
    });

    await client.callTool({ name: 'spawn_agent', arguments: { task: 'inspect safely' } });

    expect(service.spawnAgent).toHaveBeenLastCalledWith({
      task: 'inspect safely',
      permissionProfile: 'read_only',
    });
  });

  it('passes the raw cursor through read_agent and returns raw_cursor', async () => {
    const service = fakeService({
      readAgent: vi.fn(() => ({
        ...readPage,
        rawEvents: [{
          sequence: '9',
          agentId: 'agent-1',
          turnId: 'turn-1',
          type: 'stream',
          payload: { frame: 'nine' },
          raw: '{"frame":"nine"}',
          createdAt: '2026-09-01T00:00:02.000Z',
        }],
        rawCursor: '9',
      })),
    });
    const client = await connectedClient(service);

    const result = await client.callTool({
      name: 'read_agent',
      arguments: { agent_id: 'agent-1', include_raw: true, after_raw_cursor: '7' },
    });

    expect(service.readAgent).toHaveBeenCalledWith('agent-1', '0', 100, true, '7');
    expect(structured(result)).toMatchObject({
      raw_cursor: '9',
      raw_events: [{ sequence: '9', turn_id: 'turn-1' }],
    });
  });

  it('returns stable machine-readable sanitized service errors', async () => {
    const secret = 'prompt=PRIVATE SECRET_TOKEN=never-print';
    const client = await connectedClient(fakeService({
      sendMessage: async () => {
        throw new AgentServiceError('agent_not_found', 'Agent was not found.');
      },
      followupTask: async () => { throw new Error(secret); },
    }));

    const missing = await client.callTool({
      name: 'send_message', arguments: { agent_id: 'missing', message: secret },
    });
    const internal = await client.callTool({
      name: 'followup_task', arguments: { agent_id: 'agent-1', message: secret },
    });

    expect(missing.isError).toBe(true);
    expect(structured(missing)).toEqual({
      error: { code: 'agent_not_found', message: 'Agent was not found.' },
    });
    expect(internal.isError).toBe(true);
    expect(structured(internal)).toEqual({
      error: { code: 'internal_error', message: 'The operation failed.' },
    });
    expect(JSON.stringify([missing, internal])).not.toContain('PRIVATE');
    expect(JSON.stringify([missing, internal])).not.toContain('never-print');
  });

  it.each([
    ['spawn_agent', {}, 'spawnAgent'],
    ['spawn_agent', { task: '   ' }, 'spawnAgent'],
    ['send_message', { agent_id: 42, message: 'context' }, 'sendMessage'],
    ['followup_task', { agent_id: 'agent-1', message: false }, 'followupTask'],
    ['wait_agent', { agent_ids: [] }, 'waitAgent'],
    ['wait_agent', { agent_ids: ['agent-1'], timeout_ms: -1 }, 'waitAgent'],
    ['interrupt_agent', { agent_id: ['agent-1'] }, 'interruptAgent'],
    ['list_agents', { unexpected: true }, 'listAgents'],
    ['read_agent', { agent_id: 'agent-1', limit: '100' }, 'readAgent'],
  ] as const)(
    'returns a stable invalid_input envelope for invalid %s arguments',
    async (name, args, serviceMethod) => {
      const service = fakeService();
      const client = await connectedClient(service);

      const result = await client.callTool({ name, arguments: args });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: { code: 'invalid_input', message: 'Invalid tool arguments.' },
      });
      expect(result.content).toEqual([{
        type: 'text',
        text: '{"error":{"code":"invalid_input","message":"Invalid tool arguments."}}',
      }]);
      expect(JSON.stringify(result)).not.toMatch(/Zod|validation|expected|received/i);
      expect(service[serviceMethod]).not.toHaveBeenCalled();
    },
  );
});
