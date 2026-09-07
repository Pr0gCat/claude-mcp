import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('npm executable contract', () => {
  it('preserves a Node shebang in the compiled bin entrypoint', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'claude-mcp-package-'));
    temporaryDirectories.push(outDir);
    execFileSync(process.execPath, [
      join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(repoRoot, 'tsconfig.build.json'),
      '--outDir',
      outDir,
    ], { cwd: repoRoot, stdio: 'pipe', timeout: 60_000 });

    const entrypoint = readFileSync(join(outDir, 'index.js'), 'utf8');
    expect(entrypoint.startsWith('#!/usr/bin/env node\n')).toBe(true);
  }, 30_000);
});
