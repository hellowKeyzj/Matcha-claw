import { setTimeout as delay } from 'node:timers/promises';

const AUTH_URL = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const EXPIRES_IN = 15 * 60;

export interface OpenAIDeviceOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('OpenAI device login returned an invalid response. Please retry login.');
  }
  return payload as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readAccessClaims(access: string): { expires?: number; accountId?: string } {
  try {
    const payload = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'));
    const accountId = readString(payload?.['https://api.openai.com/auth']?.chatgpt_account_id);
    const expires = typeof payload?.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000 : undefined;
    return { expires, accountId };
  } catch {
    return {};
  }
}

async function postDeviceRequest(
  path: string,
  body: Record<string, string> | URLSearchParams,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  return fetch(`${AUTH_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': body instanceof URLSearchParams
        ? 'application/x-www-form-urlencoded' : 'application/json',
      Accept: 'application/json',
    },
    body: body instanceof URLSearchParams ? body : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
}

export async function loginOpenAIDeviceOAuth(options: {
  openUrl: (url: string) => Promise<void>;
  onVerification: (info: { verificationUri: string; userCode: string; expiresIn: number }) => void;
  signal: AbortSignal;
}): Promise<OpenAIDeviceOAuthCredentials> {
  const response = await postDeviceRequest('/api/accounts/deviceauth/usercode', {
    client_id: CLIENT_ID,
  }, options.signal);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenAI device code request failed (HTTP ${response.status}). Please retry login.`);
  }
  const device = await readPayload(response);
  const deviceAuthId = readString(device.device_auth_id);
  const userCode = readString(device.user_code) ?? readString(device.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error('OpenAI device code response is incomplete. Please retry login.');
  }
  const intervalSeconds = Number(device.interval);
  const intervalMs = Number.isFinite(intervalSeconds) && intervalSeconds > 0
    ? Math.max(1000, Math.min(intervalSeconds * 1000, EXPIRES_IN * 1000)) : 5000;
  const deadline = Date.now() + EXPIRES_IN * 1000;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(EXPIRES_IN * 1000)]);
  const verificationUri = `${AUTH_URL}/codex/device`;
  signal.throwIfAborted();
  options.onVerification({ verificationUri, userCode, expiresIn: EXPIRES_IN });
  signal.throwIfAborted();
  await options.openUrl(verificationUri);

  while (Date.now() < deadline) {
    const poll = await postDeviceRequest('/api/accounts/deviceauth/token', {
      device_auth_id: deviceAuthId,
      user_code: userCode,
    }, signal);
    if (poll.status === 403 || poll.status === 404) {
      await poll.body?.cancel();
      await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())), undefined, { signal });
      continue;
    }
    if (!poll.ok) {
      await poll.body?.cancel();
      throw new Error(`OpenAI device authorization failed (HTTP ${poll.status}). Please retry login.`);
    }
    const authorization = await readPayload(poll);
    const code = readString(authorization.authorization_code);
    const verifier = readString(authorization.code_verifier);
    if (!code || !verifier) {
      throw new Error('OpenAI device authorization returned no exchange code. Please retry login.');
    }
    const exchange = await postDeviceRequest('/oauth/token', new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: `${AUTH_URL}/deviceauth/callback`,
    }), signal);
    if (!exchange.ok) {
      await exchange.body?.cancel();
      throw new Error(`OpenAI token exchange failed (HTTP ${exchange.status}). Please retry login.`);
    }
    const token = await readPayload(exchange);
    const access = readString(token.access_token);
    const refresh = readString(token.refresh_token);
    if (!access || !refresh) {
      throw new Error('OpenAI token exchange returned incomplete credentials. Please retry login.');
    }
    const claims = readAccessClaims(access);
    const duration = Number(token.expires_in);
    const expires = Number.isFinite(duration) && duration > 0
      ? Date.now() + duration * 1000 : claims.expires ?? Date.now();
    signal.throwIfAborted();
    return { access, refresh, expires, ...(claims.accountId ? { accountId: claims.accountId } : {}) };
  }
  signal.throwIfAborted();
  throw new Error('OpenAI device code expired. Please restart login.');
}
