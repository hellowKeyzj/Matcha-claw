import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudAccountApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID_ORDER = {
  success: false,
  error: 'Billing order request is invalid',
} as const;
const INVALID_VERIFY = {
  success: false,
  error: 'Billing order verification request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Cloud billing service is unavailable',
} as const;
const BAD_GATEWAY = {
  success: false,
  error: 'Cloud billing request failed',
} as const;

type CreatePaymentOrderRequest = {
  amount: number;
  paymentType: string;
  orderType: string;
  planId?: number;
  returnUrl?: string;
  paymentSource?: string;
  openid?: string;
  wechatResumeToken?: string;
  isMobile?: boolean;
};

export async function handleBillingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: CloudAccountApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/billing/checkout-info' && req.method === 'GET') {
    return sendBillingResult(res, ctx, (service) => service.getCheckoutInfo());
  }

  if (url.pathname === '/api/billing/plans' && req.method === 'GET') {
    return sendBillingResult(res, ctx, (service) => service.getPlans());
  }

  if (url.pathname === '/api/billing/orders' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody<unknown>(req);
    } catch {
      sendJson(res, 400, INVALID_ORDER);
      return true;
    }
    const request = toCreatePaymentOrderRequest(body);
    if (!request) {
      sendJson(res, 400, INVALID_ORDER);
      return true;
    }
    return sendBillingResult(res, ctx, (service) => service.createPaymentOrder(request));
  }

  if (url.pathname === '/api/billing/orders/verify' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody<unknown>(req);
    } catch {
      sendJson(res, 400, INVALID_VERIFY);
      return true;
    }
    if (!isRecord(body) || !isNonEmptyString(body.outTradeNo)) {
      sendJson(res, 400, INVALID_VERIFY);
      return true;
    }
    return sendBillingResult(res, ctx, (service) => service.verifyPaymentOrder(body.outTradeNo));
  }

  const orderId = matchOrderId(url.pathname);
  if (orderId !== null && req.method === 'GET') {
    return sendBillingResult(res, ctx, (service) => service.getPaymentOrder(orderId));
  }

  return false;
}

async function sendBillingResult(
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

function toCreatePaymentOrderRequest(value: unknown): CreatePaymentOrderRequest | null {
  if (!isRecord(value)
    || !isFiniteNumber(value.amount)
    || !isNonEmptyString(value.paymentType)
    || !isNonEmptyString(value.orderType)) {
    return null;
  }

  const planId = optionalNumber(value, 'planId');
  const returnUrl = optionalString(value, 'returnUrl');
  const paymentSource = optionalString(value, 'paymentSource');
  const openid = optionalString(value, 'openid');
  const wechatResumeToken = optionalString(value, 'wechatResumeToken');
  const isMobile = optionalBoolean(value, 'isMobile');
  if (planId === null
    || returnUrl === null
    || paymentSource === null
    || openid === null
    || wechatResumeToken === null
    || isMobile === null) {
    return null;
  }

  const request: CreatePaymentOrderRequest = {
    amount: value.amount,
    paymentType: value.paymentType,
    orderType: value.orderType,
  };
  if (planId !== undefined) request.planId = planId;
  if (returnUrl !== undefined) request.returnUrl = returnUrl;
  if (paymentSource !== undefined) request.paymentSource = paymentSource;
  if (openid !== undefined) request.openid = openid;
  if (wechatResumeToken !== undefined) request.wechatResumeToken = wechatResumeToken;
  if (isMobile !== undefined) request.isMobile = isMobile;
  return request;
}

function matchOrderId(pathname: string): number | null {
  const match = pathname.match(/^\/api\/billing\/orders\/([^/]+)$/);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!/^\d+$/.test(decoded)) return null;
  const orderId = Number(decoded);
  return Number.isSafeInteger(orderId) && orderId > 0 ? orderId : null;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined | null {
  if (!Object.hasOwn(value, key) || value[key] === undefined || value[key] === null) return undefined;
  return typeof value[key] === 'string' ? value[key] : null;
}

function optionalNumber(value: Record<string, unknown>, key: string): number | undefined | null {
  if (!Object.hasOwn(value, key) || value[key] === undefined || value[key] === null) return undefined;
  return isFiniteNumber(value[key]) ? value[key] : null;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined | null {
  if (!Object.hasOwn(value, key) || value[key] === undefined || value[key] === null) return undefined;
  return typeof value[key] === 'boolean' ? value[key] : null;
}

function statusCodeForServiceError(error: unknown): 400 | 401 | 502 {
  const status = isRecord(error) ? error.status ?? error.statusCode : undefined;
  if (status === 400 || status === 404) return 400;
  if (status === 401 || status === 403) return 401;
  return 502;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
