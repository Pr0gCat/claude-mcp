import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
});
