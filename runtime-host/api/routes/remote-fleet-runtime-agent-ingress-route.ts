import { sendJson, type RuntimeHttpResponsePort } from '../common/http';
import {
  createRuntimeAgentIngressRejectedResponse,
  type RuntimeAgentIngressResponse,
} from '../../application/remote-fleet/remote-fleet-agent-ingress';
import type { RemoteFleetPort } from '../../application/remote-fleet/remote-fleet-service';

const MAX_RUNTIME_AGENT_INGRESS_BODY_BYTES = 64 * 1024;
const RUNTIME_AGENT_INGRESS_CREDENTIAL_HEADER = 'x-matchaclaw-runtime-agent-ingress-credential';

type RuntimeAgentIngressHttpRequest = {
  readonly method?: string;
  readonly headers: Record<string, string | readonly string[] | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
};

export interface RuntimeAgentIngressRouteDeps {
  readonly remoteFleetService: Pick<RemoteFleetPort, 'invoke'>;
  readonly nowIso: () => string;
}

type ReadRuntimeAgentIngressBodyResult =
  | { readonly resultType: 'success'; readonly value: unknown }
  | { readonly resultType: 'too-large' }
  | { readonly resultType: 'invalid-json' };

export function createRuntimeAgentIngressRouteHandler(deps: RuntimeAgentIngressRouteDeps) {
  return async (
    req: RuntimeAgentIngressHttpRequest,
    res: RuntimeHttpResponsePort,
  ): Promise<void> => {
    const receivedAt = deps.nowIso();
    if (req.method !== 'POST') {
      writeRejected(res, undefined, 'invalid-request', receivedAt, 405);
      return;
    }
    if (!isJsonContentType(readHeader(req, 'content-type'))) {
      writeRejected(res, undefined, 'invalid-request', receivedAt, 400);
      return;
    }

    const body = await readRuntimeAgentIngressBody(req);
    if (body.resultType === 'too-large') {
      writeRejected(res, undefined, 'invalid-request', receivedAt, 413);
      return;
    }
    if (body.resultType === 'invalid-json') {
      writeRejected(res, undefined, 'invalid-request', receivedAt, 400);
      return;
    }

    try {
      const response = await deps.remoteFleetService.invoke('ingestRuntimeAgentIngress', {
        rawRequest: body.value,
        authorizationCredential: readBearerCredential(req),
        ...(isHeartbeatRequest(body.value)
          ? { enrollmentCredential: readOptionalHeader(req, RUNTIME_AGENT_INGRESS_CREDENTIAL_HEADER) }
          : {}),
      });
      sendJson(res, response.status, response.data);
    } catch {
      writeRejected(res, body.value, 'runtime-unavailable', receivedAt, 503);
    }
  };
}

async function readRuntimeAgentIngressBody(
  req: RuntimeAgentIngressHttpRequest,
): Promise<ReadRuntimeAgentIngressBodyResult> {
  const contentLength = Number.parseInt(readHeader(req, 'content-length'), 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_RUNTIME_AGENT_INGRESS_BODY_BYTES) {
    return { resultType: 'too-large' };
  }

  let totalBytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = toBuffer(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_RUNTIME_AGENT_INGRESS_BODY_BYTES) {
      return { resultType: 'too-large' };
    }
    chunks.push(buffer);
  }

  try {
    return {
      resultType: 'success',
      value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
    };
  } catch {
    return { resultType: 'invalid-json' };
  }
}

function writeRejected(
  res: RuntimeHttpResponsePort,
  request: unknown,
  reason: Extract<RuntimeAgentIngressResponse, { readonly resultType: 'rejected' }>['reason'],
  receivedAt: string,
  status: number,
): void {
  sendJson(res, status, createRuntimeAgentIngressRejectedResponse(request, reason, receivedAt));
}

function readHeader(req: RuntimeAgentIngressHttpRequest, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] ?? '' : '';
}

function readOptionalHeader(req: RuntimeAgentIngressHttpRequest, name: string): string | undefined {
  const value = readHeader(req, name).trim();
  return value || undefined;
}

function readBearerCredential(req: RuntimeAgentIngressHttpRequest): string | undefined {
  const authorization = readHeader(req, 'authorization');
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return undefined;
  }
  const credential = authorization.slice('bearer '.length).trim();
  return credential || undefined;
}

function isJsonContentType(value: string): boolean {
  return value.toLowerCase().split(';', 1)[0]?.trim() === 'application/json';
}

function isHeartbeatRequest(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { readonly type?: unknown }).type === 'runtime-agent.heartbeat';
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}
