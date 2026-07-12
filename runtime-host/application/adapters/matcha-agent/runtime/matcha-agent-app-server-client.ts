import WebSocket from 'ws';

const APP_SERVER_PROTOCOL_VERSION = 'matcha-agent-app-server-v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type JsonRpcId = string | number;

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

type JsonRpcSuccess = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcFailure = {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type PendingJsonRpcRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type MatchaAgentAppServerEndpoint = {
  url: string;
  token?: string;
};

export type MatchaAgentAppServerHealth = {
  ok: boolean;
  version?: string;
  payload: unknown;
};

export type MatchaAgentAppServerInitializeResult = {
  protocolVersion?: string;
  serverVersion?: string;
  capabilities?: unknown;
  payload: unknown;
};

export type MatchaAgentAppServerEventListener = (eventEnvelope: unknown) => void;

export class MatchaAgentAppServerClient {
  private socket: WebSocket | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<JsonRpcId, PendingJsonRpcRequest>();
  private readonly eventListeners = new Set<MatchaAgentAppServerEventListener>();
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly endpoint: MatchaAgentAppServerEndpoint) {}

  async inspectHealth(): Promise<MatchaAgentAppServerHealth> {
    const response = await fetch(this.healthUrl());
    if (!response.ok) {
      throw new Error(`matcha-agent app-server health returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    const record = asRecord(payload);
    return {
      ok: record?.ok === true,
      ...(typeof record?.version === 'string' ? { version: record.version } : {}),
      payload,
    };
  }

  async initialize(): Promise<MatchaAgentAppServerInitializeResult> {
    const payload = await this.request('initialize', {
      clientName: 'matchaclaw-runtime-host',
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    });
    const record = asRecord(payload);
    return {
      ...(typeof record?.protocolVersion === 'string' ? { protocolVersion: record.protocolVersion } : {}),
      ...(typeof record?.serverVersion === 'string' ? { serverVersion: record.serverVersion } : {}),
      ...(record && 'capabilities' in record ? { capabilities: record.capabilities } : {}),
      payload,
    };
  }

  async request(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('matcha-agent app-server WebSocket is not open');
    }

    const id = this.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`matcha-agent app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      socket.send(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }

  onEvent(listener: MatchaAgentAppServerEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  close(): void {
    this.rejectPendingRequests(new Error('matcha-agent app-server client closed'));
    this.socket?.close();
    this.socket = null;
    this.connectPromise = null;
  }

  private async connect(): Promise<void> {
    const existingSocket = this.socket;
    if (existingSocket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return await this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.webSocketUrl(), {
        headers: this.endpoint.token ? { Authorization: `Bearer ${this.endpoint.token}` } : undefined,
      });
      this.socket = socket;

      const cleanupInitialListeners = (): void => {
        socket.off('open', handleOpen);
        socket.off('error', handleInitialError);
      };
      const handleOpen = (): void => {
        cleanupInitialListeners();
        resolve();
      };
      const handleInitialError = (error: Error): void => {
        cleanupInitialListeners();
        this.socket = null;
        reject(error);
      };

      socket.on('open', handleOpen);
      socket.on('error', handleInitialError);
      socket.on('message', (data) => this.handleMessage(data));
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null;
          this.connectPromise = null;
        }
        this.rejectPendingRequests(new Error('matcha-agent app-server WebSocket closed'));
      });
    }).finally(() => {
      this.connectPromise = null;
    });

    return await this.connectPromise;
  }

  private handleMessage(data: WebSocket.RawData): void {
    const text = data.toString('utf8').trim();
    if (!text) return;

    for (const line of text.split('\n')) {
      const message = parseJsonRpcWireMessage(line);
      if (!message) continue;
      if (isJsonRpcSuccess(message)) {
        this.resolveRequest(message.id, message.result);
        continue;
      }
      if (isJsonRpcFailure(message)) {
        this.rejectRequest(message.id, jsonRpcFailureToError(message));
        continue;
      }
      if (isJsonRpcEventNotification(message)) {
        for (const listener of this.eventListeners) {
          listener(message.params);
        }
      }
    }
  }

  private resolveRequest(id: JsonRpcId, result: unknown): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }

  private rejectRequest(id: JsonRpcId | null, error: Error): void {
    if (id === null) return;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private rejectPendingRequests(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private healthUrl(): string {
    return new URL('/health', this.endpoint.url).toString();
  }

  private webSocketUrl(): string {
    const baseUrl = new URL(this.endpoint.url);
    baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    baseUrl.pathname = '/ws';
    baseUrl.search = '';
    baseUrl.hash = '';
    return baseUrl.toString();
  }
}

function parseJsonRpcWireMessage(line: string): JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification | null {
  try {
    const parsed: unknown = JSON.parse(line);
    const record = asRecord(parsed);
    if (!record || record.jsonrpc !== '2.0') return null;
    if (isJsonRpcSuccessRecord(record)) return { jsonrpc: '2.0', id: record.id, result: record.result };
    if (isJsonRpcFailureRecord(record)) return {
      jsonrpc: '2.0',
      id: record.id,
      error: record.error,
    };
    if (typeof record.method === 'string') {
      return {
        jsonrpc: '2.0',
        method: record.method,
        ...(record.params !== undefined ? { params: record.params } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isJsonRpcSuccess(message: JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification): message is JsonRpcSuccess {
  return 'id' in message && 'result' in message;
}

function isJsonRpcFailure(message: JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification): message is JsonRpcFailure {
  return 'id' in message && 'error' in message;
}

function isJsonRpcEventNotification(message: JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification): message is JsonRpcNotification {
  return !('id' in message) && message.method === 'event';
}

function isJsonRpcSuccessRecord(record: Record<string, unknown>): record is { id: JsonRpcId; result: unknown } {
  return isJsonRpcId(record.id) && 'result' in record;
}

function isJsonRpcFailureRecord(record: Record<string, unknown>): record is { id: JsonRpcId | null; error: JsonRpcFailure['error'] } {
  const error = asRecord(record.error);
  return (isJsonRpcId(record.id) || record.id === null)
    && !!error
    && typeof error.code === 'number'
    && typeof error.message === 'string';
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

function jsonRpcFailureToError(failure: JsonRpcFailure): Error {
  const error = new Error(failure.error.message);
  error.name = `JsonRpcError:${failure.error.code}`;
  return error;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
