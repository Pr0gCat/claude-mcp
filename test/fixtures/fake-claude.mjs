import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

process.stdout.write('{"type":"ready"}\n');

input.on('line', (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.stderr.write('fake Claude received malformed JSON\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(frame)}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: frame.shouldQuery === false ? '' : 'fake result',
    num_turns: frame.shouldQuery === false ? 0 : 1,
  })}\n`);
});

process.on('SIGINT', () => process.exit(130));
