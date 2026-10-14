import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const ORIGINATOR = 'codex_cli_rs';

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication successful</title>
</head>
<body>
  <p>Authentication successful. Return to MatchaClaw to continue.</p>
</body>
</html>`;

export interface OpenAICodexOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

interface OpenAICodexAuthorizationFlow {
  verifier: string;
  state: string;
  url: string;
}

interface OpenAICodexLocalServer {
  close: () => Promise<void>;
  waitForCode: () => Promise<{ code: string } | null>;
  waitForCallback: () => Promise<string | undefined>;
}

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function createState(): string {
  return toBase64Url(randomBytes(32));
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) {
    return {};
  }

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }

  return { code: value };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payload = parts[1];
    if (!payload) {
      return null;
    }

    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getAccountIdFromAccessToken(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const authClaims = payload?.[JWT_CLAIM_PATH];
  if (!authClaims || typeof authClaims !== 'object') {
    return null;
  }

  const accountId = (authClaims as Record<string, unknown>).chatgpt_account_id;
  if (typeof accountId !== 'string' || !accountId.trim()) {
    return null;
  }

  return accountId;
}

async function createAuthorizationFlow(): Promise<OpenAICodexAuthorizationFlow> {
  const { verifier, challenge } = createPkce();
  const state = createState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', ORIGINATOR);

  return { verifier, state, url: url.toString() };
}

async function startLocalOAuthServer(state: string, signal?: AbortSignal): Promise<OpenAICodexLocalServer | null> {
  signal?.throwIfAborted();
  let lastCode: string | null = null;
  let resolveCallback!: (code: string | undefined) => void;
  const callback = new Promise<string | undefined>((resolve) => { resolveCallback = resolve; });
  const onCallbackAbort = () => { resolveCallback(undefined); };

  const server = createServer((req, res) => {
    res.setHeader('Connection', 'close');
    try {
      const url = new URL(req.url || '', 'http://localhost');
      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      if (url.searchParams.get('state') !== state) {
        res.statusCode = 400;
        res.end('State mismatch');
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.statusCode = 400;
        res.end('Missing authorization code');
        return;
      }

      lastCode = code;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(SUCCESS_HTML);
      resolveCallback(code);
    } catch {
      res.statusCode = 500;
      res.end('Internal error');
    }
  });

  const close = () => new Promise<void>((resolve) => {
    signal?.removeEventListener('abort', onCallbackAbort);
    resolveCallback(undefined);
    server.close(() => resolve());
    server.closeAllConnections();
  });
  try {
    const listening = await new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        server.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onError = () => { cleanup(); resolve(false); };
      const onAbort = () => { cleanup(); reject(signal?.reason); };
      signal?.addEventListener('abort', onAbort, { once: true });
      server.once('error', onError);
      server.listen({ port: 1455, host: 'localhost', signal }, () => { cleanup(); resolve(true); });
    });
    if (!listening) { await close(); return null; }
    signal?.throwIfAborted();
    signal?.addEventListener('abort', onCallbackAbort, { once: true });
    return {
      close,
      waitForCode: async () => {
        for (let i = 0; i < 600; i += 1) {
          signal?.throwIfAborted();
          if (lastCode) return { code: lastCode };
          await delay(100, undefined, { signal });
        }
        signal?.throwIfAborted();
        return lastCode ? { code: lastCode } : null;
      },
      waitForCallback: async () => {
        signal?.throwIfAborted();
        const code = await callback;
        signal?.throwIfAborted();
        return code;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<{ access: string; refresh: string; expires: number }> {
  signal?.throwIfAborted();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI token exchange failed (${response.status}): ${text}`);
  }

  const json = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error('OpenAI token response missing fields');
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export async function loginOpenAICodexOAuth(options: {
  openUrl: (url: string) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onManualCodeRequired?: (payload: { authorizationUrl: string; reason: 'port_in_use' | 'callback_timeout' }) => void;
  onManualCodeInput?: () => Promise<string>;
}): Promise<OpenAICodexOAuthCredentials> {
  const { signal } = options;
  signal?.throwIfAborted();
  const { verifier, state, url } = await createAuthorizationFlow();
  signal?.throwIfAborted();
  options.onProgress?.('Opening OpenAI sign-in page…');

  const server = await startLocalOAuthServer(state, signal);

  try {
    signal?.throwIfAborted();
    await options.openUrl(url);
    signal?.throwIfAborted();
    options.onProgress?.(
      server ? 'Waiting for OpenAI OAuth callback…' : 'Callback port unavailable, waiting for manual authorization code…',
    );

    let code: string | undefined;
    if (server) {
      const result = await server.waitForCode();
      signal?.throwIfAborted();
      code = result?.code ?? undefined;
      if (!code && options.onManualCodeInput) {
        options.onManualCodeRequired?.({ authorizationUrl: url, reason: 'callback_timeout' });
        signal?.throwIfAborted();
        code = await Promise.race([server.waitForCallback(), options.onManualCodeInput()]);
      }
    } else {
      if (!options.onManualCodeInput) {
        throw new Error('Cannot start OpenAI OAuth callback server on localhost:1455');
      }
      options.onManualCodeRequired?.({ authorizationUrl: url, reason: 'port_in_use' });
      signal?.throwIfAborted();
      code = await options.onManualCodeInput();
    }
    signal?.throwIfAborted();

    if (!code) {
      throw new Error('Missing OpenAI authorization code');
    }

    const parsed = parseAuthorizationInput(code);
    if (parsed.state && parsed.state !== state) {
      throw new Error('OpenAI OAuth state mismatch');
    }
    code = parsed.code;

    if (!code) {
      throw new Error('Missing OpenAI authorization code');
    }

    const token = await exchangeAuthorizationCode(code, verifier, signal);
    signal?.throwIfAborted();
    const accountId = getAccountIdFromAccessToken(token.access);
    if (!accountId) {
      throw new Error('Failed to extract OpenAI accountId from token');
    }

    return {
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
      accountId,
    };
  } finally {
    await server?.close();
  }
}
