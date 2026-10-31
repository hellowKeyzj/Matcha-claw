import type {
  ProviderModelCapability,
  ProviderModelsTransport,
} from '../../main/runtime-host-delivery/transport/providers/models';
import {
  isProviderModelAccountIdentifier,
  isProviderModelCapability,
} from '../../main/runtime-host-delivery/transport/providers/models';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = {
  success: false,
  error: 'Provider model request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Provider models are unavailable',
} as const;

export async function handleProviderModelsRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ProviderModelsTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/provider-models' && req.method === 'GET') {
    if ([...url.searchParams].length !== 0) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport.read(), UNAVAILABLE);
  }

  if (url.pathname === '/api/provider-models/selectable' && req.method === 'GET') {
    const capability = parseCapability(url);
    if (!capability) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport.readSelectable(capability), UNAVAILABLE);
  }

  if (url.pathname === '/api/provider-models/discover' && req.method === 'GET') {
    const accountId = parseAccountId(url);
    if (!accountId) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport.discover(accountId), UNAVAILABLE);
  }

  if (url.pathname === '/api/provider-models/discovery-result' && req.method === 'GET') {
    const callId = url.searchParams.get('callId');
    const accountId = url.searchParams.get('accountId');
    if ([...url.searchParams].length !== 2 || !callId || !/^[a-f0-9]{32}$/.test(callId)
      || !isProviderModelAccountIdentifier(accountId)) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport.readDiscoveryResult(callId, accountId), UNAVAILABLE);
  }

  if (url.pathname !== '/api/provider-models' || req.method !== 'POST') return undefined;

  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    return jsonResult(400, INVALID);
  }
  return deliver(transport.execute(body), UNAVAILABLE);
}

function parseCapability(url: URL): ProviderModelCapability | null {
  const entries = [...url.searchParams];
  if (entries.length !== 1 || entries[0]?.[0] !== 'capability') return null;
  const capability = entries[0][1];
  return isProviderModelCapability(capability) ? capability : null;
}

function parseAccountId(url: URL): string | null {
  const entries = [...url.searchParams];
  if (entries.length !== 1 || entries[0]?.[0] !== 'accountId') return null;
  const accountId = entries[0][1];
  return isProviderModelAccountIdentifier(accountId) ? accountId : null;
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
