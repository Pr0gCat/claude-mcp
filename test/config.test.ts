import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildClaudeArgs } from '../src/claude/arguments.js';
import { ensureEmptyMcpConfig, loadConfig } from '../src/config.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mcp-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

function runPowerShell(script: string, environment: NodeJS.ProcessEnv): string {
  return execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-OutputFormat',
    'Text',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

const addExtraAllowRule = `
$acl = Get-Acl -LiteralPath $env:CLAUDE_MCP_TEST_ACL_PATH
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\\Users', 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:CLAUDE_MCP_TEST_ACL_PATH -AclObject $acl
`;

const readAllowRules = `
(Get-Acl -LiteralPath $env:CLAUDE_MCP_TEST_ACL_PATH).Access |
  Where-Object { $_.AccessControlType -eq 'Allow' } |
  ForEach-Object { "$($_.IdentityReference.Value)|$([int]$_.FileSystemRights)|$($_.IsInherited)" }
`;

const readCurrentIdentity = '[System.Security.Principal.WindowsIdentity]::GetCurrent().Name';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('loadConfig', () => {
  it('uses and creates an explicit state directory', () => {
    const parent = temporaryDirectory();
    const stateDir = join(parent, 'nested', 'state');

    const config = loadConfig({ CLAUDE_MCP_STATE_DIR: stateDir });

    expect(config.stateDir).toBe(stateDir);
    expect(existsSync(stateDir)).toBe(true);
  });

  it('uses USERPROFILE and the documented directory when no override is present', () => {
    const userProfile = temporaryDirectory();

    const config = loadConfig({ USERPROFILE: userProfile });

    expect(config.stateDir).toBe(join(userProfile, '.claude-mcp'));
    expect(existsSync(config.stateDir)).toBe(true);
  });

  it('anchors a relative state directory to the server startup cwd before an agent cwd can reinterpret it', () => {
    const serverCwd = temporaryDirectory();
    const agentCwd = temporaryDirectory();
    const workspaceConfig = join(agentCwd, 'relative-state', 'empty-mcp.json');
    mkdirSync(join(agentCwd, 'relative-state'));
    writeFileSync(workspaceConfig, 'workspace-controlled', 'utf8');

    const config = loadConfig({ CLAUDE_MCP_STATE_DIR: 'relative-state' }, serverCwd);
    const emptyMcpConfig = join(config.stateDir, 'empty-mcp.json');
    const args = buildClaudeArgs('read_only', {
      sessionId: '00000000-0000-4000-8000-000000000000',
      resume: false,
      emptyMcpConfig,
    });

    expect(isAbsolute(config.stateDir)).toBe(true);
    expect(config.stateDir).toBe(join(serverCwd, 'relative-state'));
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(emptyMcpConfig);
    expect(emptyMcpConfig).not.toBe(workspaceConfig);
  });

  it('writes a valid empty Claude MCP configuration', () => {
    const stateDir = temporaryDirectory();

    const path = ensureEmptyMcpConfig(stateDir);
    expect(isAbsolute(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{"mcpServers":{}}\n');
  });

  it('rejects an empty state directory override', () => {
    expect(() => loadConfig({ CLAUDE_MCP_STATE_DIR: '   ' }))
      .toThrow('CLAUDE_MCP_STATE_DIR must not be empty');
  });

  it('removes pre-existing explicit allow rules and keeps only the current user', () => {
    const stateDir = temporaryDirectory();
    const environment = { ...process.env, CLAUDE_MCP_TEST_ACL_PATH: stateDir };
    runPowerShell(addExtraAllowRule, environment);

    loadConfig({ CLAUDE_MCP_STATE_DIR: stateDir });

    const rules = runPowerShell(readAllowRules, environment)
      .split(/\r?\n/)
      .filter(Boolean);
    const currentIdentity = runPowerShell(readCurrentIdentity, environment).trim();
    expect(rules).toEqual([`${currentIdentity}|2032127|False`]);
  });

  it('defaults the stall timeout to 300000ms', () => {
    const config = loadConfig({ USERPROFILE: temporaryDirectory() });

    expect(config.stallTimeoutMs).toBe(300_000);
  });

  it('accepts a positive integer override for the stall timeout', () => {
    const config = loadConfig({ USERPROFILE: temporaryDirectory(), CLAUDE_MCP_STALL_TIMEOUT_MS: '60000' });

    expect(config.stallTimeoutMs).toBe(60_000);
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('rejects an invalid stall timeout override %s', (value) => {
    expect(() => loadConfig({ USERPROFILE: temporaryDirectory(), CLAUDE_MCP_STALL_TIMEOUT_MS: value }))
      .toThrow('CLAUDE_MCP_STALL_TIMEOUT_MS must be a positive integer');
  });
});
