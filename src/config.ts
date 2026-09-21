import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  stateDir: string;
  claudeExecutable?: string;
  stallTimeoutMs: number;
  processLimit: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const restrictDirectoryAclScript = `
$path = $env:CLAUDE_MCP_ACL_PATH
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$access = [System.Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $rights, $inheritance, $propagation, $access)))
Set-Acl -LiteralPath $path -AclObject $acl
`;

function positiveInteger(env: Environment, name: string, fallback: number): number {
  const override = env[name];
  if (override === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(override.trim()) || !Number.isSafeInteger(Number(override))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(override);
}

function applyCurrentUserOnlyAcl(directory: string): void {
  if (process.platform === 'darwin') {
    chmodSync(directory, 0o700);
    return;
  }
  if (process.platform !== 'win32') return;

  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(restrictDirectoryAclScript, 'utf16le').toString('base64'),
    ], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CLAUDE_MCP_ACL_PATH: directory },
    });
  } catch {
    // ACL hardening is best effort because local Windows policy can forbid it.
  }
}

export function loadConfig(env: Environment = process.env, startupCwd = process.cwd()): Config {
  const override = env.CLAUDE_MCP_STATE_DIR;
  if (override !== undefined && override.trim() === '') {
    throw new Error('CLAUDE_MCP_STATE_DIR must not be empty');
  }
  const claudeExecutable = env.CLAUDE_MCP_CLAUDE_EXECUTABLE;
  if (claudeExecutable !== undefined && claudeExecutable.trim() === '') {
    throw new Error('CLAUDE_MCP_CLAUDE_EXECUTABLE must not be empty');
  }

  const stallTimeoutMs = positiveInteger(env, 'CLAUDE_MCP_STALL_TIMEOUT_MS', 300_000);
  const processLimit = positiveInteger(env, 'CLAUDE_MCP_PROCESS_LIMIT', 4);

  const stateDir = resolve(startupCwd, override ?? join(env.USERPROFILE ?? homedir(), '.claude-mcp'));
  mkdirSync(stateDir, { recursive: true });
  applyCurrentUserOnlyAcl(stateDir);
  return {
    stateDir,
    ...(claudeExecutable !== undefined ? { claudeExecutable } : {}),
    stallTimeoutMs,
    processLimit,
  };
}

export function ensureEmptyMcpConfig(stateDir: string): string {
  const path = resolve(stateDir, 'empty-mcp.json');
  writeFileSync(path, '{"mcpServers":{}}\n', 'utf8');
  return path;
}
