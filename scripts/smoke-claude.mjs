import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'runner', 'test/claude-real-smoke.test.ts'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
  env: { ...process.env, CLAUDE_MCP_RUN_REAL_CLI_TESTS: '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
