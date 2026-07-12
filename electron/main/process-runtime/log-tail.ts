import { StringDecoder } from 'node:string_decoder';
import type { LocalProcessLogStream } from './contracts';

const ANSI_ESCAPE_PATTERN = /\[[0-9;?]*[ -/]*[@-~]/g;

type ProcessOutputChunk = string | Buffer | null | undefined;

export type ProcessOutputLineBuffer = {
  readonly push: (output: ProcessOutputChunk) => string[];
  readonly flush: () => string[];
};

export function createProcessOutputLineBuffer(): ProcessOutputLineBuffer {
  const decoder = new StringDecoder('utf8');
  let pendingLine = '';

  function normalizeLines(raw: string, flush: boolean): string[] {
    if (!raw && !flush) return [];

    const normalized = `${pendingLine}${raw}`
      .replace(/\r\n?/g, '\n')
      .replace(ANSI_ESCAPE_PATTERN, '');
    const lines = normalized.split('\n');
    pendingLine = flush ? '' : lines.pop() ?? '';
    const completeLines = flush ? lines : lines;

    return completeLines
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
  }

  return {
    push(output) {
      const raw = typeof output === 'string'
        ? output
        : Buffer.isBuffer(output)
          ? decoder.write(output)
          : '';
      return normalizeLines(raw, false);
    },
    flush() {
      return normalizeLines(decoder.end(), true);
    },
  };
}

export function normalizeProcessOutputChunk(output: ProcessOutputChunk): string[] {
  const buffer = createProcessOutputLineBuffer();
  return [
    ...buffer.push(output),
    ...buffer.flush(),
  ];
}

export function formatProcessLogPrefix(displayName: string, stream: LocalProcessLogStream): string {
  return stream === 'stderr'
    ? `[${displayName}:stderr]`
    : `[${displayName}]`;
}
