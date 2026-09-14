import type { IncomingMessage, ServerResponse } from 'http';
import type { ChannelCatalogTransport } from '../../main/runtime-host-delivery/transport/channels/catalog';
import { parseJsonBody, sendJson } from '../route-utils';
import { beginChannelTrace, channelTraceError, readChannelTrace } from '../../main/runtime-host-delivery/transport/channels/catalog';

const INVALID = {
  success: false,
  error: 'Channel configuration request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel configuration is unavailable',
} as const;

type FormRequest = Readonly<{ action: 'form'; channel: string }>;
type ApplyRequest = Readonly<{
  action: 'apply';
  channel: string;
  accountId: string;
  agentId?: string;
  values: Record<string, unknown>;
}>;

export async function handleChannelConfigureRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelCatalogTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/channels/configure' || req.method !== 'POST') return false;

  const traceId = readChannelTrace(req.headers);
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    beginChannelTrace('route.invalid', traceId)(400, { outcome: 'rejected' });
    sendJson(res, 400, INVALID);
    return true;
  }

  const finish = beginChannelTrace(isApplyRequest(body) ? 'route.configure.apply' : 'route.configure.form', traceId);
  try {
    if (isFormRequest(body)) {
      const response = await transport.form(body.channel, traceId);
      finish(response.status, response.body);
      sendJson(res, response.status, response.body);
      return true;
    }
    if (isApplyRequest(body)) {
      const response = await transport.apply({
        channel: body.channel,
        accountId: body.accountId,
        ...(body.agentId ? { agentId: body.agentId } : {}),
        values: body.values,
      }, traceId);
      finish(response.status, response.body);
      sendJson(res, response.status, response.body);
      return true;
    }
  } catch (error) {
    finish(503, UNAVAILABLE, channelTraceError(error));
    sendJson(res, 503, UNAVAILABLE);
    return true;
  }

  finish(400, { outcome: 'rejected' });
  sendJson(res, 400, INVALID);
  return true;
}

function isFormRequest(value: unknown): value is FormRequest {
  return isRecord(value)
    && Object.keys(value).length === 2
    && value.action === 'form'
    && isIdentity(value.channel);
}

function isApplyRequest(value: unknown): value is ApplyRequest {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length >= 4
    && keys.length <= 5
    && keys.every((key) => ['action', 'channel', 'accountId', 'agentId', 'values'].includes(key))
    && value.action === 'apply'
    && isIdentity(value.channel)
    && isIdentity(value.accountId)
    && (value.agentId === undefined || isIdentity(value.agentId))
    && isRecord(value.values);
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
