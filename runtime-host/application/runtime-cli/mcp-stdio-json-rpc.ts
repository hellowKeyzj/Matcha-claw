import type { Readable, Writable } from 'node:stream';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcStdioIo {
  readonly stdin: Pick<Readable, 'on' | 'resume'>;
  readonly stdout: Pick<Writable, 'write'>;
}

export interface JsonRpcStdioServerOptions {
  readonly maxHeaderBytes?: number;
  readonly maxBodyBytes?: number;
  readonly maxBufferedBytes?: number;
}

export type JsonRpcRequestHandler = (request: JsonRpcRequest) => Promise<unknown> | unknown;

const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_MAX_BUFFERED_BYTES = DEFAULT_MAX_HEADER_BYTES + DEFAULT_MAX_BODY_BYTES;

export async function runJsonRpcStdioServer(
  io: JsonRpcStdioIo,
  handleRequest: JsonRpcRequestHandler,
  options: JsonRpcStdioServerOptions = {},
): Promise<void> {
  const limits = {
    maxHeaderBytes: options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
  };

  await new Promise<void>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let pending = Promise.resolve();
    const drain = () => {
      pending = pending.then(async () => {
        const result = await drainJsonRpcMessages(buffer, io.stdout, handleRequest, limits);
        buffer = result.remainingBuffer;
      });
      pending.catch(reject);
    };

    io.stdin.on('data', (chunk: unknown) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
      if (buffer.length > limits.maxBufferedBytes) {
        writeJsonRpcMessage(io.stdout, jsonRpcError(null, -32600, `MCP buffered input exceeds ${limits.maxBufferedBytes} bytes`));
        buffer = Buffer.alloc(0);
        return;
      }
      drain();
    });
    io.stdin.on('end', () => {
      pending.then(() => resolve(), reject);
    });
    io.stdin.on('error', reject);
    io.stdin.resume();
  });
}

export function jsonRpcResult(id: JsonRpcId | undefined, result: unknown): unknown {
  return id === undefined ? undefined : { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown): unknown {
  return id === undefined
    ? undefined
    : { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

export function writeJsonRpcMessage(stream: Pick<Writable, 'write'>, message: unknown): void {
  writeJsonRpcContentLengthMessage(stream, message);
}

function writeJsonRpcContentLengthMessage(stream: Pick<Writable, 'write'>, message: unknown): void {
  const body = JSON.stringify(message);
  stream.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function writeJsonRpcLineMessage(stream: Pick<Writable, 'write'>, message: unknown): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

async function drainJsonRpcMessages(
  initialBuffer: Buffer,
  stdout: Pick<Writable, 'write'>,
  handleRequest: JsonRpcRequestHandler,
  limits: Required<JsonRpcStdioServerOptions>,
): Promise<{ readonly remainingBuffer: Buffer }> {
  let buffer = initialBuffer;
  while (true) {
    if (isJsonLineBuffer(buffer)) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd < 0) {
        if (buffer.length > limits.maxBodyBytes) {
          writeJsonRpcLineMessage(stdout, jsonRpcError(null, -32600, `MCP line message exceeds ${limits.maxBodyBytes} bytes`));
          return { remainingBuffer: Buffer.alloc(0) };
        }
        return { remainingBuffer: buffer };
      }
      const line = buffer.subarray(0, lineEnd).toString('utf8').replace(/\r$/, '');
      buffer = buffer.subarray(lineEnd + 1);
      await handleJsonRpcMessage(line, stdout, handleRequest, writeJsonRpcLineMessage);
      continue;
    }

    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      if (buffer.length > limits.maxHeaderBytes) {
        writeJsonRpcContentLengthMessage(stdout, jsonRpcError(null, -32600, `MCP header exceeds ${limits.maxHeaderBytes} bytes`));
        return { remainingBuffer: Buffer.alloc(0) };
      }
      return { remainingBuffer: buffer };
    }

    if (headerEnd > limits.maxHeaderBytes) {
      writeJsonRpcContentLengthMessage(stdout, jsonRpcError(null, -32600, `MCP header exceeds ${limits.maxHeaderBytes} bytes`));
      return { remainingBuffer: Buffer.alloc(0) };
    }

    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const contentLength = readContentLength(header);
    if (contentLength === null) {
      writeJsonRpcContentLengthMessage(stdout, jsonRpcError(null, -32600, 'MCP message is missing a valid Content-Length header'));
      return { remainingBuffer: Buffer.alloc(0) };
    }
    if (contentLength > limits.maxBodyBytes) {
      writeJsonRpcContentLengthMessage(stdout, jsonRpcError(null, -32600, `MCP message body exceeds ${limits.maxBodyBytes} bytes`));
      return { remainingBuffer: Buffer.alloc(0) };
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) {
      return { remainingBuffer: buffer };
    }

    const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.subarray(bodyEnd);
    await handleJsonRpcMessage(body, stdout, handleRequest, writeJsonRpcContentLengthMessage);
  }
}

async function handleJsonRpcMessage(
  body: string,
  stdout: Pick<Writable, 'write'>,
  handleRequest: JsonRpcRequestHandler,
  writeResponse: (stream: Pick<Writable, 'write'>, message: unknown) => void,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    writeResponse(stdout, jsonRpcError(null, -32700, error instanceof Error ? error.message : String(error)));
    return;
  }

  const request = readJsonRpcRequest(parsed);
  if (request.resultType === 'invalidRequest') {
    writeResponse(stdout, jsonRpcError(request.id, -32600, request.message));
    return;
  }

  const response = await handleRequest(request.request);
  if (response !== undefined) {
    writeResponse(stdout, response);
  }
}

type ReadJsonRpcRequestResult =
  | {
      readonly resultType: 'validRequest';
      readonly request: JsonRpcRequest;
    }
  | {
      readonly resultType: 'invalidRequest';
      readonly id: JsonRpcId;
      readonly message: string;
    };

function readJsonRpcRequest(value: unknown): ReadJsonRpcRequestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { resultType: 'invalidRequest', id: null, message: 'Invalid JSON-RPC request' };
  }
  const record = value as Record<string, unknown>;
  const idResult = readJsonRpcId(record.id);
  if (idResult.resultType === 'invalidId') {
    return { resultType: 'invalidRequest', id: null, message: 'Invalid JSON-RPC request id' };
  }
  if (record.jsonrpc !== '2.0') {
    return { resultType: 'invalidRequest', id: idResult.id ?? null, message: 'Invalid JSON-RPC version' };
  }
  if (typeof record.method !== 'string' || !record.method.trim()) {
    return { resultType: 'invalidRequest', id: idResult.id ?? null, message: 'Invalid JSON-RPC method' };
  }
  return {
    resultType: 'validRequest',
    request: {
      jsonrpc: '2.0',
      id: idResult.id,
      method: record.method,
      params: record.params,
    },
  };
}

type ReadJsonRpcIdResult =
  | { readonly resultType: 'validId'; readonly id: JsonRpcId | undefined }
  | { readonly resultType: 'invalidId' };

function readJsonRpcId(value: unknown): ReadJsonRpcIdResult {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'number') {
    return { resultType: 'validId', id: value as JsonRpcId | undefined };
  }
  return { resultType: 'invalidId' };
}

function isJsonLineBuffer(buffer: Buffer): boolean {
  const firstByte = buffer.find((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a);
  return firstByte === 0x7b;
}

function readContentLength(header: string): number | null {
  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) {
      continue;
    }
    if (line.slice(0, separator).trim().toLowerCase() !== 'content-length') {
      continue;
    }
    const rawValue = line.slice(separator + 1).trim();
    if (!/^\d+$/.test(rawValue)) {
      return null;
    }
    const value = Number(rawValue);
    return Number.isSafeInteger(value) ? value : null;
  }
  return null;
}
