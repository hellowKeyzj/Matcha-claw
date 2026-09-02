import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudAccountApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID_LOGIN = {
  success: false,
  error: 'Account login request is invalid',
} as const;
const INVALID_TWO_FACTOR = {
  success: false,
  error: 'Account two-factor login request is invalid',
} as const;
const INVALID_REGISTER = {
  success: false,
  error: 'Account register request is invalid',
} as const;
const INVALID_VERIFY_CODE = {
  success: false,
  error: 'Account verify code request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Cloud account service is unavailable',
} as const;
const BAD_GATEWAY = {
  success: false,
  error: 'Cloud account request failed',
} as const;

type AccountLoginRequest = {
  email: string;
  password: string;
  turnstileToken?: string;
  tencentCaptchaTicket?: string;
  tencentCaptchaRandstr?: string;
};

type AccountTwoFactorLoginRequest = {
  tempToken: string;
  totpCode: string;
};

type AccountRegisterRequest = AccountLoginRequest & {
  verifyCode?: string;
  promoCode?: string;
  invitationCode?: string;
  affCode?: string;
};

type AccountVerifyCodeRequest = {
  email: string;
  turnstileToken?: string;
  tencentCaptchaTicket?: string;
  tencentCaptchaRandstr?: string;
};

export async function handleAccountRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: CloudAccountApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/account/public-settings' && req.method === 'GET') {
    return sendCloudAccountResult(res, ctx, (service) => service.getPublicSettings());
  }

  if (url.pathname === '/api/account/session' && req.method === 'GET') {
    return sendCloudAccountResult(res, ctx, (service) => service.getSession());
  }

  if (url.pathname === '/api/account/login' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody<unknown>(req);
    } catch {
      sendJson(res, 400, INVALID_LOGIN);
      return true;
    }
    const request = toLoginRequest(body);
    if (!request) {
      sendJson(res, 400, INVALID_LOGIN);
      return true;
    }
    return sendCloudAccountResult(res, ctx, (service) => service.login(request));
  }

  if (url.pathname === '/api/account/login/2fa' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody<unknown>(req);
    } catch {
      sendJson(res, 400, INVALID_TWO_FACTOR);
      return true;
    }
    const request = toTwoFactorLoginRequest(body);
    if (!request) {
      sendJson(res, 400, INVALID_TWO_FACTOR);
      return true;
    }
    return sendCloudAccountResult(res, ctx, (service) => service.login2FA(request));
  }

  if (url.pathname === '/api/account/register' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody<unknown>(req);
    } catch {
      sendJson(res, 400, INVALID_REGISTER);
      return true;
    }
    const request = toRegisterRequest(body);
    if (!request) {
      sendJson(res, 400, INVALID_REGISTER);
      return true;
    }
    return sendCloudAccountResult(res, ctx, (service) => service.register(request));
  }

  if (url.pathname === '/api/account/send-verify-code' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody<unknown>(req);
    } catch {
      sendJson(res, 400, INVALID_VERIFY_CODE);
      return true;
    }
    const request = toVerifyCodeRequest(body);
    if (!request) {
      sendJson(res, 400, INVALID_VERIFY_CODE);
      return true;
    }
    return sendCloudAccountResult(res, ctx, (service) => service.sendVerifyCode(request));
  }

  if (url.pathname === '/api/account/refresh' && req.method === 'POST') {
    return sendCloudAccountResult(res, ctx, (service) => service.refreshSession());
  }

  if (url.pathname === '/api/account/logout' && req.method === 'POST') {
    return sendCloudAccountResult(res, ctx, async (service) => {
      await service.logout();
      return { success: true };
    });
  }

  return false;
}

async function sendCloudAccountResult(
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

function toLoginRequest(value: unknown): AccountLoginRequest | null {
  if (!isRecord(value) || !isNonEmptyString(value.email) || !isNonEmptyString(value.password)) return null;

  const turnstileToken = optionalString(value, 'turnstileToken');
  const tencentCaptchaTicket = optionalString(value, 'tencentCaptchaTicket');
  const tencentCaptchaRandstr = optionalString(value, 'tencentCaptchaRandstr');
  if (turnstileToken === null || tencentCaptchaTicket === null || tencentCaptchaRandstr === null) return null;

  const request: AccountLoginRequest = {
    email: value.email,
    password: value.password,
  };
  if (turnstileToken !== undefined) request.turnstileToken = turnstileToken;
  if (tencentCaptchaTicket !== undefined) request.tencentCaptchaTicket = tencentCaptchaTicket;
  if (tencentCaptchaRandstr !== undefined) request.tencentCaptchaRandstr = tencentCaptchaRandstr;
  return request;
}

function toTwoFactorLoginRequest(value: unknown): AccountTwoFactorLoginRequest | null {
  if (!isRecord(value) || !isNonEmptyString(value.tempToken) || !isNonEmptyString(value.code)) return null;
  return {
    tempToken: value.tempToken,
    totpCode: value.code,
  };
}

function toRegisterRequest(value: unknown): AccountRegisterRequest | null {
  const loginRequest = toLoginRequest(value);
  if (!loginRequest || !isRecord(value)) return null;

  const verifyCode = optionalString(value, 'verifyCode');
  const promoCode = optionalString(value, 'promoCode');
  const invitationCode = optionalString(value, 'invitationCode');
  const affCode = optionalString(value, 'affCode');
  if (verifyCode === null || promoCode === null || invitationCode === null || affCode === null) return null;

  const request: AccountRegisterRequest = { ...loginRequest };
  if (verifyCode !== undefined) request.verifyCode = verifyCode;
  if (promoCode !== undefined) request.promoCode = promoCode;
  if (invitationCode !== undefined) request.invitationCode = invitationCode;
  if (affCode !== undefined) request.affCode = affCode;
  return request;
}

function toVerifyCodeRequest(value: unknown): AccountVerifyCodeRequest | null {
  if (!isRecord(value) || !isNonEmptyString(value.email)) return null;

  const turnstileToken = optionalString(value, 'turnstileToken');
  const tencentCaptchaTicket = optionalString(value, 'tencentCaptchaTicket');
  const tencentCaptchaRandstr = optionalString(value, 'tencentCaptchaRandstr');
  if (turnstileToken === null || tencentCaptchaTicket === null || tencentCaptchaRandstr === null) return null;

  const request: AccountVerifyCodeRequest = { email: value.email };
  if (turnstileToken !== undefined) request.turnstileToken = turnstileToken;
  if (tencentCaptchaTicket !== undefined) request.tencentCaptchaTicket = tencentCaptchaTicket;
  if (tencentCaptchaRandstr !== undefined) request.tencentCaptchaRandstr = tencentCaptchaRandstr;
  return request;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined | null {
  if (!Object.hasOwn(value, key) || value[key] === undefined || value[key] === null) return undefined;
  return typeof value[key] === 'string' ? value[key] : null;
}

function statusCodeForServiceError(error: unknown): 400 | 401 | 502 {
  const status = isRecord(error) ? error.status ?? error.statusCode : undefined;
  if (status === 400) return 400;
  if (status === 401 || status === 403) return 401;
  return 502;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
