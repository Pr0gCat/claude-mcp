import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeRunner } from '../src/claude/runner.js';
import { inspectMacProcessIdentity, macProcessStartedAt } from '../src/mac-process.js';

describe.runIf(process.platform === 'darwin')('macOS process lifecycle', () => {
  it('recognizes live, reused, invalid and exited identities with microsecond precision', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    const identity = { pid: child.pid!, startedAt: macProcessStartedAt(child.pid!) };
    try {
      expect(identity.startedAt).toMatch(/\.\d{6}Z$/);
      expect(inspectMacProcessIdentity(identity)).toBe('matching');
      const lastDigit = identity.startedAt.at(-2) === '0' ? '1' : '0';
      expect(inspectMacProcessIdentity({ ...identity, startedAt: identity.startedAt.slice(0, -2) + lastDigit + 'Z' })).toBe('reused');
      expect(inspectMacProcessIdentity({ ...identity, startedAt: 'unknown' })).toBe('unknown');
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    expect(inspectMacProcessIdentity(identity)).toBe('missing');
  });

  it('kills a stubborn process group including a descendant and confirms exit', async () => {
    let ready!: (pid: number) => void;
    const descendant = new Promise<number>((resolve) => { ready = resolve; });
    const code = `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      console.log(JSON.stringify({pid:child.pid}));
      process.stdin.resume();
      setInterval(()=>{},1000);
    `;
    const runner = await ClaudeRunner.spawn({
      executable: process.execPath, args: ['-e', code], cwd: process.cwd(),
      versionCheck: () => undefined,
      onJson: (value) => ready((value as {pid: number}).pid), onDiagnostic: () => undefined,
    });
    let descendantPid: number | undefined;
    try {
      descendantPid = await descendant;
      expect(inspectMacProcessIdentity(runner.identity)).toBe('matching');
      expect(await runner.interrupt(10)).toBe(true);
      expect(runner.exited).toBe(true);
      await expect.poll(() => {
        try { process.kill(descendantPid!, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      }).toBe(true);
    } finally {
      if (!runner.exited) await runner.interrupt(0);
      if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
    }
  }, 10_000);

  it('kills the Claude process group when its MCP parent disappears', async () => {
    const moduleUrl = pathToFileURL(fileURLToPath(new URL('../dist/mac-process.js', import.meta.url))).href;
    const supervisorCode = `
      const {spawn}=require('node:child_process');
      (async()=>{
        const api=await import(${JSON.stringify(moduleUrl)});
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{
          detached:true,stdio:'ignore'
        });
        const identity={pid:child.pid,startedAt:api.macProcessStartedAt(child.pid)};
        await api.startMacProcessWatchdog(identity);
        console.log(JSON.stringify(identity));
        setInterval(()=>{},1000);
      })().catch(error=>{console.error(error);process.exit(1)});
    `;
    const supervisor = spawn(process.execPath, ['-e', supervisorCode], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    supervisor.stdout.setEncoding('utf8');
    const [line] = await once(supervisor.stdout, 'data') as [string];
    const identity = JSON.parse(line) as { pid: number; startedAt: string };
    try {
      expect(inspectMacProcessIdentity(identity)).toBe('matching');
      supervisor.kill('SIGKILL');
      await once(supervisor, 'exit');
      await expect.poll(() => inspectMacProcessIdentity(identity), { timeout: 5_000 })
        .toBe('missing');
    } finally {
      try { process.kill(-identity.pid, 'SIGKILL'); } catch {}
      try { supervisor.kill('SIGKILL'); } catch {}
    }
  }, 10_000);
});
