export interface AcpJsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export function encodeAcpJsonRpcMessage(message: AcpJsonRpcMessage): string {
  return `Content-Length: ${Buffer.byteLength(JSON.stringify(message), 'utf8')}\r\n\r\n${JSON.stringify(message)}`;
}

export class AcpFrameParser {
  private buffer = '';

  push(chunk: string | Buffer): AcpJsonRpcMessage[] {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    const messages: AcpJsonRpcMessage[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return messages;
      }
      const header = this.buffer.slice(0, headerEnd);
      const matched = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i);
      if (!matched) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(matched[1]);
      if (!Number.isSafeInteger(length) || length < 0) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) {
        return messages;
      }
      const body = this.buffer.slice(bodyStart, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);
      try {
        const parsed = JSON.parse(body) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).jsonrpc === '2.0') {
          messages.push(parsed as AcpJsonRpcMessage);
        }
      } catch {
        continue;
      }
    }
  }
}
