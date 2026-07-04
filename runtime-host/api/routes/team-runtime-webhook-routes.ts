import { sendJson, type RuntimeHttpResponsePort } from '../common/http';
import type { TeamRuntimePort } from '../../application/team-runtime/team-runtime-port';

const TEAM_WEBHOOK_ROUTE_PREFIX = '/api/team-runtime/webhooks';
const MAX_TEAM_WEBHOOK_BODY_BYTES = 64 * 1024;
const TEAM_WEBHOOK_TRIGGER_FIRE_OPERATION_ID = 'team.webhookTriggerFire' as Parameters<TeamRuntimePort['invoke']>[0];

interface TeamRuntimeWebhookDeps {
  readonly token: string | (() => string | Promise<string>);
  readonly teamRuntimeService: TeamRuntimePort;
  readonly isWebhookTokenAuthorized: (actualToken: string, expectedToken: string) => boolean;
  readonly createWebhookBodyHasher: () => { update: (chunk: Uint8Array) => void; digest: () => string };
  readonly createWebhookRequestId: () => string;
}

type RuntimeHttpRequestPort = {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Record<string, string | readonly string[] | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
};

type BoundedBodyResult =
  | { resultType: 'success'; totalBytes: number; deterministicBodyHash: string; bodyText: string }
  | { resultType: 'too_large' };

export function isTeamRuntimeWebhookPath(pathname: string): boolean {
  return pathname === TEAM_WEBHOOK_ROUTE_PREFIX || pathname.startsWith(`${TEAM_WEBHOOK_ROUTE_PREFIX}/`);
}

export function createTeamRuntimeWebhookHandler(deps: TeamRuntimeWebhookDeps) {
  return async (req: RuntimeHttpRequestPort, res: RuntimeHttpResponsePort): Promise<void> => {
    const token = (await resolveToken(deps.token)).trim();
    if (!token) {
      writeNotFound(res);
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { success: false, error: 'TeamRun webhook only accepts POST requests.' });
      return;
    }

    if (!isAuthorized(req, token, deps.isWebhookTokenAuthorized)) {
      sendJson(res, 401, { success: false, error: 'TeamRun webhook token is required.' });
      return;
    }

    const webhookPath = readWebhookPath(req.url ?? '');
    if (!webhookPath) {
      sendJson(res, 404, { success: false, error: 'TeamRun webhook path is required.' });
      return;
    }

    const body = await readBoundedBody(req, MAX_TEAM_WEBHOOK_BODY_BYTES, deps.createWebhookBodyHasher());
    if (body.resultType === 'too_large') {
      sendJson(res, 413, { success: false, error: `TeamRun webhook body exceeds ${MAX_TEAM_WEBHOOK_BODY_BYTES} bytes.` });
      return;
    }

    const idempotencyKey = readIdempotencyKey(req) ?? deps.createWebhookRequestId();
    const contentType = readHeader(req, 'content-type').trim();
    const fireResponse = await deps.teamRuntimeService.invoke(TEAM_WEBHOOK_TRIGGER_FIRE_OPERATION_ID, {
      webhookPath,
      headers: readSanitizedWebhookHeaders(req),
      idempotencyKey,
      deterministicBodyHash: body.deterministicBodyHash,
      payload: buildWebhookPayloadProjection({ contentType, bodyText: body.bodyText, bodyHash: body.deterministicBodyHash }),
      ...(body.totalBytes > 0 ? { payloadSummary: `body:${body.totalBytes} bytes` } : {}),
    }, {
      kind: 'runtime-instance',
      endpoint: { kind: 'native-runtime', runtimeAdapterId: 'runtime-host', runtimeInstanceId: 'local' },
    });

    sendJson(res, fireResponse.status === 200 ? 202 : fireResponse.status, fireResponse.data);
  };
}

async function resolveToken(token: TeamRuntimeWebhookDeps['token']): Promise<string> {
  return typeof token === 'function' ? await token() : token;
}

function readHeader(req: RuntimeHttpRequestPort, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] ?? '' : '';
}

function isAuthorized(
  req: RuntimeHttpRequestPort,
  expectedToken: string,
  isWebhookTokenAuthorized: TeamRuntimeWebhookDeps['isWebhookTokenAuthorized'],
): boolean {
  const authorization = readHeader(req, 'authorization');
  const bearerToken = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  const headerToken = readHeader(req, 'x-matchaclaw-webhook-token').trim();
  return isWebhookTokenAuthorized(bearerToken || headerToken, expectedToken.trim());
}

function readWebhookPath(rawUrl: string): string | null {
  const pathname = safePathname(rawUrl);
  if (!pathname.startsWith(`${TEAM_WEBHOOK_ROUTE_PREFIX}/`)) return null;
  const suffix = pathname.slice(TEAM_WEBHOOK_ROUTE_PREFIX.length + 1);
  return safeDecodePath(suffix);
}

function safePathname(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
}

function safeDecodePath(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded ? decoded : null;
  } catch {
    return null;
  }
}

async function readBoundedBody(
  req: RuntimeHttpRequestPort,
  maxBytes: number,
  bodyHash: { update: (chunk: Uint8Array) => void; digest: () => string },
): Promise<BoundedBodyResult> {
  const contentLength = Number.parseInt(readHeader(req, 'content-length'), 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { resultType: 'too_large' };
  }

  let totalBytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = toBuffer(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      return { resultType: 'too_large' };
    }
    bodyHash.update(buffer);
    chunks.push(buffer);
  }
  return { resultType: 'success', totalBytes, deterministicBodyHash: bodyHash.digest(), bodyText: Buffer.concat(chunks).toString('utf8') };
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function readSanitizedWebhookHeaders(req: RuntimeHttpRequestPort): Record<string, string> {
  return Object.fromEntries([
    'content-type',
    'user-agent',
    'x-request-id',
    'x-idempotency-key',
  ].flatMap((name) => {
    const value = readHeader(req, name).trim();
    return value ? [[name, value.slice(0, 500)]] : [];
  }));
}

function readIdempotencyKey(req: RuntimeHttpRequestPort): string | null {
  const value = readHeader(req, 'x-idempotency-key').trim();
  return value ? value.slice(0, 200) : null;
}

function buildWebhookPayloadProjection(input: { contentType: string; bodyText: string; bodyHash: string }): Record<string, unknown> {
  const projection: Record<string, unknown> = {
    contentType: input.contentType,
    bodyHash: input.bodyHash,
  };
  if (input.bodyText) {
    projection.bodyText = redactWebhookSecretText(input.bodyText);
    const parsedJson = parseJsonBody(input.contentType, input.bodyText);
    if (parsedJson !== undefined) {
      projection.bodyJson = redactWebhookJsonSecrets(parsedJson);
    }
  }
  return projection;
}

function parseJsonBody(contentType: string, bodyText: string): unknown {
  if (!contentType.toLowerCase().includes('application/json') || !bodyText.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return undefined;
  }
}

function redactWebhookSecretText(value: string): string {
  return value.replace(/(api[_-]?key|authorization|token|password|secret)(["'\s:=]+)([^"'\s,}]+)/gi, '$1$2[redacted]');
}

function redactWebhookJsonSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactWebhookJsonSecrets);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    isSecretWebhookField(key) ? '[redacted]' : redactWebhookJsonSecrets(item),
  ]));
}

function isSecretWebhookField(key: string): boolean {
  return /api[_-]?key|authorization|token|password|secret/i.test(key);
}

function writeNotFound(res: RuntimeHttpResponsePort): void {
  sendJson(res, 404, { success: false, error: 'Not Found' });
}
