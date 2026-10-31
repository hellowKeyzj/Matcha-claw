import type { CloudAccountApiContext } from '../context';
import { jsonResult, type HostApiRequest, type HostApiResponse, type HostApiRouteResult } from '../execution';

const UNAVAILABLE = {
  success: false,
  error: 'Cloud subscription service is unavailable',
} as const;
const BAD_GATEWAY = {
  success: false,
  error: 'Cloud subscription request failed',
} as const;

export async function handleSubscriptionRoutes(
  req: HostApiRequest,
  url: URL,
  ctx: CloudAccountApiContext,
): Promise<HostApiRouteResult> {
  if (req.method !== 'GET') return undefined;

  if (url.pathname === '/api/subscription/summary') {
    return sendSubscriptionResult(ctx, (service) => service.getSubscriptionSummary());
  }

  if (url.pathname === '/api/subscription/active') {
    return sendSubscriptionResult(ctx, (service) => service.getActiveSubscriptions());
  }

  if (url.pathname === '/api/subscription/progress') {
    return sendSubscriptionResult(ctx, (service) => service.getSubscriptionProgress());
  }

  if (url.pathname === '/api/subscription/platform-quotas') {
    return sendSubscriptionResult(ctx, (service) => service.getPlatformQuotas());
  }

  return undefined;
}

async function sendSubscriptionResult(
  ctx: CloudAccountApiContext,
  execute: (service: NonNullable<CloudAccountApiContext['cloudAccountService']>) => Promise<unknown>,
): Promise<HostApiResponse> {
  const service = ctx.cloudAccountService;
  if (!service) {
    return jsonResult(503, UNAVAILABLE);
  }

  try {
    return jsonResult(200, await execute(service));
  } catch (error) {
    return jsonResult(statusCodeForServiceError(error), BAD_GATEWAY);
  }
}

function statusCodeForServiceError(error: unknown): 401 | 502 {
  const status = isRecord(error) ? error.status ?? error.statusCode : undefined;
  return status === 401 || status === 403 ? 401 : 502;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
