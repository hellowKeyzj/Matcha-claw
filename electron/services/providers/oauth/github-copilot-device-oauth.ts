import { setTimeout as delay } from 'node:timers/promises';

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const VERIFICATION_URI = 'https://github.com/login/device';

async function postGitHubForm(
  path: string,
  body: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const response = await fetch(`https://github.com${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub device login failed (HTTP ${response.status}). Please retry login.`);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GitHub device login returned an invalid response. Please retry login.');
  }
  return payload as Record<string, unknown>;
}

export async function loginGitHubCopilotDeviceOAuth(options: {
  openUrl: (url: string) => Promise<void>;
  onVerification: (info: { verificationUri: string; userCode: string; expiresIn: number }) => void;
  signal: AbortSignal;
}): Promise<{ token: string }> {
  const device = await postGitHubForm('/login/device/code', {
    client_id: CLIENT_ID,
    scope: 'read:user',
  }, options.signal);
  const expiresIn = Number(device.expires_in);
  const interval = device.interval === undefined ? 5 : Number(device.interval);
  if (typeof device.device_code !== 'string' || !device.device_code.trim()
    || typeof device.user_code !== 'string' || !device.user_code.trim() || device.user_code.length > 64
    || typeof device.verification_uri !== 'string'
    || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn * 1000 > 2_147_483_647
    || !Number.isFinite(interval) || interval < 0) {
    throw new Error('GitHub device code response is incomplete. Please retry login.');
  }
  let verificationUrl: URL;
  try {
    verificationUrl = new URL(device.verification_uri);
  } catch {
    throw new Error('GitHub returned an invalid verification URL. Please retry login.');
  }
  if (verificationUrl.origin !== 'https://github.com' || verificationUrl.pathname !== '/login/device'
    || verificationUrl.username || verificationUrl.password) {
    throw new Error('GitHub returned an unexpected verification URL. Please retry login.');
  }
  const deadline = Date.now() + expiresIn * 1000;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.ceil(expiresIn * 1000))]);
  let intervalMs = Math.max(1000, interval * 1000);
  signal.throwIfAborted();
  options.onVerification({ verificationUri: VERIFICATION_URI, userCode: device.user_code.trim(), expiresIn });
  signal.throwIfAborted();
  await options.openUrl(VERIFICATION_URI);

  while (Date.now() < deadline) {
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())), undefined, { signal });
    if (Date.now() >= deadline) break;
    const result = await postGitHubForm('/login/oauth/access_token', {
      client_id: CLIENT_ID,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, signal);
    if (typeof result.access_token === 'string' && result.access_token.trim()) {
      signal.throwIfAborted();
      return { token: result.access_token.trim() };
    }
    switch (result.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down': {
        const requestedInterval = Number(result.interval);
        intervalMs = Math.max(intervalMs + 5000,
          Number.isFinite(requestedInterval) && requestedInterval > 0 ? requestedInterval * 1000 : 0);
        continue;
      }
      case 'expired_token':
        throw new Error('GitHub device code expired. Please restart login.');
      case 'access_denied':
        throw new Error('GitHub authorization was denied. Please restart login to approve access.');
      default:
        throw new Error('GitHub device authorization failed. Please retry login.');
    }
  }
  signal.throwIfAborted();
  throw new Error('GitHub device code expired. Please restart login.');
}
