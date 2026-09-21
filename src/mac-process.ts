import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ProcessIdentity, ProcessIdentityInspection } from './claude/runner.js';

// Preserve all six fractional digits from libproc; Date would discard microseconds.
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const helper = fileURLToPath(new URL('../dist/mac-process-info', import.meta.url));

function observe(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  return execFileSync(helper, [String(pid)], {
    encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function macProcessStartedAt(pid: number): string {
  const observed = observe(pid);
  if (!timestampPattern.test(observed)) throw new Error('could not read Claude process creation time');
  return observed;
}

export function inspectMacProcessIdentity(identity: ProcessIdentity): ProcessIdentityInspection {
  if (!timestampPattern.test(identity.startedAt)) return 'unknown';
  try {
    const observed = observe(identity.pid);
    if (observed === 'missing') return 'missing';
    if (!timestampPattern.test(observed)) return 'unknown';
    return observed === identity.startedAt ? 'matching' : 'reused';
  } catch {
    return 'unknown';
  }
}
