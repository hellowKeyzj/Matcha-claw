import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type {
  ChannelCredentialsTransport,
} from '../../main/runtime-host-delivery/transport/channels/credentials';
import { isChannelCredentialsRequest } from '../../main/runtime-host-delivery/transport/channels/credentials';
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
  req: HostApiRequest,
  url: URL,
  transport: ChannelCredentialsTransport,
): Promise<HostApiRouteResult> {
  if ((url.pathname !== '/api/channels/credentials/validate' && url.pathname !== '/api/channels/config/validate')
    || req.method !== 'POST') return undefined;

  const traceId = readChannelTrace(req.headers);
  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    beginChannelTrace('route.credentials.invalid', traceId)?.(400, INVALID);
    return jsonResult(400, INVALID);
  }
  if (!isChannelCredentialsRequest(body)) {
    beginChannelTrace('route.credentials.invalid', traceId)?.(400, INVALID);
    return jsonResult(400, INVALID);
  }

  const finish = beginChannelTrace('route.credentials.validate', traceId);
  try {
    const response = await transport.validate(body, traceId);
    finish?.(response.status, response.body);
    return jsonResult(response.status, response.body);
  } catch (error) {
    finish?.(503, UNAVAILABLE, channelTraceError(error));
    return jsonResult(503, UNAVAILABLE);
  }
}
