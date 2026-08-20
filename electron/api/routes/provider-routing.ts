import type { IncomingMessage, ServerResponse } from 'http';
import type { ProviderRoutingTransport } from '../../main/runtime-host-delivery/transport/providers/routing';
import { parseJsonBody, sendJson } from '../route-utils';

const LIST_REQUEST = {
  id: 'provider.routing' as const,
  operationId: 'providerRouting.list' as const,
  scope: { kind: 'provider-routing' as const },
  target: { kind: 'provider-routing' as const },
  input: { kind: 'list' as const },
};

const INVALID = {
  success: false,
  error: 'Provider routing request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Provider routing is unavailable',
} as const;

export async function handleProviderRoutingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ProviderRoutingTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/provider-routing') return false;
  if (req.method === 'GET') {
    if ([...url.searchParams].length !== 0) {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(res, transport.execute(LIST_REQUEST), UNAVAILABLE);
    return true;
  }
  if (req.method !== 'POST') return false;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  await deliver(res, transport.execute(body), UNAVAILABLE);
  return true;
}

async function deliver(
  res: ServerResponse,
  responsePromise: Promise<{ status: number; body: unknown }>,
  unavailable: typeof UNAVAILABLE,
): Promise<void> {
  try {
    const response = await responsePromise;
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, unavailable);
  }
}
