export interface JsonDecodedLine {
  kind: 'json';
  raw: string;
  value: unknown;
}

export interface DiagnosticDecodedLine {
  kind: 'diagnostic';
  text: string;
}

export type DecodedLine = JsonDecodedLine | DiagnosticDecodedLine;

export interface JsonLineDecoderOptions {
  maxDiagnosticChars?: number;
  maxBufferedChars?: number;
}

const ansiControlSequence = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

export class JsonLineDecoder {
  readonly #maxDiagnosticChars: number;
  readonly #maxBufferedChars: number;
  #buffer = '';

  constructor(options: JsonLineDecoderOptions = {}) {
    this.#maxDiagnosticChars = options.maxDiagnosticChars ?? 4_096;
    this.#maxBufferedChars = options.maxBufferedChars ?? 1_048_576;
    if (!Number.isSafeInteger(this.#maxDiagnosticChars) || this.#maxDiagnosticChars < 1) {
      throw new Error('maxDiagnosticChars must be a positive integer');
    }
    if (!Number.isSafeInteger(this.#maxBufferedChars) || this.#maxBufferedChars < 1) {
      throw new Error('maxBufferedChars must be a positive integer');
    }
  }

  push(chunk: string): DecodedLine[] {
    this.#buffer += chunk;
    const decoded: DecodedLine[] = [];
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== '') decoded.push(this.decodeLine(line));
      newline = this.#buffer.indexOf('\n');
    }
    if (this.#buffer.length > this.#maxBufferedChars) {
      const overflow = this.#buffer.slice(0, this.#buffer.length - this.#maxBufferedChars);
      this.#buffer = this.#buffer.slice(-this.#maxBufferedChars);
      decoded.push({
        kind: 'diagnostic',
        text: overflow.slice(-this.#maxDiagnosticChars),
      });
    }
    return decoded;
  }

  private decodeLine(line: string): DecodedLine {
    const candidate = line.replace(ansiControlSequence, '').trim();
    try {
      return { kind: 'json', raw: line, value: JSON.parse(candidate) as unknown };
    } catch {
      return { kind: 'diagnostic', text: candidate.slice(-this.#maxDiagnosticChars) };
    }
  }
}
