import type { ProviderRoutingTransport } from '../../main/runtime-host-delivery/transport/providers/routing';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

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
  req: HostApiRequest,
  url: URL,
  transport: ProviderRoutingTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/provider-routing') return undefined;
  if (req.method === 'GET') {
    if ([...url.searchParams].length !== 0) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport.execute(LIST_REQUEST), UNAVAILABLE);
  }
  if (req.method !== 'POST') return undefined;

  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    return jsonResult(400, INVALID);
  }
  return deliver(transport.execute(body), UNAVAILABLE);
}

async function deliver(
  responsePromise: Promise<{ status: number; body: unknown }>,
  unavailable: typeof UNAVAILABLE,
): Promise<HostApiRouteResult> {
  try {
    const response = await responsePromise;
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, unavailable);
  }
}
