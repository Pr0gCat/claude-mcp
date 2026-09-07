import { execFile, execFileSync, spawn as spawnChildProcess } from 'node:child_process';
import { accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as nodePty from 'node-pty';

import { JsonLineDecoder } from './protocol.js';

const execFileAsync = promisify(execFile);
const minimumClaudeVersion = [2, 1, 238] as const;
const defaultKillConfirmationMs = 5_000;

export interface StreamUserFrame {
  type: 'user';
  parent_tool_use_id: null;
  message: { role: 'user'; content: Array<{ type: 'text'; text: string }> };
  shouldQuery?: false;
}

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

export interface ClaudePty {
  readonly pid: number;
  readonly inputTerminator?: string;
  write(data: string): void;
  interruptInput?(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onDiagnosticData?(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export type KillTree = (executable: string, args: readonly string[]) => Promise<void>;
export type ProcessIdentityInspection = 'matching' | 'missing' | 'reused' | 'unknown';
export type InspectProcessIdentity = (identity: ProcessIdentity) => ProcessIdentityInspection;

export interface ClaudeRunnerOptions {
  startedAt: string;
  onJson(value: unknown, raw: string): void;
  onDiagnostic(text: string): void;
  onExit?(event: { exitCode: number; signal?: number }): void;
  killTree?: KillTree;
  inspectProcessIdentity?: InspectProcessIdentity;
  killConfirmationMs?: number;
  maxDiagnosticChars?: number;
}

export interface SpawnClaudeRunnerOptions extends Omit<ClaudeRunnerOptions, 'startedAt' | 'killTree'> {
  executable?: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  versionCheck?: (executable: string) => void;
  processStartedAt?: (pid: number) => string;
  killTree?: KillTree;
  initializationCleanupGraceMs?: number;
  usePty?: boolean;
}

type PtyEvent =
  | { kind: 'data'; data: string }
  | { kind: 'diagnostic'; data: string }
  | { kind: 'exit'; event: { exitCode: number; signal?: number } };

class BufferedClaudePty implements ClaudePty {
  readonly pid: number;
  readonly inputTerminator?: string;
  readonly #events: PtyEvent[] = [];
  #dataListener: ((data: string) => void) | undefined;
  #diagnosticListener: ((data: string) => void) | undefined;
  #exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  constructor(private readonly child: ClaudePty) {
    this.pid = child.pid;
    this.inputTerminator = child.inputTerminator;
  }

  attach(): void {
    this.child.onExit((event) => {
      if (this.#dataListener && this.#exitListener) this.#exitListener(event);
      else this.#events.push({ kind: 'exit', event });
    });
    this.child.onData((data) => {
      if (this.#dataListener && this.#exitListener) this.#dataListener(data);
      else this.#events.push({ kind: 'data', data });
    });
    this.child.onDiagnosticData?.((data) => {
      if (this.#dataListener && this.#exitListener && this.#diagnosticListener) {
        this.#diagnosticListener(data);
      } else {
        this.#events.push({ kind: 'diagnostic', data });
      }
    });
  }

  write(data: string): void {
    this.child.write(data);
  }

  interruptInput(): void {
    if (this.child.interruptInput) this.child.interruptInput();
    else this.child.write('\u0003');
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListener = listener;
    this.flush();
    return { dispose: () => { if (this.#dataListener === listener) this.#dataListener = undefined; } };
  }

  onDiagnosticData(listener: (data: string) => void): { dispose(): void } {
    this.#diagnosticListener = listener;
    this.flush();
    return { dispose: () => {
      if (this.#diagnosticListener === listener) this.#diagnosticListener = undefined;
    } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListener = listener;
    this.flush();
    return { dispose: () => { if (this.#exitListener === listener) this.#exitListener = undefined; } };
  }

  private flush(): void {
    if (!this.#dataListener || !this.#exitListener) return;
    for (const event of this.#events.splice(0)) {
      if (event.kind === 'data') this.#dataListener(event.data);
      else if (event.kind === 'diagnostic') this.#diagnosticListener?.(event.data);
      else this.#exitListener(event.event);
    }
  }
}

function spawnPipeProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ClaudePty {
  const child = spawnChildProcess(executable, [...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pendingDiagnostics: string[] = [];
  let diagnosticListener: ((data: string) => void) | undefined;
  const reportDiagnostic = (data: string | Error): void => {
    const text = data instanceof Error ? data.message : data;
    if (diagnosticListener) diagnosticListener(text);
    else pendingDiagnostics.push(text);
  };
  child.on('error', reportDiagnostic);
  child.stdin.on('error', reportDiagnostic);
  if (child.pid === undefined) throw new Error('Claude process did not expose a PID');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return {
    pid: child.pid,
    inputTerminator: '\n',
    write: (data) => {
      if (child.stdin.writableEnded || child.stdin.destroyed) throw new Error('Claude input is closed');
      child.stdin.write(data, 'utf8');
    },
    interruptInput: () => { child.stdin.end(); },
    onData: (listener) => {
      const receive = (data: string) => listener(data);
      child.stdout.on('data', receive);
      return { dispose: () => child.stdout.off('data', receive) };
    },
    onDiagnosticData: (listener) => {
      diagnosticListener = listener;
      for (const diagnostic of pendingDiagnostics.splice(0)) listener(diagnostic);
      child.stderr.on('data', reportDiagnostic);
      return { dispose: () => {
        child.stderr.off('data', reportDiagnostic);
        if (diagnosticListener === listener) diagnosticListener = undefined;
      } };
    },
    onExit: (listener) => {
      const exit = (code: number | null) => listener({ exitCode: code ?? 1 });
      child.on('close', exit);
      return { dispose: () => child.off('close', exit) };
    },
  };
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

export function assertSupportedClaudeVersion(output: string): void {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output);
  if (!match) throw new Error('Claude executable returned an unrecognized version');
  const version = match.slice(1).map(Number);
  if (compareVersion(version, minimumClaudeVersion) < 0) {
    throw new Error('Claude Code 2.1.238 or newer is required');
  }
}

export function resolveClaudeExecutable(
  configuredPath = join(homedir(), '.local', 'bin', 'claude.exe'),
): string {
  return inspectClaudeExecutable(configuredPath).path;
}

export interface ClaudeExecutableIdentity {
  path: string;
  version: string;
}

export function inspectClaudeExecutable(
  configuredPath = join(homedir(), '.local', 'bin', 'claude.exe'),
): ClaudeExecutableIdentity {
  const executable = isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);
  accessSync(executable);
  // shell:true so npm-installed .cmd/.bat launcher shims resolve on Windows; the
  // executable is quoted because shell:true does not quote the command itself.
  const output = execFileSync(`"${executable}"`, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: true,
  });
  assertSupportedClaudeVersion(output);
  const version = /(\d+\.\d+\.\d+)/.exec(output)?.[1];
  if (!version) throw new Error('Claude executable returned an unrecognized version');
  return { path: executable, version };
}

export class ClaudeSpawnCleanupError extends Error {
  readonly pid: number;

  constructor(pid: number, cause: unknown) {
    super('Claude initialization failed and process exit could not be confirmed', { cause });
    this.name = 'ClaudeSpawnCleanupError';
    this.pid = pid;
  }
}

function windowsProcessStartedAt(pid: number): string {
  if (process.platform !== 'win32') return new Date().toISOString();
  const script = [
    '$process = Get-Process -Id ([int]$env:CLAUDE_MCP_PROCESS_PID) -ErrorAction Stop',
    '$process.StartTime.ToUniversalTime().ToString("o")',
  ].join('; ');
  const output = execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CLAUDE_MCP_PROCESS_PID: String(pid) },
  }).trim();
  const startedAt = new Date(output);
  if (Number.isNaN(startedAt.valueOf())) throw new Error('could not read Claude process creation time');
  return startedAt.toISOString();
}

function inspectWindowsProcessIdentity(identity: ProcessIdentity): ProcessIdentityInspection {
  if (process.platform !== 'win32') return 'unknown';
  const script = [
    '$candidate = Get-Process -Id ([int]$env:CLAUDE_MCP_INSPECT_PID) -ErrorAction SilentlyContinue',
    'if ($null -eq $candidate) { "missing"; exit 0 }',
    'try { "alive|" + $candidate.StartTime.ToUniversalTime().ToString("o") } catch { "unknown" }',
  ].join('; ');
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, CLAUDE_MCP_INSPECT_PID: String(identity.pid) },
    }).trim();
    if (output === 'missing') return 'missing';
    if (output === 'unknown' || !output.startsWith('alive|')) return 'unknown';
    const observed = new Date(output.slice('alive|'.length));
    const expected = new Date(identity.startedAt);
    if (Number.isNaN(observed.valueOf()) || Number.isNaN(expected.valueOf())) return 'unknown';
    return observed.toISOString() === expected.toISOString() ? 'matching' : 'reused';
  } catch {
    return 'unknown';
  }
}

async function taskkill(executable: string, args: readonly string[]): Promise<void> {
  await execFileAsync(executable, [...args], { windowsHide: true });
}

export class ClaudeRunner {
  readonly identity: ProcessIdentity;
  readonly #pty: ClaudePty;
  readonly #killTree: KillTree;
  readonly #inspectProcessIdentity: InspectProcessIdentity;
  readonly #killConfirmationMs: number;
  #exited = false;
  readonly #exitPromise: Promise<void>;
  #resolveExit!: () => void;
  #interrupting: Promise<boolean> | undefined;

  constructor(pty: ClaudePty, options: ClaudeRunnerOptions) {
    this.#pty = pty;
    this.#killTree = options.killTree ?? taskkill;
    this.#inspectProcessIdentity = options.inspectProcessIdentity ?? inspectWindowsProcessIdentity;
    this.#killConfirmationMs = options.killConfirmationMs ?? defaultKillConfirmationMs;
    assertNonNegativeInteger(this.#killConfirmationMs, 'kill confirmation window');
    this.identity = { pid: pty.pid, startedAt: options.startedAt };
    this.#exitPromise = new Promise((resolveExit) => { this.#resolveExit = resolveExit; });
    const decoder = new JsonLineDecoder({ maxDiagnosticChars: options.maxDiagnosticChars });
    pty.onDiagnosticData?.((chunk) => {
      const diagnostic = chunk.trim();
      if (diagnostic !== '') options.onDiagnostic(diagnostic.slice(-(options.maxDiagnosticChars ?? 4_096)));
    });
    pty.onData((chunk) => {
      for (const line of decoder.push(chunk)) {
        if (line.kind === 'json') options.onJson(line.value, line.raw);
        else options.onDiagnostic(line.text);
      }
    });
    pty.onExit((event) => {
      this.#exited = true;
      this.#resolveExit();
      options.onExit?.(event);
    });
  }

  static async spawn(options: SpawnClaudeRunnerOptions): Promise<ClaudeRunner> {
    const initializationCleanupGraceMs = options.initializationCleanupGraceMs ?? 250;
    const killConfirmationMs = options.killConfirmationMs ?? defaultKillConfirmationMs;
    assertNonNegativeInteger(initializationCleanupGraceMs, 'initialization cleanup grace');
    assertNonNegativeInteger(killConfirmationMs, 'kill confirmation window');
    const executable = options.executable
      ? (isAbsolute(options.executable) ? options.executable : resolve(options.executable))
      : join(homedir(), '.local', 'bin', 'claude.exe');
    (options.versionCheck ?? resolveClaudeExecutable)(executable);
    const usePty = options.usePty ?? (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable));
    const child = new BufferedClaudePty(usePty
      ? nodePty.spawn(executable, [...options.args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        useConpty: process.platform === 'win32',
      })
      : spawnPipeProcess(executable, options.args, options.cwd, options.env ?? process.env));
    let startedAt: string | undefined;
    try {
      child.attach();
      startedAt = (options.processStartedAt ?? windowsProcessStartedAt)(child.pid);
      return new ClaudeRunner(child, { ...options, startedAt });
    } catch (error) {
      const cleanup = new ClaudeRunner(child, {
        startedAt: startedAt ?? new Date().toISOString(),
        onJson: () => undefined,
        onDiagnostic: () => undefined,
        killTree: options.killTree,
        inspectProcessIdentity: startedAt === undefined
          ? () => 'unknown'
          : options.inspectProcessIdentity,
        killConfirmationMs,
      });
      const confirmed = await cleanup.interrupt(initializationCleanupGraceMs);
      if (!confirmed) {
        throw new ClaudeSpawnCleanupError(child.pid, error);
      }
      throw error;
    }
  }

  get exited(): boolean {
    return this.#exited;
  }

  sendUserMessage(text: string, shouldQuery: boolean): void {
    const frame: StreamUserFrame = {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
      ...(shouldQuery ? {} : { shouldQuery: false as const }),
    };
    this.#pty.write(`${JSON.stringify(frame)}${this.#pty.inputTerminator ?? (process.platform === 'win32' ? '\r' : '\n')}`);
  }

  interrupt(graceMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
      return Promise.reject(new Error('interrupt grace must be a non-negative integer'));
    }
    if (this.#interrupting) return this.#interrupting;
    let operation: Promise<boolean>;
    operation = this.interruptOnce(graceMs).finally(() => {
      if (this.#interrupting === operation) this.#interrupting = undefined;
    });
    this.#interrupting = operation;
    return operation;
  }

  private async interruptOnce(graceMs: number): Promise<boolean> {
    if (this.#exited) return true;
    let interruptSent = false;
    try {
      if (this.#pty.interruptInput) this.#pty.interruptInput();
      else this.#pty.write('\u0003');
      interruptSent = true;
    } catch {
      // A closed PTY input can still leave the child alive. Escalate immediately.
    }
    if (interruptSent) {
      const exitedDuringGrace = await Promise.race([
        this.#exitPromise.then(() => true),
        new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), graceMs)),
      ]);
      if (exitedDuringGrace) return true;
    }
    let inspection: ProcessIdentityInspection;
    try {
      inspection = this.#inspectProcessIdentity(this.identity);
    } catch {
      inspection = 'unknown';
    }
    if (inspection === 'missing' || inspection === 'reused') return true;
    if (inspection !== 'matching') return false;
    try {
      await this.#killTree('taskkill', ['/PID', String(this.identity.pid), '/T', '/F']);
    } catch {
      // taskkill is a best-effort fallback; process exit is authoritative.
    }
    return this.waitForExit(this.#killConfirmationMs);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exited) return Promise.resolve(true);
    return new Promise((resolveWait) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveWait(exited);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void this.#exitPromise.then(() => finish(true));
    });
  }
}
