#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { AgentService, sanitizeAgentServiceError } from './agent-service.js';
import { ClaudeRuntime } from './claude/runtime.js';
import { ensureEmptyMcpConfig, loadConfig } from './config.js';
import { EventWaiter } from './event-waiter.js';
import { Scheduler } from './scheduler.js';
import { createServer, createStdioTransport, shutdownOnce } from './server.js';
import { openStore } from './store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const emptyMcpConfig = ensureEmptyMcpConfig(config.stateDir);
  const store = openStore(join(config.stateDir, 'state.sqlite'));
  const serverId = randomUUID();
  let scheduler!: Scheduler;
  const runtime = new ClaudeRuntime(store, {
    serverId,
    emptyMcpConfig,
    ...(config.claudeExecutable !== undefined ? { executable: config.claudeExecutable } : {}),
    onTurnBoundary: (agentId) => scheduler.onTurnBoundary(agentId),
    onDiagnostic: (agentId) => console.error(`Claude runtime diagnostic for agent ${agentId}`),
    onProcessExit: (agentId) => console.error(`Claude runtime process exited for agent ${agentId}`),
  });
  scheduler = new Scheduler(store, runtime, { serverId, processLimit: config.processLimit });
  const service = new AgentService(store, scheduler, new EventWaiter(store), {
    stallTimeoutMs: config.stallTimeoutMs,
  });
  const server = createServer(service);
  const transport = createStdioTransport();
  const close = shutdownOnce(() => server.close().finally(() => store.close()));
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  process.stdin.once('end', () => { void close(); });
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const sanitized = sanitizeAgentServiceError(error);
  console.error(`Claude subagent MCP server failed: ${sanitized.code}`);
  process.exitCode = 1;
});
