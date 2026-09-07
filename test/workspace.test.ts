import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalWorkspace } from '../src/workspace.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mcp-workspace-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('canonicalWorkspace', () => {
  it('locks a git worktree root for both the root and its subdirectories', () => {
    const repository = temporaryDirectory();
    const nested = join(repository, 'packages', 'worker');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: repository });

    expect(canonicalWorkspace(nested)).toBe(canonicalWorkspace(repository));
  });

  it.runIf(process.platform === 'win32')('normalizes Windows workspace keys to one case', () => {
    const workspace = temporaryDirectory();

    const key = canonicalWorkspace(workspace);

    expect(key).toBe(key.toLowerCase());
  });

  it.runIf(process.platform === 'win32')('resolves existing directory aliases to the physical workspace', () => {
    const parent = temporaryDirectory();
    const physical = join(parent, 'physical');
    const alias = join(parent, 'alias');
    mkdirSync(physical);
    symlinkSync(physical, alias, 'junction');

    expect(canonicalWorkspace(alias)).toBe(canonicalWorkspace(physical));
  });
});
