import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeHostApiContext } from '../context';
import { isRuntimeHostBusinessRoute } from '../route-boundary';
import { parseJsonBody, sendJson, sendNoContent } from '../route-utils';
import { logger } from '../../utils/logger';
import { traceDebug } from '../../utils/trace-logger';

type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
const REQUEST_TIMEOUT_HEADER = 'x-matchaclaw-request-timeout-ms';

function toForwardRoute(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function readForwardTimeoutMs(req: IncomingMessage): number | undefined {
  const rawValue = req.headers?.[REQUEST_TIMEOUT_HEADER];
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const timeoutMs = Number.parseInt(value, 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
}

export async function handleRuntimeHostProxyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RuntimeHostApiContext,
): Promise<boolean> {
  if (!isRuntimeHostBusinessRoute(url.pathname)) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    sendNoContent(res);
    return true;
  }

  const method = req.method as RouteMethod | undefined;
  if (!method || !['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    return false;
  }

  const payload = (method === 'POST' || method === 'PUT')
    ? await parseJsonBody<unknown>(req)
    : undefined;
  const route = toForwardRoute(url);
  const timeoutMs = readForwardTimeoutMs(req);
  const traceId = `host-proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  traceDebug(2, '[runtime-host-proxy] start', {
    traceId,
    method,
    route,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  try {
    const result = await ctx.runtimeHost.request(
      method,
      route,
      payload,
      timeoutMs ? { timeoutMs } : undefined,
    );
    traceDebug(2, '[runtime-host-proxy] finish', {
      traceId,
      method,
      route,
      status: result.status,
      elapsedMs: Date.now() - startedAt,
    });
    sendJson(res, result.status, result.data);
  } catch (error) {
    logger.warn('[runtime-host-proxy] failed', {
      traceId,
      method,
      route,
      message: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
  return true;
}
