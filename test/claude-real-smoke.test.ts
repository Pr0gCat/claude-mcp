import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildClaudeArgs } from '../src/claude/arguments.js';
import { ClaudeRunner } from '../src/claude/runner.js';

const runRealCli = process.env.CLAUDE_MCP_RUN_REAL_CLI_TESTS === '1';

interface ResultFrame {
  type: 'result';
  subtype: string;
  result?: string;
  num_turns?: number;
}

function resultQueue(): {
  onJson(value: unknown): void;
  next(timeoutMs?: number): Promise<ResultFrame>;
} {
  const buffered: ResultFrame[] = [];
  const waiting: Array<(frame: ResultFrame) => void> = [];
  return {
    onJson(value) {
      if (typeof value !== 'object' || value === null || (value as { type?: unknown }).type !== 'result') return;
      const frame = value as ResultFrame;
      const resolve = waiting.shift();
      if (resolve) resolve(frame);
      else buffered.push(frame);
    },
    next(timeoutMs = 30_000) {
      const available = buffered.shift();
      if (available) return Promise.resolve(available);
      return new Promise<ResultFrame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Claude result frame timed out')), timeoutMs);
        waiting.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
  };
}

describe.runIf(runRealCli)('real Claude CLI protocol smoke', () => {
  it('queries, acknowledges context, follows up, and resumes the durable session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-mcp-real-smoke-'));
    const emptyMcpConfig = join(directory, 'empty-mcp.json');
    const sessionId = randomUUID();
    writeFileSync(emptyMcpConfig, '{"mcpServers":{}}\n', 'utf8');
    const liveRunners: ClaudeRunner[] = [];
    try {
      const initialResults = resultQueue();
      const initial = await ClaudeRunner.spawn({
        args: buildClaudeArgs('read_only', {
          sessionId,
          resume: false,
          emptyMcpConfig,
        }),
        cwd: directory,
        onJson: initialResults.onJson,
        onDiagnostic: () => undefined,
      });
      liveRunners.push(initial);

      initial.sendUserMessage('Reply with exactly INITIAL_OK and do not use tools.', true);
      await expect(initialResults.next()).resolves.toMatchObject({
        type: 'result',
        subtype: 'success',
        result: 'INITIAL_OK',
      });

      initial.sendUserMessage('Context marker: CONTEXT_ONLY.', false);
      await expect(initialResults.next()).resolves.toMatchObject({
        type: 'result',
        subtype: 'success',
        num_turns: 0,
      });
      expect(initial.exited).toBe(false);

      initial.sendUserMessage('Reply with exactly FOLLOWUP_OK and do not use tools.', true);
      await expect(initialResults.next()).resolves.toMatchObject({
        type: 'result',
        subtype: 'success',
        result: 'FOLLOWUP_OK',
      });
      expect(await initial.interrupt(1_000)).toBe(true);

      const resumedResults = resultQueue();
      const resumed = await ClaudeRunner.spawn({
        args: buildClaudeArgs('read_only', {
          sessionId,
          resume: true,
          emptyMcpConfig,
        }),
        cwd: directory,
        onJson: resumedResults.onJson,
        onDiagnostic: () => undefined,
      });
      liveRunners.push(resumed);
      resumed.sendUserMessage('Reply with exactly RESUME_OK and do not use tools.', true);
      await expect(resumedResults.next()).resolves.toMatchObject({
        type: 'result',
        subtype: 'success',
        result: 'RESUME_OK',
      });
      expect(await resumed.interrupt(1_000)).toBe(true);
    } finally {
      for (const runner of liveRunners) {
        if (!runner.exited) await runner.interrupt(0);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
