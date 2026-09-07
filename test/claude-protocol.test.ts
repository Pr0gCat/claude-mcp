import { describe, expect, it } from 'vitest';

import { JsonLineDecoder } from '../src/claude/protocol.js';

describe('JsonLineDecoder', () => {
  it('retains a fragmented JSON line until its CRLF arrives', () => {
    const decoder = new JsonLineDecoder();

    expect(decoder.push('{"type":"assis')).toEqual([]);
    expect(decoder.push('tant","message":{"content":[]}}\r\n')).toEqual([{
      kind: 'json',
      raw: '{"type":"assistant","message":{"content":[]}}',
      value: { type: 'assistant', message: { content: [] } },
    }]);
  });

  it('tolerates unknown JSON event types without classifying them as noise', () => {
    const decoder = new JsonLineDecoder();

    expect(decoder.push('{"type":"future_event","payload":7}\n')).toEqual([{
      kind: 'json',
      raw: '{"type":"future_event","payload":7}',
      value: { type: 'future_event', payload: 7 },
    }]);
  });

  it('separates non-JSON PTY output into bounded diagnostics', () => {
    const decoder = new JsonLineDecoder({ maxDiagnosticChars: 8 });

    expect(decoder.push('warning: abcdef\r\n')).toEqual([{
      kind: 'diagnostic',
      text: ': abcdef',
    }]);
  });
});
