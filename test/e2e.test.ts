import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distEntrypoint = join(repoRoot, 'dist', 'index.js');
const fakeClaudeExecutable = fileURLToPath(new URL('./fixtures/fake-claude-cli.cmd', import.meta.url));

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

interface WaitAgentEvent {
  type: string;
  sequence: string;
}

interface WaitAgentOutput {
  events: WaitAgentEvent[];
  cursor: string;
  timed_out: boolean;
}

// The scheduler releases turn-boundary ownership (killing the just-finished
// Claude process) asynchronously after a turn's result event is already
// visible, so callers must wait for the follow-on lifecycle event, not just
// the turn-completion event, before the agent can accept the next turn.
async function waitForEventType(
  client: Client,
  agentId: string,
  afterCursor: string,
  eventType: string,
  overallTimeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + overallTimeoutMs;
  let cursor = afterCursor;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`timed out waiting for a "${eventType}" event after cursor ${afterCursor}`);
    }
    const result = await client.callTool({
      name: 'wait_agent',
      arguments: { agent_ids: [agentId], after_cursor: cursor, timeout_ms: Math.min(remaining, 10_000) },
    });
    const output = result.structuredContent as WaitAgentOutput;
    if (output.events.some((event) => event.type === eventType)) return output.cursor;
    cursor = output.cursor;
  }
}

describe.runIf(process.platform === 'win32')('built STDIO MCP server (fake Claude CLI)', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [
      join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(repoRoot, 'tsconfig.build.json'),
    ], { cwd: repoRoot, stdio: 'inherit', timeout: 60_000 });
    expect(existsSync(distEntrypoint)).toBe(true);
  }, 90_000);

  afterAll(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it(
    'serves initialize, listTools, and a full agent lifecycle over real MCP JSON-RPC framing',
    async () => {
      const stateDir = temporaryDirectory('claude-mcp-e2e-state-');
      const workspaceDir = temporaryDirectory('claude-mcp-e2e-workspace-');

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [distEntrypoint],
        cwd: repoRoot,
        stderr: 'pipe',
        env: {
          ...getDefaultEnvironment(),
          CLAUDE_MCP_STATE_DIR: stateDir,
          CLAUDE_MCP_CLAUDE_EXECUTABLE: fakeClaudeExecutable,
          FAKE_CLAUDE_RESULT_DELAY_MS: '1500',
        },
      });
      // The SDK's ReadBuffer throws (routed to onerror) instead of crashing the
      // transport when a stdout line fails JSON-RPC parsing, so an empty
      // transportErrors array is the proof that stdout carried protocol frames only.
      const transportErrors: Error[] = [];
      transport.onerror = (error) => { transportErrors.push(error); };
      let stderrRaw = '';
      transport.stderr?.on('data', (chunk: Buffer) => { stderrRaw += chunk.toString('utf8'); });

      const client = new McpClient({ name: 'claude-mcp-e2e', version: '1.0.0' });
      let serverPid: number | null = null;
      try {
        await client.connect(transport);
        serverPid = transport.pid;

        expect(readFileSync(join(stateDir, 'empty-mcp.json'), 'utf8'))
          .toBe('{"mcpServers":{}}\n');

        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          'followup_task',
          'interrupt_agent',
          'list_agents',
          'list_models',
          'read_agent',
          'send_message',
          'spawn_agent',
          'wait_agent',
        ]);

        const spawned = await client.callTool({
          name: 'spawn_agent',
          arguments: {
            task: 'Say hello for the packaging end-to-end test.',
            cwd: workspaceDir,
            permission_profile: 'read_only',
          },
        });
        const spawnOutput = spawned.structuredContent as {
          agent_id: string;
          session_id: string;
          turn_id: string;
          state: string;
          cursor: string;
        };
        expect(spawnOutput.agent_id).toBeTruthy();
        expect(spawnOutput.session_id).toBeTruthy();

        const completedCursor = await waitForEventType(
          client,
          spawnOutput.agent_id,
          spawnOutput.cursor,
          'turn.completed',
          20_000,
        );
        // Wait for the scheduler to finish releasing turn-boundary ownership
        // (it kills the just-finished Claude process asynchronously) before
        // sending the next message, or the message would race a stale runtime.
        await waitForEventType(client, spawnOutput.agent_id, completedCursor, 'agent.idle', 20_000);

        const read = await client.callTool({
          name: 'read_agent',
          arguments: {
            agent_id: spawnOutput.agent_id,
            after_cursor: '0',
            limit: 100,
            include_raw: true,
            after_raw_cursor: '0',
          },
        });
        const readOutput = read.structuredContent as {
          turns: Array<{ status: string }>;
          raw_events: Array<{ type: string }>;
          raw_cursor: string;
        };
        expect(readOutput.turns).toMatchObject([{ status: 'succeeded' }]);
        expect(readOutput.raw_events.length).toBeGreaterThan(0);
        expect(readOutput.raw_cursor).toMatch(/^[1-9]\d*$/);

        const sent = await client.callTool({
          name: 'send_message',
          arguments: { agent_id: spawnOutput.agent_id, message: 'Extra context for the next turn.' },
        });
        const sentOutput = sent.structuredContent as { queued_only: boolean; mailbox_depth: number };
        expect(sentOutput.queued_only).toBe(true);
        expect(sentOutput.mailbox_depth).toBeGreaterThanOrEqual(1);

        const followup = await client.callTool({
          name: 'followup_task',
          arguments: { agent_id: spawnOutput.agent_id, message: 'Continue the task.' },
        });
        const followupOutput = followup.structuredContent as { state: string; cursor: string };
        expect(followupOutput.state).toBe('running');

        const interrupted = await client.callTool({
          name: 'interrupt_agent',
          arguments: { agent_id: spawnOutput.agent_id },
        });
        const interruptedOutput = interrupted.structuredContent as { state: string; interrupted: boolean };
        expect(interruptedOutput.interrupted).toBe(true);
        expect(interruptedOutput.state).toBe('idle');

        const listed2 = await client.callTool({ name: 'list_agents', arguments: {} });
        const listedOutput = listed2.structuredContent as {
          agents: Array<{ agent_id: string; last_turn_status: string }>;
        };
        const summary = listedOutput.agents.find((agent) => agent.agent_id === spawnOutput.agent_id);
        expect(summary?.last_turn_status).toBe('interrupted');
      } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
        // Best-effort hard backstop: the SDK transport only asks the server to
        // shut down gracefully (stdin end, then SIGTERM/SIGKILL of the server
        // process itself), which does not reliably cascade to the fake Claude
        // CLI's cmd.exe/node.exe descendants. Force the whole tree down so a
        // failed assertion above can never leak a PTY process out of this test.
        if (serverPid !== null) {
          try {
            execFileSync('taskkill', ['/PID', String(serverPid), '/T', '/F'], { stdio: 'ignore', timeout: 5_000 });
          } catch {
            // Already exited, or nothing to kill; either is fine here.
          }
        }
      }

      expect(transportErrors).toEqual([]);
      expect(stderrRaw).not.toContain('{"jsonrpc"');
    },
    60_000,
  );
});
