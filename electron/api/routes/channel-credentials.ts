import type { IncomingMessage, ServerResponse } from 'http';
import type {
  ChannelCredentialsTransport,
} from '../../main/runtime-host-delivery/transport/channels/credentials';
import { isChannelCredentialsRequest } from '../../main/runtime-host-delivery/transport/channels/credentials';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Channel credentials request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel credentials validation is unavailable',
} as const;

export async function handleChannelCredentialsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelCredentialsTransport,
): Promise<boolean> {
  if ((url.pathname !== '/api/channels/credentials/validate' && url.pathname !== '/api/channels/config/validate')
    || req.method !== 'POST') return false;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isChannelCredentialsRequest(body)) {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    const response = await transport.validate(body);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}
