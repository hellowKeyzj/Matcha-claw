import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudAccountApiContext } from '../context';
import { sendJson } from '../route-utils';

const UNAVAILABLE = {
  success: false,
  error: 'Cloud subscription service is unavailable',
} as const;
const BAD_GATEWAY = {
  success: false,
  error: 'Cloud subscription request failed',
} as const;

export async function handleSubscriptionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: CloudAccountApiContext,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  if (url.pathname === '/api/subscription/summary') {
    return sendSubscriptionResult(res, ctx, (service) => service.getSubscriptionSummary());
  }

  if (url.pathname === '/api/subscription/active') {
    return sendSubscriptionResult(res, ctx, (service) => service.getActiveSubscriptions());
  }

  if (url.pathname === '/api/subscription/progress') {
    return sendSubscriptionResult(res, ctx, (service) => service.getSubscriptionProgress());
  }

  if (url.pathname === '/api/subscription/platform-quotas') {
    return sendSubscriptionResult(res, ctx, (service) => service.getPlatformQuotas());
  }

  return false;
}

async function sendSubscriptionResult(
  res: ServerResponse,
  ctx: CloudAccountApiContext,
  execute: (service: NonNullable<CloudAccountApiContext['cloudAccountService']>) => Promise<unknown>,
): Promise<true> {
  const service = ctx.cloudAccountService;
  if (!service) {
    sendJson(res, 503, UNAVAILABLE);
    return true;
  }

  try {
    sendJson(res, 200, await execute(service));
  } catch (error) {
    sendJson(res, statusCodeForServiceError(error), BAD_GATEWAY);
  }
  return true;
}

function statusCodeForServiceError(error: unknown): 401 | 502 {
  const status = isRecord(error) ? error.status ?? error.statusCode : undefined;
  return status === 401 || status === 403 ? 401 : 502;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
