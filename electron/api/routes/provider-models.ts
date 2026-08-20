import type { IncomingMessage, ServerResponse } from 'http';
import type {
  ProviderModelCapability,
  ProviderModelsTransport,
} from '../../main/runtime-host-delivery/transport/providers/models';
import { isProviderModelCapability } from '../../main/runtime-host-delivery/transport/providers/models';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Provider model request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Provider models are unavailable',
} as const;

export async function handleProviderModelsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ProviderModelsTransport,
): Promise<boolean> {
  if (url.pathname === '/api/provider-models' && req.method === 'GET') {
    if ([...url.searchParams].length !== 0) {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(res, transport.read(), UNAVAILABLE);
    return true;
  }

  if (url.pathname === '/api/provider-models/selectable' && req.method === 'GET') {
    const capability = parseCapability(url);
    if (!capability) {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(res, transport.readSelectable(capability), UNAVAILABLE);
    return true;
  }

  if (url.pathname !== '/api/provider-models' || req.method !== 'POST') return false;

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

function parseCapability(url: URL): ProviderModelCapability | null {
  const entries = [...url.searchParams];
  if (entries.length !== 1 || entries[0]?.[0] !== 'capability') return null;
  const capability = entries[0][1];
  return isProviderModelCapability(capability) ? capability : null;
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
