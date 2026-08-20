import type { IncomingMessage, ServerResponse } from 'http';
import type { ChannelCatalogTransport } from '../../main/runtime-host-delivery/transport/channels/catalog';
import { parseJsonBody, sendJson } from '../route-utils';

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
  values: Record<string, unknown>;
}>;

export async function handleChannelConfigureRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelCatalogTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/channels/configure' || req.method !== 'POST') return false;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    if (isFormRequest(body)) {
      const response = await transport.form(body.channel);
      sendJson(res, response.status, response.body);
      return true;
    }
    if (isApplyRequest(body)) {
      const response = await transport.apply({
        channel: body.channel,
        accountId: body.accountId,
        values: body.values,
      });
      sendJson(res, response.status, response.body);
      return true;
    }
  } catch {
    sendJson(res, 503, UNAVAILABLE);
    return true;
  }

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
  return isRecord(value)
    && Object.keys(value).length === 4
    && value.action === 'apply'
    && isIdentity(value.channel)
    && isIdentity(value.accountId)
    && isRecord(value.values);
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
