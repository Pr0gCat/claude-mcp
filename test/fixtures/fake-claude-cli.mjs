#!/usr/bin/env node
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.999 (Fake Claude Code for e2e tests)\n');
  process.exit(0);
}

const resultDelayMs = Number(process.env.FAKE_CLAUDE_RESULT_DELAY_MS ?? '0');

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);

input.on('line', (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.stderr.write('fake Claude received malformed JSON\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(frame)}\n`);
  const shouldQuery = frame.shouldQuery !== false;
  const emitResult = () => {
    process.stdout.write(`${JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: shouldQuery ? 'fake result' : '',
      num_turns: shouldQuery ? 1 : 0,
    })}\n`);
  };
  if (shouldQuery && resultDelayMs > 0) setTimeout(emitResult, resultDelayMs);
  else emitResult();
});

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
