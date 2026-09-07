import { describe, expect, it } from 'vitest';

import { buildClaudeArgs } from '../src/claude/arguments.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const emptyMcpConfig = 'C:\\state\\empty-mcp.json';

describe('buildClaudeArgs', () => {
  it('limits read-only sessions to the three read tools with dontAsk', () => {
    expect(buildClaudeArgs('read_only', { sessionId, resume: false, emptyMcpConfig })).toEqual([
      '-p',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--replay-user-messages',
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config', emptyMcpConfig,
      '--permission-mode', 'dontAsk',
      '--tools', 'Read,Glob,Grep',
      '--allowedTools', 'Read,Glob,Grep',
      '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,Agent,mcp__*',
      '--session-id', sessionId,
    ]);
  });

  it('allows the bounded workspace-write tool set in auto mode', () => {
    expect(buildClaudeArgs('workspace_write', {
      sessionId,
      resume: false,
      emptyMcpConfig,
      model: 'sonnet',
      effort: 'high',
    })).toEqual([
      '-p',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--replay-user-messages',
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config', emptyMcpConfig,
      '--permission-mode', 'auto',
      '--tools', 'Read,Glob,Grep,Edit,Write,NotebookEdit,Bash',
      '--allowedTools', 'Read,Glob,Grep,Edit,Write,NotebookEdit,Bash',
      '--disallowedTools', 'Agent,mcp__*',
      '--model', 'sonnet',
      '--effort', 'high',
      '--session-id', sessionId,
    ]);
  });

  it('uses resume instead of session-id when reconnecting', () => {
    const args = buildClaudeArgs('read_only', {
      sessionId,
      resume: true,
      emptyMcpConfig,
    });

    expect(args.slice(-2)).toEqual(['--resume', sessionId]);
    expect(args).not.toContain('--session-id');
  });
});
