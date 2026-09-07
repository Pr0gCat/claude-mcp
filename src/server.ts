import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Readable, Writable } from 'node:stream';

import { sanitizeAgentServiceError, type AgentServiceApi } from './agent-service.js';
import { registerAgentTools } from './tools.js';

interface ClosableAgentService extends AgentServiceApi {
  close?: () => Promise<void> | void;
}

class AgentMcpServer extends McpServer {
  #serviceClosed = false;

  constructor(private readonly service: ClosableAgentService) {
    super({ name: 'claude-code-subagent-mcp', version: '0.1.0' });
  }

  override async close(): Promise<void> {
    let closeError: unknown;
    try {
      await super.close();
    } catch (error) {
      closeError = error;
    }
    if (!this.#serviceClosed) {
      this.#serviceClosed = true;
      await this.service.close?.();
    }
    if (closeError !== undefined) throw closeError;
  }
}

export function createServer(service: ClosableAgentService): McpServer {
  const server = new AgentMcpServer(service);
  registerAgentTools(server, service);
  return server;
}

export function createStdioTransport(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): StdioServerTransport {
  return new StdioServerTransport(input, output);
}

export function shutdownOnce(
  close: () => Promise<void>,
  onDiagnostic: (message: string) => void = (message) => console.error(message),
  onFailure: () => void = () => { process.exitCode = 1; },
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    closing = close().catch((error: unknown) => {
      const sanitized = sanitizeAgentServiceError(error);
      onDiagnostic(`Claude subagent MCP server shutdown failed: ${sanitized.code}`);
      onFailure();
    });
    return closing;
  };
}
