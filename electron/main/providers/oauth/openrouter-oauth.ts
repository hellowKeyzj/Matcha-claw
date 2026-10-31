import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const CALLBACK_URI = 'http://localhost:3000/openrouter-oauth/callback';

async function receiveAuthorizationCode(options: {
  authorizeUrl: string;
  state: string;
  openUrl: (url: string) => Promise<void>;
  signal: AbortSignal;
}): Promise<string> {
  const { signal } = options;
  signal.throwIfAborted();
  const server = createServer();
  let onAbort: () => void = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      server.on('error', () => {
        reject(new Error('Cannot listen for OpenRouter login on localhost:3000. Close the conflicting app and retry.'));
      });
      server.on('request', (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Connection', 'close');
        let callback: URL;
        try {
          callback = new URL(request.url ?? '', CALLBACK_URI);
        } catch {
          response.writeHead(400).end('Invalid callback.');
          return;
        }
        if (request.method !== 'GET' || callback.pathname !== '/openrouter-oauth/callback') {
          response.writeHead(404).end('Not found.');
          return;
        }
        if (callback.searchParams.get('state') !== options.state) {
          response.writeHead(400).end('Invalid state. Return to MatchaClaw and retry login.');
          return;
        }
        if (callback.searchParams.has('error')) {
          response.writeHead(400).end('Authorization declined. Return to MatchaClaw.');
          reject(new Error('OpenRouter authorization was declined. Please retry login.'));
          return;
        }
        const code = callback.searchParams.get('code')?.trim();
        if (!code) {
          response.writeHead(400).end('Missing authorization code.');
          return;
        }
        response.end('Authentication successful. Return to MatchaClaw to continue.', () => resolve(code));
      });
      server.listen({ host: 'localhost', port: 3000, signal }, () => {
        if (signal.aborted) return;
        void options.openUrl(options.authorizeUrl).catch(() => {
          reject(new Error('Cannot open the OpenRouter sign-in page. Please retry login.'));
        });
      });
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

export async function loginOpenRouterOAuth(options: {
  openUrl: (url: string) => Promise<void>;
  signal: AbortSignal;
}): Promise<{ key: string }> {
  options.signal.throwIfAborted();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const callback = new URL(CALLBACK_URI);
  callback.searchParams.set('state', state);
  const authorize = new URL('https://openrouter.ai/auth');
  authorize.searchParams.set('callback_url', callback.toString());
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  const code = await receiveAuthorizationCode({
    authorizeUrl: authorize.toString(),
    state,
    openUrl: options.openUrl,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(5 * 60_000)]),
  });
  options.signal.throwIfAborted();
  const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    redirect: 'error',
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenRouter key exchange failed (HTTP ${response.status}). Please retry login.`);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || !('key' in payload)
    || typeof payload.key !== 'string' || !payload.key.trim()) {
    throw new Error('OpenRouter key exchange returned no API key. Please retry login.');
  }
  options.signal.throwIfAborted();
  return { key: payload.key.trim() };
}
