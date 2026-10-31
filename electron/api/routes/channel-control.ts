import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type { ChannelControlTransport } from '../../main/runtime-host-delivery/transport/channels/control';
import { isProductRuntimeScope, type ProductRuntimeScope } from '../../main/runtime-host-delivery/transport/runtime-scope';

const INVALID = {
  success: false,
  error: 'Channel control request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel control is unavailable',
} as const;

type RequestBody = Readonly<{
  action: 'connect' | 'disconnect';
  channel: string;
  accountId: string;
  scope?: ProductRuntimeScope;
}>;

export async function handleChannelControlRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ChannelControlTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/channels/control' || req.method !== 'POST') return undefined;

  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    return jsonResult(400, INVALID);
  }
  if (!isRequest(body)) {
    return jsonResult(400, INVALID);
  }

  try {
    const response = await transport.control(body);
    return jsonResult(response.status,
      (body.action === 'connect' && response.status === 200)
        || (body.action === 'disconnect' && response.status === 202) ? response.body : UNAVAILABLE);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function isRequest(value: unknown): value is RequestBody {
  if (!isRecord(value)) return false;
  return Object.keys(value).every((key) => ['action', 'channel', 'accountId', 'scope'].includes(key))
    && (!Object.hasOwn(value, 'scope') || isProductRuntimeScope(value.scope))
    && (value.action === 'connect' || value.action === 'disconnect')
    && isIdentity(value.channel)
    && isIdentity(value.accountId);
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
