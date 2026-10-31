import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { traceDebug } from '../utils/trace-logger';
import {
  isWorldCredentialIdentity, type resolveWorldSourceCredential, WorldSourceCredentialError,
} from '../main/world/source-credentials';

const MAX_PRIVATE_REQUEST_BYTES = 1024;
const MAX_PRIVATE_BODY_BYTES = 1024 * 1024;
const MAX_PRIVATE_RESOLVER_REQUESTS = 64;

type PrivateCredentialResponse = Readonly<{
  status: number;
  body?: unknown;
  noStore?: boolean;
}>;

export type PrivateCredentialResolver = Readonly<{
  endpoint: string;
  authorization: string;
  close: () => Promise<void>;
}>;

type ResolveProviderCredential = (
  method: string, body: Record<string, unknown> | undefined,
) => Promise<PrivateCredentialResponse>;

async function resolveWorldCredential(
  method: string, body: Record<string, unknown>, resolveWorldSource: typeof resolveWorldSourceCredential,
): Promise<PrivateCredentialResponse> {
  const identity = { world: body.world, connectionId: body.connectionId, revision: body.revision };
  if (method !== 'POST' || Object.keys(body).sort().join(',') !== 'connectionId,operation,revision,world'
    || !isWorldCredentialIdentity(identity)) {
    return { status: 400, body: { error: 'invalid-request' } };
  }
  try {
    return { status: 200, body: await resolveWorldSource(identity), noStore: true };
  } catch (error) {
    const code = error instanceof WorldSourceCredentialError ? error.code : 'credential-store-unavailable';
    return { status: code === 'credential-missing' ? 404 : 503, body: { error: code }, noStore: true };
  }
}

export async function startPrivateCredentialResolver(
  resolveProviderCredential: ResolveProviderCredential, resolveWorldSource: typeof resolveWorldSourceCredential,
): Promise<PrivateCredentialResolver> {
  const authorization = randomBytes(32).toString('base64url');
  const requests = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if ((request.method !== 'POST' && request.method !== 'DELETE' && request.method !== 'PUT')
      || request.url !== '/resolve'
      || !authorized(request.headers.authorization, authorization)) {
      if (request.method === 'POST') {
        traceDebug(() => JSON.stringify({
          prefix: 'session-trace', source: 'electron-main',
          stage: 'electron.private-credential.resolve.result', at: Date.now(),
          outcome: 'route-rejected', status: 404,
        }));
      }
      response.writeHead(404).end();
      return;
    }
    const body = await readBoundedBody(request);
    const result = body?.operation === 'source.resolve'
      ? await resolveWorldCredential(request.method, body, resolveWorldSource)
      : await resolveProviderCredential(request.method, body);
    sendPrivateCredentialResponse(response, result);
  };
  const server = createServer((request, response) => {
    if (closing || requests.size >= MAX_PRIVATE_RESOLVER_REQUESTS) {
      sendPrivateCredentialResponse(response, { status: 503, body: { error: 'auth-profile-write-failed' } });
      request.resume();
      return;
    }
    // A disconnected observer does not cancel an admitted SQLite side effect.
    const pending = handleRequest(request, response).catch(() => {
      if (!response.headersSent) sendPrivateCredentialResponse(response, { status: 503, body: { error: 'unknown' } });
    });
    requests.add(pending);
    void pending.then(() => { requests.delete(pending); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Provider credential storage is unavailable');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/resolve`,
    authorization,
    close: () => {
      closing ??= (async () => {
        await closeServer(server);
        await Promise.all(requests);
      })();
      return closing;
    },
  };
}

function sendPrivateCredentialResponse(response: ServerResponse, result: PrivateCredentialResponse): void {
  const headers = result.body === undefined ? {} : { 'content-type': 'application/json' };
  response.writeHead(result.status, { ...headers, ...(result.noStore ? { 'cache-control': 'no-store' } : {}) })
    .end(result.body === undefined ? undefined : JSON.stringify(result.body));
}

function authorized(value: string | undefined, expected: string): boolean {
  if (!value?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(value.slice('Bearer '.length));
  const expectedBytes = Buffer.from(expected);
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

async function readBoundedBody(request: NodeJS.ReadableStream): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_PRIVATE_BODY_BYTES) return undefined;
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (length > MAX_PRIVATE_REQUEST_BYTES && (!isRecord(value) || value.operation !== 'recover')) return undefined;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
