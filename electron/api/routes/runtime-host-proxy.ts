import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeHostApiContext } from '../context';
import { isRuntimeHostBusinessRoute } from '../route-boundary';
import { parseJsonBody, sendJson, sendNoContent } from '../route-utils';

type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

function toForwardRoute(url: URL): string {
  return `${url.pathname}${url.search}`;
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
  const result = await ctx.runtimeHost.request(method, toForwardRoute(url), payload);
  sendJson(res, result.status, result.data);
  return true;
}
