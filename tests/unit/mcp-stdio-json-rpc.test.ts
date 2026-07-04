import { describe, expect, it } from 'vitest';
import { runJsonRpcStdioServer, jsonRpcResult } from '../../runtime-host/application/runtime-cli/mcp-stdio-json-rpc';

function encodeJsonRpcMessage(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function decodeJsonRpcMessages(output: string): unknown[] {
  const messages: unknown[] = [];
  let buffer = Buffer.from(output, 'utf8');
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number.parseInt(match[1], 10);
    messages.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8')));
    buffer = buffer.subarray(bodyEnd);
  }
  return messages;
}

function createInput(chunks: readonly string[]) {
  const handlers = new Map<string, ((value?: unknown) => void)[]>();
  return {
    on(event: string, listener: (value?: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), listener]);
      return this;
    },
    resume() {
      for (const chunk of chunks) {
        for (const listener of handlers.get('data') ?? []) listener(chunk);
      }
      for (const listener of handlers.get('end') ?? []) listener();
    },
  };
}

describe('MCP stdio JSON-RPC server', () => {
  it('handles multiple framed messages in order', async () => {
    const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
    await runJsonRpcStdioServer({
      stdin: createInput([
        encodeJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'one' })
        + encodeJsonRpcMessage({ jsonrpc: '2.0', id: 2, method: 'two' }),
      ]) as never,
      stdout,
    }, (request) => jsonRpcResult(request.id, { method: request.method }));

    expect(decodeJsonRpcMessages(stdout.chunks.join(''))).toEqual([
      { jsonrpc: '2.0', id: 1, result: { method: 'one' } },
      { jsonrpc: '2.0', id: 2, result: { method: 'two' } },
    ]);
  });

  it('rejects invalid Content-Length without calling the handler', async () => {
    const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
    let handled = false;
    await runJsonRpcStdioServer({
      stdin: createInput(['Content-Length: 12abc\r\n\r\n{}']) as never,
      stdout,
    }, () => {
      handled = true;
      return undefined;
    });

    expect(handled).toBe(false);
    expect(decodeJsonRpcMessages(stdout.chunks.join(''))).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP message is missing a valid Content-Length header' } },
    ]);
  });

  it('returns parse error frames for malformed JSON', async () => {
    const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
    await runJsonRpcStdioServer({
      stdin: createInput(['Content-Length: 1\r\n\r\n{']) as never,
      stdout,
    }, () => undefined);

    const [response] = decodeJsonRpcMessages(stdout.chunks.join('')) as Array<{ error: { code: number } }>;
    expect(response.error.code).toBe(-32700);
  });

  it('does not respond to valid notifications when the handler returns no response', async () => {
    const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); } };
    await runJsonRpcStdioServer({
      stdin: createInput([encodeJsonRpcMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })]) as never,
      stdout,
    }, () => undefined);

    expect(stdout.chunks).toEqual([]);
  });
});
