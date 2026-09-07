import type { PermissionProfile } from '../domain.js';

export interface ClaudeArgumentOptions {
  sessionId: string;
  resume: boolean;
  emptyMcpConfig: string;
  model?: string | null;
  effort?: string | null;
}

const profileArguments: Record<PermissionProfile, readonly string[]> = {
  read_only: [
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Glob,Grep',
    '--allowedTools', 'Read,Glob,Grep',
    '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,Agent,mcp__*',
  ],
  workspace_write: [
    '--permission-mode', 'auto',
    '--tools', 'Read,Glob,Grep,Edit,Write,NotebookEdit,Bash',
    '--allowedTools', 'Read,Glob,Grep,Edit,Write,NotebookEdit,Bash',
    '--disallowedTools', 'Agent,mcp__*',
  ],
};

export function buildClaudeArgs(
  profile: PermissionProfile,
  options: ClaudeArgumentOptions,
): string[] {
  if (options.sessionId.trim() === '') throw new Error('Claude session ID must not be empty');
  if (options.emptyMcpConfig.trim() === '') throw new Error('empty MCP config path must not be empty');

  const args = [
    '-p',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--replay-user-messages',
    '--safe-mode',
    '--strict-mcp-config',
    '--mcp-config', options.emptyMcpConfig,
    ...profileArguments[profile],
  ];
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  args.push(options.resume ? '--resume' : '--session-id', options.sessionId);
  return args;
}
