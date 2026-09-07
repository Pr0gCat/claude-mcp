import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentServiceApi } from '../src/agent-service.js';
import { createServer, createStdioTransport, shutdownOnce } from '../src/server.js';

const closers: Array<() => Promise<void>> = [];

function inertService(close = vi.fn(async () => undefined)): AgentServiceApi & { close(): Promise<void> } {
  return {
    spawnAgent: async () => ({ agentId: 'a', sessionId: 's', turnId: 't', state: 'running', cursor: '1' }),
    sendMessage: async () => ({ messageId: 'm', queuedOnly: true, mailboxDepth: 1, cursor: '2' }),
    followupTask: async () => ({ messageId: 'f', state: 'running', cursor: '3' }),
    waitAgent: async () => ({ events: [], cursor: '3', timedOut: true }),
    interruptAgent: async () => ({ state: 'cancelling', interrupted: false, cursor: '4' }),
    listAgents: () => [],
    readAgent: () => ({ agent: {
      id: 'a', name: null, state: 'idle', lastTurnStatus: null, pendingMessageCount: 0,
      cwd: null, permissionProfile: 'workspace_write', lastActivityAt: null, stalled: false,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }, turns: [], events: [], cursor: '0', hasMore: false }),
    close,
  };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe('MCP server', () => {
  it('closes the service when the MCP server closes', async () => {
    const closeService = vi.fn(async () => undefined);
    const server = createServer(inertService(closeService));
    closers.push(() => server.close());

    await server.close();

    expect(closeService).toHaveBeenCalledTimes(1);
    closers.pop();
  });

  it('absorbs a rejected shutdown with sanitized diagnostics and a failure signal', async () => {
    const diagnostics: string[] = [];
    let failures = 0;
    const close = vi.fn(async () => {
      throw new Error('prompt=PRIVATE CLAUDE_API_KEY=LEAKED');
    });
    const shutdown = shutdownOnce(close, (message) => diagnostics.push(message), () => { failures += 1; });

    const first = shutdown();
    const second = shutdown();

    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(failures).toBe(1);
    expect(diagnostics.join('\n')).toContain('internal_error');
    expect(diagnostics.join('\n')).not.toContain('PRIVATE');
    expect(diagnostics.join('\n')).not.toContain('LEAKED');
  });

  it('creates a stdio transport over injected streams without touching process stdout', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let protocol = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => { protocol += chunk; });
    const stdout = vi.spyOn(process.stdout, 'write');
    const transport = createStdioTransport(input, output);
    closers.push(() => transport.close());
    await transport.start();

    await transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });

    expect(protocol).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('speaks clean MCP JSON-RPC over child-process STDIO and keeps diagnostics on stderr', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['node_modules/vite-node/vite-node.mjs', fixture],
      cwd: process.cwd(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
    let diagnostics = '';
    transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
    closers.push(async () => {
      await client.close();
      await transport.close();
    });

    await client.connect(transport);
    const listed = await client.listTools();
    const agents = await client.callTool({ name: 'list_agents', arguments: {} });
    const invalid = await client.callTool({
      name: 'wait_agent', arguments: { agent_ids: [], timeout_ms: -1 },
    });

    expect(listed.tools).toHaveLength(8);
    expect(agents.structuredContent).toEqual({ agents: [] });
    expect(invalid).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: 'invalid_input', message: 'Invalid tool arguments.' },
      },
    });
    await vi.waitFor(() => expect(diagnostics).toContain('fixture diagnostic on stderr'), { timeout: 1_000 });
  }, 15_000);
});
