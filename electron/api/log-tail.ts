import { open } from 'node:fs/promises';

const DEFAULT_TAIL_LINES = 100;

function trimToTailLines(content: string, tailLines: number): string {
  const hasTrailingNewline = content.endsWith('\n');
  const lines = hasTrailingNewline ? content.split('\n').slice(0, -1) : content.split('\n');
  if (lines.length <= tailLines) {
    return content;
  }
  const tail = lines.slice(-tailLines).join('\n');
  return hasTrailingNewline ? `${tail}\n` : tail;
}

export async function readTail(filePath: string, tailLines = DEFAULT_TAIL_LINES): Promise<string> {
  const safeTailLines = Number.isFinite(tailLines)
    ? Math.max(1, Math.floor(tailLines))
    : DEFAULT_TAIL_LINES;
  try {
    const file = await open(filePath, 'r');
    try {
      const stat = await file.stat();
      if (stat.size === 0) {
        return '';
      }

      const chunkSize = 64 * 1024;
      let position = stat.size;
      const chunks: Buffer[] = [];
      let lineCount = 0;

      while (position > 0 && lineCount <= safeTailLines) {
        const bytesToRead = Math.min(chunkSize, position);
        position -= bytesToRead;
        const buffer = Buffer.allocUnsafe(bytesToRead);
        const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
        chunks.unshift(buffer.subarray(0, bytesRead));
        lineCount = Buffer.concat(chunks).toString('utf8').split('\n').length - 1;
      }

      return trimToTailLines(Buffer.concat(chunks).toString('utf8'), safeTailLines);
    } finally {
      await file.close();
    }
  } catch {
    return '';
  }
}
