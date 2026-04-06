import {
  RUNTIME_HOST_TRANSPORT_VERSION,
  type RuntimeHostTransportHealth,
  type RuntimeHostTransportRequest,
  type RuntimeHostTransportResponse,
  type RuntimeHostRouteResult,
} from './runtime-host-contract';
import { getPort } from '../utils/config';

type RequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class RuntimeHostClientRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; code?: string; retryable?: boolean }) {
    super(message);
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? (options.status >= 500 || options.status === 408);
  }
}

export interface RuntimeHostHttpClient {
  readonly request: <TResponse>(
    method: RequestMethod,
    route: string,
    payload?: unknown,
  ) => Promise<RuntimeHostRouteResult<TResponse>>;
  readonly checkHealth: () => Promise<RuntimeHostTransportHealth>;
}

export interface RuntimeHostHttpClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

export interface RuntimeHostClientFactoryOptions {
  readonly timeoutMs?: number;
  readonly port?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseTransportResponse<TResponse>(payload: unknown): RuntimeHostTransportResponse<TResponse> {
  if (!isRecord(payload)) {
    throw new RuntimeHostClientRequestError('Invalid runtime-host transport payload: expected object', {
      status: 502,
      code: 'INVALID_TRANSPORT_PAYLOAD',
      retryable: false,
    });
  }

  if (payload.version !== RUNTIME_HOST_TRANSPORT_VERSION) {
    throw new RuntimeHostClientRequestError('Invalid runtime-host transport payload: unsupported version', {
      status: 502,
      code: 'INVALID_TRANSPORT_PAYLOAD',
      retryable: false,
    });
  }

  if (typeof payload.success !== 'boolean' || typeof payload.status !== 'number') {
    throw new RuntimeHostClientRequestError('Invalid runtime-host transport payload: malformed success/status', {
      status: 502,
      code: 'INVALID_TRANSPORT_PAYLOAD',
      retryable: false,
    });
  }

  if (payload.success) {
    return payload as RuntimeHostTransportResponse<TResponse>;
  }

  const error = payload.error;
  if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw new RuntimeHostClientRequestError('Invalid runtime-host transport payload: malformed error body', {
      status: 502,
      code: 'INVALID_TRANSPORT_PAYLOAD',
      retryable: false,
    });
  }

  return payload as RuntimeHostTransportResponse<TResponse>;
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
    },
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

export function getRuntimeHostPort(): number {
  return getPort('MATCHACLAW_RUNTIME_HOST');
}

export function getRuntimeHostBaseUrl(port = getRuntimeHostPort()): string {
  return `http://127.0.0.1:${port}`;
}

export function createDefaultRuntimeHostHttpClient(
  options: RuntimeHostClientFactoryOptions = {},
): RuntimeHostHttpClient {
  const port = Number.isFinite(options.port) && (options.port ?? 0) > 0
    ? Number(options.port)
    : getRuntimeHostPort();
  return createRuntimeHostHttpClient({
    baseUrl: getRuntimeHostBaseUrl(port),
    ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
  });
}

export function createRuntimeHostHttpClient(options: RuntimeHostHttpClientOptions): RuntimeHostHttpClient {
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? Number(options.timeoutMs)
    : 15_000;
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  async function request<TResponse>(
    method: RequestMethod,
    route: string,
    payload?: unknown,
  ): Promise<RuntimeHostRouteResult<TResponse>> {
    const transportPayload: RuntimeHostTransportRequest = {
      version: RUNTIME_HOST_TRANSPORT_VERSION,
      method,
      route,
      ...(payload !== undefined ? { payload } : {}),
    };

    const { signal, cleanup } = withTimeout(timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(transportPayload),
        signal,
      });
      const parsed = parseTransportResponse<TResponse>(await response.json());

      if (parsed.success) {
        return {
          status: parsed.status,
          data: parsed.data,
        };
      }

      throw new RuntimeHostClientRequestError(parsed.error.message, {
        status: parsed.status,
        code: parsed.error.code,
        retryable: parsed.status === 501 || parsed.status >= 500,
      });
    } catch (error) {
      if (error instanceof RuntimeHostClientRequestError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new RuntimeHostClientRequestError(
        `Runtime Host HTTP request failed: ${method} ${route} (${message})`,
        { status: 503, code: 'UPSTREAM_UNAVAILABLE', retryable: true },
      );
    } finally {
      cleanup();
    }
  }

  async function checkHealth(): Promise<RuntimeHostTransportHealth> {
    const { signal, cleanup } = withTimeout(Math.min(timeoutMs, 3000));
    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        signal,
      });
      if (!response.ok) {
        return {
          version: RUNTIME_HOST_TRANSPORT_VERSION,
          ok: false,
          lifecycle: 'error',
          error: `HTTP ${response.status}`,
        };
      }
      return await response.json() as RuntimeHostTransportHealth;
    } catch (error) {
      return {
        version: RUNTIME_HOST_TRANSPORT_VERSION,
        ok: false,
        lifecycle: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      cleanup();
    }
  }

  return {
    request,
    checkHealth,
  };
}
