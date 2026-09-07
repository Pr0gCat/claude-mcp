import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from '../../src/server.ts';

const service = {
  async spawnAgent() {
    return { agentId: 'a', sessionId: 's', turnId: 't', state: 'running', cursor: '1' };
  },
  async sendMessage() {
    return { messageId: 'm', queuedOnly: true, mailboxDepth: 1, cursor: '2' };
  },
  async followupTask() {
    return { messageId: 'f', state: 'running', cursor: '3' };
  },
  async waitAgent() {
    return { events: [], cursor: '3', timedOut: true };
  },
  async interruptAgent() {
    return { state: 'cancelling', interrupted: false, cursor: '4' };
  },
  listAgents() {
    return [];
  },
  readAgent() {
    throw new Error('not used by smoke');
  },
  async close() {},
};

const server = createServer(service);
await server.connect(new StdioServerTransport());
console.error('fixture diagnostic on stderr');
process.stdin.on('end', () => {
  void server.close().finally(() => process.exit(0));
});
