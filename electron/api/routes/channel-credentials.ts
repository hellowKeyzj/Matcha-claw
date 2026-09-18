import type { IncomingMessage, ServerResponse } from 'http';
import type {
  ChannelCredentialsTransport,
} from '../../main/runtime-host-delivery/transport/channels/credentials';
import { isChannelCredentialsRequest } from '../../main/runtime-host-delivery/transport/channels/credentials';
import { parseJsonBody, sendJson } from '../route-utils';
import { beginChannelTrace, channelTraceError, readChannelTrace } from '../../main/runtime-host-delivery/transport/channels/trace';

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

  const traceId = readChannelTrace(req.headers);
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    beginChannelTrace('route.credentials.invalid', traceId)(400, INVALID);
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isChannelCredentialsRequest(body)) {
    beginChannelTrace('route.credentials.invalid', traceId)(400, INVALID);
    sendJson(res, 400, INVALID);
    return true;
  }

  const finish = beginChannelTrace('route.credentials.validate', traceId);
  try {
    const response = await transport.validate(body, traceId);
    finish(response.status, response.body);
    sendJson(res, response.status, response.body);
  } catch (error) {
    finish(503, UNAVAILABLE, channelTraceError(error));
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}
