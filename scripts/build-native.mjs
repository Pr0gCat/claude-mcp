import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform === 'darwin') {
  mkdirSync(new URL('../dist', import.meta.url), { recursive: true });
  execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', 'native/mac-process-info.c', '-o', 'dist/mac-process-info'], { cwd: root, stdio: 'inherit' });
}
