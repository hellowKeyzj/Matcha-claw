import { trackUiEvent } from './telemetry';
import {
  AppError,
  type AppErrorCode,
  normalizeAppError,
} from './error-model';
export { AppError } from './error-model';

export type TransportKind = 'ipc' | 'ws' | 'http';
type TransportInvoker = <T>(channel: string, args: unknown[]) => Promise<T>;
type TransportRequest = { channel: string; args: unknown[] };

type NormalizedTransportResponse = {
  ok: boolean;
  data?: unknown;
  error?: unknown;
};

type TransportRule = {
  matcher: string | RegExp;
  order: TransportKind[];
};

export type ApiClientTransportConfig = {
  enabled: Record<Exclude<TransportKind, 'ipc'>, boolean>;
  rules: TransportRule[];
};

const customInvokers = new Map<Exclude<TransportKind, 'ipc'>, TransportInvoker>();
const GATEWAY_WS_DIAG_FLAG = 'clawx:gateway-ws-diagnostic';

let transportConfig: ApiClientTransportConfig = {
  enabled: {
    ws: false,
    http: false,
  },
  rules: [
    { matcher: /^gateway:rpc$/, order: ['ws', 'ipc'] },
    { matcher: /^gateway:/, order: ['ipc'] },
    { matcher: /.*/, order: ['ipc'] },
  ],
};

type GatewayStatusLike = {
  port?: unknown;
};

type HttpTransportOptions = {
  endpointResolver: () => Promise<string> | string;
  headers?: HeadersInit;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  buildRequest?: (request: TransportRequest) => {
    url?: string;
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
  };
  parseResponse?: (response: Response) => Promise<NormalizedTransportResponse>;
};

type WsTransportOptions = {
  urlResolver: () => Promise<string> | string;
  timeoutMs?: number;
  websocketFactory?: (url: string) => WebSocket;
  buildMessage?: (requestId: string, request: TransportRequest) => unknown;
  parseMessage?: (payload: unknown) => { id?: string; ok: boolean; data?: unknown; error?: unknown } | null;
};

type GatewayWsTransportOptions = {
  urlResolver?: () => Promise<string> | string;
  tokenResolver?: () => Promise<string | null> | string | null;
  timeoutMs?: number;
  websocketFactory?: (url: string) => WebSocket;
};

type GatewayControlUiResponse = {
  success?: boolean;
  token?: string;
};

function normalizeGatewayRpcEnvelope(value: unknown): { success: boolean; result?: unknown; error?: string } {
  if (value && typeof value === 'object' && 'success' in (value as Record<string, unknown>)) {
    return value as { success: boolean; result?: unknown; error?: string };
  }
  return { success: true, result: value };
}

let cachedGatewayPort: { port: number; expiresAt: number } | null = null;
const transportBackoffUntil: Partial<Record<Exclude<TransportKind, 'ipc'>, number>> = {};
const SLOW_REQUEST_THRESHOLD_MS = 800;

async function resolveGatewayPort(): Promise<number> {
  const now = Date.now();
  if (cachedGatewayPort && cachedGatewayPort.expiresAt > now) {
    return cachedGatewayPort.port;
  }

  const status = await invokeViaIpc<GatewayStatusLike>('gateway:status', []);
  const port = typeof status?.port === 'number' && status.port > 0 ? status.port : 18789;
  cachedGatewayPort = { port, expiresAt: now + 5000 };
  return port;
}

export async function resolveDefaultGatewayHttpBaseUrl(): Promise<string> {
  const port = await resolveGatewayPort();
  return `http://127.0.0.1:${port}`;
}

export async function resolveDefaultGatewayWsUrl(): Promise<string> {
  const port = await resolveGatewayPort();
  return `ws://127.0.0.1:${port}/ws`;
}

class TransportUnsupportedError extends Error {
  transport: TransportKind;

  constructor(transport: TransportKind, message: string) {
    super(message);
    this.transport = transport;
  }
}

function shouldLogApiRequests(): boolean {
  try {
    return import.meta.env.DEV || window.localStorage.getItem('clawx:api-log') === '1';
  } catch {
    return !!import.meta.env.DEV;
  }
}

function logApiAttempt(entry: {
  requestId: string;
  channel: string;
  transport: TransportKind;
  attempt: number;
  durationMs: number;
  ok: boolean;
  error?: unknown;
}): void {
  if (!shouldLogApiRequests()) return;
  const base = `[api-client] id=${entry.requestId} channel=${entry.channel} transport=${entry.transport} attempt=${entry.attempt} durationMs=${entry.durationMs}`;
  if (entry.ok) {
    console.info(`${base} result=ok`);
  } else {
    console.warn(`${base} result=error`, entry.error);
  }
}

function isRuleMatch(matcher: string | RegExp, channel: string): boolean {
  if (typeof matcher === 'string') {
    if (matcher.endsWith('*')) {
      return channel.startsWith(matcher.slice(0, -1));
    }
    return matcher === channel;
  }
  return matcher.test(channel);
}

function resolveTransportOrder(channel: string): TransportKind[] {
  const now = Date.now();
  const matchedRule = transportConfig.rules.find((rule) => isRuleMatch(rule.matcher, channel));
  const order = matchedRule?.order ?? ['ipc'];

  return order.filter((kind) => {
    if (kind === 'ipc') return true;
    const backoffUntil = transportBackoffUntil[kind];
    if (typeof backoffUntil === 'number' && backoffUntil > now) {
      return false;
    }
    return transportConfig.enabled[kind];
  });
}

function markTransportFailure(kind: TransportKind): void {
  if (kind === 'ipc') return;
  transportBackoffUntil[kind] = Date.now() + 5000;
}

export function clearTransportBackoff(kind?: Exclude<TransportKind, 'ipc'>): void {
  if (kind) {
    delete transportBackoffUntil[kind];
    return;
  }
  delete transportBackoffUntil.ws;
  delete transportBackoffUntil.http;
}

export function applyGatewayTransportPreference(): void {
  const wsDiagnosticEnabled = getGatewayWsDiagnosticEnabled();
  clearTransportBackoff();
  if (wsDiagnosticEnabled) {
    configureApiClient({
      enabled: {
        ws: true,
        http: true,
      },
      rules: [
        { matcher: /^gateway:rpc$/, order: ['ws', 'http', 'ipc'] },
        { matcher: /^gateway:/, order: ['ipc'] },
        { matcher: /.*/, order: ['ipc'] },
      ],
    });
    return;
  }

  // Availability-first default:
  // keep IPC as the authoritative runtime path.
  configureApiClient({
    enabled: {
      ws: false,
      http: false,
    },
    rules: [
      { matcher: /^gateway:rpc$/, order: ['ipc'] },
      { matcher: /^gateway:/, order: ['ipc'] },
      { matcher: /.*/, order: ['ipc'] },
    ],
  });
}

export function getGatewayWsDiagnosticEnabled(): boolean {
  try {
    return window.localStorage.getItem(GATEWAY_WS_DIAG_FLAG) === '1';
  } catch {
    return false;
  }
}

export function setGatewayWsDiagnosticEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      window.localStorage.setItem(GATEWAY_WS_DIAG_FLAG, '1');
    } else {
      window.localStorage.removeItem(GATEWAY_WS_DIAG_FLAG);
    }
  } catch {
    // ignore localStorage errors
  }
  applyGatewayTransportPreference();
}

async function invokeViaIpc<T>(channel: string, args: unknown[]): Promise<T> {
  try {
    return await window.electron.ipcRenderer.invoke(channel, ...args) as T;
  } catch (err) {
    throw normalizeAppError(err, { transport: 'ipc', channel, source: 'ipc' });
  }
}

async function invokeViaTransport<T>(kind: TransportKind, channel: string, args: unknown[]): Promise<T> {
  if (kind === 'ipc') {
    return invokeViaIpc<T>(channel, args);
  }

  const invoker = customInvokers.get(kind);
  if (!invoker) {
    throw new TransportUnsupportedError(kind, `${kind.toUpperCase()} transport invoker is not registered`);
  }
  return invoker<T>(channel, args);
}

export function configureApiClient(next: Partial<ApiClientTransportConfig>): void {
  transportConfig = {
    enabled: {
      ...transportConfig.enabled,
      ...(next.enabled ?? {}),
    },
    rules: next.rules ?? transportConfig.rules,
  };
}

export function getApiClientConfig(): ApiClientTransportConfig {
  return {
    enabled: { ...transportConfig.enabled },
    rules: [...transportConfig.rules],
  };
}

export function registerTransportInvoker(kind: Exclude<TransportKind, 'ipc'>, invoker: TransportInvoker): void {
  customInvokers.set(kind, invoker);
}

export function unregisterTransportInvoker(kind: Exclude<TransportKind, 'ipc'>): void {
  customInvokers.delete(kind);
}

export function createHttpTransportInvoker(options: HttpTransportOptions): TransportInvoker {
  const timeoutMs = options.timeoutMs ?? 15000;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async <T>(channel: string, args: unknown[]): Promise<T> => {
    const baseUrl = await Promise.resolve(options.endpointResolver());
    if (!baseUrl) {
      throw new Error('HTTP transport endpoint is empty');
    }

    const request = { channel, args };
    const built = options.buildRequest?.(request);
    const url = built?.url ?? `${baseUrl.replace(/\/$/, '')}/rpc`;
    const method = built?.method ?? 'POST';
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
      ...(built?.headers ?? {}),
    };
    const body = built?.body ?? JSON.stringify(request);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const parsed = options.parseResponse
        ? await options.parseResponse(response)
        : await response.json() as NormalizedTransportResponse;

      if (!parsed?.ok) {
        throw new Error(String(parsed?.error ?? 'HTTP transport request failed'));
      }
      return parsed.data as T;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createWsTransportInvoker(options: WsTransportOptions): TransportInvoker {
  const timeoutMs = options.timeoutMs ?? 15000;
  const websocketFactory = options.websocketFactory ?? ((url: string) => new WebSocket(url));
  let socket: WebSocket | null = null;
  let connectPromise: Promise<WebSocket> | null = null;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

  const clearPending = (error: Error) => {
    for (const [id, item] of pending.entries()) {
      clearTimeout(item.timer);
      item.reject(error);
      pending.delete(id);
    }
  };

  const ensureConnection = async (): Promise<WebSocket> => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      return socket;
    }
    if (connectPromise) {
      return connectPromise;
    }

    connectPromise = (async () => {
      const url = await Promise.resolve(options.urlResolver());
      if (!url) {
        throw new Error('WS transport URL is empty');
      }
      const ws = websocketFactory(url);

      return await new Promise<WebSocket>((resolve, reject) => {
        const cleanup = () => {
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('error', onError);
        };
        const onOpen = () => {
          cleanup();
          resolve(ws);
        };
        const onError = (event: Event) => {
          cleanup();
          reject(new Error(`WS transport connection failed: ${String(event.type)}`));
        };
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onError);
      });
    })();

    try {
      socket = await connectPromise;
      socket.addEventListener('message', (event) => {
        try {
          const raw = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          const parsed = options.parseMessage
            ? options.parseMessage(raw)
            : (raw as { id?: string; ok: boolean; data?: unknown; error?: unknown });

          if (!parsed?.id) return;
          const item = pending.get(parsed.id);
          if (!item) return;

          clearTimeout(item.timer);
          pending.delete(parsed.id);

          if (parsed.ok) {
            item.resolve(parsed.data);
          } else {
            item.reject(new Error(String(parsed.error ?? 'WS transport request failed')));
          }
        } catch {
          // ignore malformed event payloads
        }
      });
      socket.addEventListener('close', () => {
        socket = null;
        clearPending(new Error('WS transport closed'));
      });
      socket.addEventListener('error', () => {
        socket = null;
      });
      return socket;
    } finally {
      connectPromise = null;
    }
  };

  return async <T>(channel: string, args: unknown[]): Promise<T> => {
    const ws = await ensureConnection();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const message = options.buildMessage
      ? options.buildMessage(requestId, { channel, args })
      : { id: requestId, channel, args };

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('WS transport timeout'));
      }, timeoutMs);

      pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(err);
      }
    });
  };
}

export function createGatewayHttpTransportInvoker(
  _endpointResolver: () => Promise<string> | string = resolveDefaultGatewayHttpBaseUrl,
): TransportInvoker {
  return async <T>(channel: string, args: unknown[]): Promise<T> => {
    if (channel !== 'gateway:rpc') {
      throw new Error(`HTTP gateway transport does not support channel: ${channel}`);
    }
    const [method, params, timeoutOverride] = args;
    if (typeof method !== 'string') {
      throw new Error('gateway:rpc requires method string');
    }

    const timeoutMs =
      typeof timeoutOverride === 'number' && timeoutOverride > 0
        ? timeoutOverride
        : 15000;

    const response = await invokeViaIpc<{
      ok: boolean;
      data?: unknown;
      error?: unknown;
    }>('gateway:httpProxy', [{
      path: '/rpc',
      method: 'POST',
      timeoutMs,
      body: {
        type: 'req',
        method,
        params,
      },
    }]);

    if (!response.ok) {
      const errObj = response?.error as { message?: string } | string | undefined;
      throw new Error(
        typeof errObj === 'string'
          ? errObj
          : (errObj?.message || 'Gateway HTTP proxy failed'),
      );
    }

    const proxyData = response.data as { status?: number; ok?: boolean; json?: unknown; text?: string } | undefined;
    const payload = proxyData?.json as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      throw new Error(proxyData?.text || `Gateway HTTP returned non-JSON (status=${proxyData?.status ?? 'unknown'})`);
    }
    if (payload.type === 'res') {
      if (payload.ok === false || payload.error) {
        throw new Error(String(payload.error ?? 'Gateway HTTP request failed'));
      }
      return normalizeGatewayRpcEnvelope(payload.payload ?? payload) as T;
    }
    if ('ok' in payload) {
      if (!payload.ok) {
        throw new Error(String(payload.error ?? 'Gateway HTTP request failed'));
      }
      return normalizeGatewayRpcEnvelope(payload.data ?? payload) as T;
    }

    return normalizeGatewayRpcEnvelope(payload) as T;
  };
}

async function getGatewayTokenFromHostSettings(): Promise<string | null> {
  const response = await invokeViaIpc<{
    ok: boolean;
    data?: unknown;
    error?: unknown;
  }>('hostapi:fetch', [{
    path: '/api/settings/gatewayToken',
    method: 'GET',
  }]);

  if (!response.ok) {
    const errObj = response?.error as { message?: string } | string | undefined;
    throw new Error(
      typeof errObj === 'string'
        ? errObj
        : (errObj?.message || 'Host settings request failed'),
    );
  }

  const proxyData = response.data as { json?: unknown } | undefined;
  const payload = proxyData?.json as { value?: unknown } | undefined;
  return typeof payload?.value === 'string' ? payload.value : null;
}

export function createGatewayWsTransportInvoker(options: GatewayWsTransportOptions = {}): TransportInvoker {
  const timeoutMs = options.timeoutMs ?? 15000;
  const websocketFactory = options.websocketFactory ?? ((url: string) => new WebSocket(url));
  const resolveUrl = options.urlResolver ?? resolveDefaultGatewayWsUrl;
  const resolveToken = options.tokenResolver ?? (async () => {
    const controlUi = await invokeViaIpc<GatewayControlUiResponse>('gateway:getControlUiUrl', []);
    if (controlUi?.success && typeof controlUi.token === 'string' && controlUi.token.trim()) {
      return controlUi.token;
    }
    return await getGatewayTokenFromHostSettings();
  });

  let socket: WebSocket | null = null;
  let connectPromise: Promise<WebSocket> | null = null;
  let handshakeDone = false;
  let connectRequestId: string | null = null;

  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const clearPending = (error: Error) => {
    for (const [id, item] of pending.entries()) {
      clearTimeout(item.timer);
      item.reject(error);
      pending.delete(id);
    }
  };

  const formatGatewayError = (errorValue: unknown): string => {
    if (errorValue == null) return 'unknown';
    if (typeof errorValue === 'string') return errorValue;
    if (typeof errorValue === 'object') {
      const asRecord = errorValue as Record<string, unknown>;
      const message = typeof asRecord.message === 'string' ? asRecord.message : null;
      const code = typeof asRecord.code === 'string' || typeof asRecord.code === 'number'
        ? String(asRecord.code)
        : null;
      if (message && code) return `${code}: ${message}`;
      if (message) return message;
      try {
        return JSON.stringify(errorValue);
      } catch {
        return String(errorValue);
      }
    }
    return String(errorValue);
  };

  const ensureConnection = async (): Promise<WebSocket> => {
    if (socket && socket.readyState === WebSocket.OPEN && handshakeDone) {
      return socket;
    }
    if (connectPromise) {
      return connectPromise;
    }

    connectPromise = (async () => {
      const url = await Promise.resolve(resolveUrl());
      if (!url) {
        throw new Error('Gateway WS URL is empty');
      }
      const ws = websocketFactory(url);
      socket = ws;
      const tokenPromise = Promise.resolve(resolveToken()).catch(() => null);

      try {
        await new Promise<void>((resolve, reject) => {
          let handshakeStarted = false;
          let handshakeFinished = false;
          let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
          const openTimer = setTimeout(() => {
            rejectOnce(new Error('Gateway WS connect timeout'));
          }, timeoutMs);
          const cleanup = () => {
            clearTimeout(openTimer);
            if (handshakeTimer) {
              clearTimeout(handshakeTimer);
              handshakeTimer = null;
            }
            ws.removeEventListener('open', onOpen);
            ws.removeEventListener('error', onError);
            ws.removeEventListener('close', onClose);
            ws.removeEventListener('message', onHandshakeMessage);
          };
          const resolveOnce = () => {
            if (handshakeFinished) return;
            handshakeFinished = true;
            cleanup();
            resolve();
          };
          const rejectOnce = (error: Error) => {
            if (handshakeFinished) return;
            handshakeFinished = true;
            cleanup();
            reject(error);
          };
          const sendConnect = async (_challengeNonce: string) => {
            if (connectRequestId) return;
            if (ws.readyState !== WebSocket.OPEN) {
              throw new Error('Gateway WS not open during connect handshake');
            }
            const token = await tokenPromise;
            connectRequestId = `connect-${Date.now()}`;
            const auth =
              typeof token === 'string' && token.trim().length > 0
                ? { token }
                : undefined;
            ws.send(JSON.stringify({
              type: 'req',
              id: connectRequestId,
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: 'openclaw-control-ui',
                  displayName: 'MatchaClaw UI',
                  version: '1.0.0',
                  platform: window.electron?.platform ?? 'unknown',
                  mode: 'webchat',
                },
                auth,
                caps: ['tool-events'],
                role: 'operator',
                scopes: ['operator.admin'],
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
                locale: typeof navigator !== 'undefined' ? navigator.language : 'en',
              },
            }));
          };
          const onOpen = () => {
            if (handshakeStarted) return;
            handshakeStarted = true;
            clearTimeout(openTimer);
            handshakeTimer = setTimeout(() => {
              rejectOnce(new Error('Gateway WS handshake timeout'));
            }, timeoutMs);
          };
          const onError = () => {
            rejectOnce(new Error(handshakeStarted ? 'Gateway WS handshake failed' : 'Gateway WS open failed'));
          };
          const onClose = () => {
            rejectOnce(new Error('Gateway WS closed before connect'));
          };

          const onHandshakeMessage = (event: MessageEvent) => {
            if (!handshakeStarted) {
              return;
            }
            try {
              const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
              if (msg.type === 'event' && msg.event === 'connect.challenge') {
                const payload = (msg.payload ?? {}) as Record<string, unknown>;
                const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
                if (!nonce) {
                  rejectOnce(new Error('Gateway WS challenge nonce missing'));
                  return;
                }
                void sendConnect(nonce).catch((err) => {
                  rejectOnce(err instanceof Error ? err : new Error(String(err)));
                });
                return;
              }

              if (msg.type === 'res' && typeof msg.id === 'string' && msg.id === connectRequestId) {
                const ok = msg.ok !== false && !msg.error;
                if (!ok) {
                  rejectOnce(new Error(`Gateway WS connect failed: ${formatGatewayError(msg.error)}`));
                  return;
                }
                connectRequestId = null;
                handshakeDone = true;
                resolveOnce();
              }
            } catch {
              // ignore parse errors during handshake
            }
          };

          ws.addEventListener('message', onHandshakeMessage);
          ws.addEventListener('open', onOpen);
          ws.addEventListener('error', onError);
          ws.addEventListener('close', onClose);

          if (ws.readyState === WebSocket.OPEN) {
            onOpen();
          }
        });
      } catch (error) {
        socket = null;
        handshakeDone = false;
        connectRequestId = null;
        try {
          ws.close();
        } catch {
          // ignore close errors while cleaning up failed handshake
        }
        throw error;
      }

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (msg.type !== 'res' || typeof msg.id !== 'string') return;
          const item = pending.get(msg.id);
          if (!item) return;

          clearTimeout(item.timer);
          pending.delete(msg.id);

          const ok = msg.ok !== false && !msg.error;
          if (!ok) {
            item.reject(new Error(formatGatewayError(msg.error ?? 'Gateway WS request failed')));
            return;
          }
          item.resolve(normalizeGatewayRpcEnvelope(msg.payload ?? msg));
        } catch {
          // ignore malformed payload
        }
      });
      ws.addEventListener('close', () => {
        socket = null;
        handshakeDone = false;
        connectRequestId = null;
        clearPending(new Error('Gateway WS closed'));
      });
      ws.addEventListener('error', () => {
        socket = null;
        handshakeDone = false;
      });

      return ws;
    })();

    try {
      return await connectPromise;
    } finally {
      connectPromise = null;
    }
  };

  return async <T>(channel: string, args: unknown[]): Promise<T> => {
    if (channel !== 'gateway:rpc') {
      throw new Error(`Gateway WS transport does not support channel: ${channel}`);
    }
    const [method, params, timeoutOverride] = args;
    if (typeof method !== 'string') {
      throw new Error('gateway:rpc requires method string');
    }

    const requestTimeoutMs =
      typeof timeoutOverride === 'number' && timeoutOverride > 0
        ? timeoutOverride
        : timeoutMs;

    const ws = await ensureConnection();
    const requestId = crypto.randomUUID();
    ws.send(JSON.stringify({
      type: 'req',
      id: requestId,
      method,
      params,
    }));

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Gateway WS timeout: ${method}`));
      }, requestTimeoutMs);

      pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
  };
}

let defaultTransportsInitialized = false;

export function initializeDefaultTransports(): void {
  if (defaultTransportsInitialized) return;
  registerTransportInvoker('ws', createGatewayWsTransportInvoker());
  registerTransportInvoker('http', createGatewayHttpTransportInvoker());
  applyGatewayTransportPreference();
  defaultTransportsInitialized = true;
}

export function toUserMessage(error: unknown): string {
  const appError = error instanceof AppError ? error : normalizeAppError(error);

  switch (appError.code) {
    case 'AUTH_INVALID':
      return 'Authentication failed. Check API key or login session and retry.';
    case 'TIMEOUT':
      return 'Request timed out. Please retry.';
    case 'RATE_LIMIT':
      return 'Too many requests. Please wait and try again.';
    case 'PERMISSION':
      return 'Permission denied. Check your configuration and retry.';
    case 'CHANNEL_UNAVAILABLE':
      return 'Service channel unavailable. Retry after restarting the app or gateway.';
    case 'NETWORK':
      return 'Network error. Please verify connectivity and retry.';
    case 'CONFIG':
      return 'Configuration is invalid. Please review settings.';
    case 'GATEWAY':
      return 'Gateway is unavailable. Start or restart the gateway and retry.';
    default:
      return appError.message || 'Unexpected error occurred.';
  }
}

export async function invokeApi<T>(channel: string, ...args: unknown[]): Promise<T> {
  const requestId = crypto.randomUUID();
  const order = resolveTransportOrder(channel);
  let lastError: unknown;

  for (let i = 0; i < order.length; i += 1) {
    const kind = order[i];
    const attempt = i + 1;
    const startedAt = Date.now();
    try {
      const value = await invokeViaTransport<T>(kind, channel, args);
      const durationMs = Date.now() - startedAt;
      logApiAttempt({
        requestId,
        channel,
        transport: kind,
        attempt,
        durationMs,
        ok: true,
      });
      if (durationMs >= SLOW_REQUEST_THRESHOLD_MS || attempt > 1) {
        trackUiEvent('api.request', {
          requestId,
          channel,
          transport: kind,
          attempt,
          durationMs,
          fallbackUsed: attempt > 1,
        });
      }
      return value;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      logApiAttempt({
        requestId,
        channel,
        transport: kind,
        attempt,
        durationMs,
        ok: false,
        error: err,
      });
      trackUiEvent('api.request_error', {
        requestId,
        channel,
        transport: kind,
        attempt,
        durationMs,
        message: err instanceof Error ? err.message : String(err),
      });

      if (err instanceof TransportUnsupportedError) {
        markTransportFailure(kind);
        trackUiEvent('api.transport_fallback', {
          requestId,
          channel,
          from: kind,
          reason: 'unsupported',
          nextAttempt: attempt + 1,
        });
        lastError = err;
        continue;
      }
      lastError = err;
      // For non-IPC transports, fail open to the next transport.
      if (kind !== 'ipc') {
        markTransportFailure(kind);
        trackUiEvent('api.transport_fallback', {
          requestId,
          channel,
          from: kind,
          reason: 'error',
          nextAttempt: attempt + 1,
        });
        continue;
      }
      throw normalizeAppError(err, {
        requestId,
        channel,
        transport: kind,
        attempt,
        durationMs,
      });
    }
  }

  trackUiEvent('api.request_failed', {
    requestId,
    channel,
    attempts: order.length,
    message: lastError instanceof Error ? lastError.message : String(lastError),
  });

  throw normalizeAppError(lastError, {
    requestId,
    channel,
    transport: 'ipc',
    attempt: order.length,
  });
}

export async function invokeIpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invokeApi<T>(channel, ...args);
}

export async function invokeIpcWithRetry<T>(
  channel: string,
  args: unknown[] = [],
  retries = 1,
  retryable: AppErrorCode[] = ['TIMEOUT', 'NETWORK'],
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i <= retries; i += 1) {
    try {
      return await invokeApi<T>(channel, ...args);
    } catch (err) {
      lastError = err;
      if (!(err instanceof AppError) || !retryable.includes(err.code) || i === retries) {
        throw err;
      }
    }
  }

  throw normalizeAppError(lastError);
}
