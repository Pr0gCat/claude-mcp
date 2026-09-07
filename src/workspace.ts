import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

function physicalPath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

export function canonicalWorkspace(cwd: string): string {
  const physicalCwd = physicalPath(cwd);
  let workspace = physicalCwd;
  try {
    const root = execFileSync(
      'git',
      ['-C', physicalCwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    ).trim();
    if (root !== '') workspace = physicalPath(root);
  } catch {
    // A non-repository path is already its own canonical workspace.
  }
  return process.platform === 'win32' ? workspace.toLowerCase() : workspace;
}
