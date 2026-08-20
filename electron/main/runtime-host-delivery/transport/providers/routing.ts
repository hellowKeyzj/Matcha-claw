import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';
import {
  decodeProviderMutationCommittedResponse,
  decodeProviderMutationCommitUnknownResponse,
  ProviderMutationReceiptUnavailableError,
  type ProviderMutationCommittedResponse,
  type ProviderMutationCommitUnknownResponse,
} from './mutation-receipt';

const DECISION_TTL_MS = 30_000;
const ENDPOINT = '/api/provider-routing';
const MUTATION_UNKNOWN_ERROR = 'Provider mutation commit outcome is unknown; reopen before retrying';

const UNAVAILABLE = {
  success: false,
  error: 'Provider routing is unavailable',
} as const;

const INVALID_REQUEST = {
  success: false,
  error: 'Provider routing request is invalid',
} as const;

const REJECTED = {
  success: false,
  error: 'Provider routing request was rejected',
} as const;

type Capability = 'chat' | 'imageUnderstand' | 'imageGenerate' | 'videoGenerate' | 'musicGenerate' | 'tts';

type ModelReference = Readonly<{
  accountId: string;
  modelId: string;
}>;

type Route = Readonly<{
  capability: Capability;
  primary: ModelReference;
  fallbacks: readonly ModelReference[];
  timeoutMs?: number;
}>;

type Routing = Readonly<{
  revision: number;
  routes: readonly Route[];
}>;

type Request =
  | Readonly<{
    id: 'provider.routing';
    operationId: 'providerRouting.list';
    scope: Readonly<{ kind: 'provider-routing' }>;
    target: Readonly<{ kind: 'provider-routing' }>;
    input: Readonly<{ kind: 'list' }>;
  }>
  | Readonly<{
    id: 'provider.routing';
    operationId: 'providerRouting.replace';
    scope: Readonly<{ kind: 'provider-routing' }>;
    target: Readonly<{ kind: 'provider-routing' }>;
    input: Readonly<{ kind: 'replace'; routing: Routing }>;
  }>;

export type ProviderRoutingTransportResponse = Readonly<{
  status: 200 | 400 | 409 | 422 | 503;
  body: ListResponse | ReplaceResponse | typeof INVALID_REQUEST | typeof REJECTED | typeof UNAVAILABLE;
}>;

export interface ProviderRoutingTransport {
  execute(request: unknown): Promise<ProviderRoutingTransportResponse>;
}

type ListResponse = Readonly<{ routing: Routing | null }>;
type ReplaceResponse = ProviderMutationCommittedResponse | ProviderMutationCommitUnknownResponse;

export function createProviderRoutingTransport(
  issuer: RuntimeHostDeliveryIssuer,
  providerModelsTransportPort: number,
  fetcher: typeof fetch = fetch,
): ProviderRoutingTransport {
  const url = `http://127.0.0.1:${providerModelsTransportPort}${ENDPOINT}`;
  return {
    async execute(request: unknown): Promise<ProviderRoutingTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: INVALID_REQUEST };
      return executeRequest(request, issuer, url, fetcher);
    },
  };
}

async function executeRequest(
  request: Request,
  issuer: RuntimeHostDeliveryIssuer,
  url: string,
  fetcher: typeof fetch,
): Promise<ProviderRoutingTransportResponse> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issuer.signDecision({
          principal: 'electron-main-local',
          endpoint: ENDPOINT,
          scope: 'providers:routing',
          capability: request.operationId,
          subject: 'provider-routing',
          expiresAt: Date.now() + DECISION_TTL_MS,
          revision: '1',
        })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (request.operationId === 'providerRouting.replace' && response.status === 200) {
        throw new ProviderMutationReceiptUnavailableError();
      }
      return { status: 503, body: UNAVAILABLE };
    }
    if (request.operationId === 'providerRouting.replace') {
      if (response.status === 200) {
        return {
          status: 200,
          body: decodeProviderMutationCommittedResponse(body, {
            desiredStatus: 'stored',
            desiredRevision: 'required',
            unknownError: MUTATION_UNKNOWN_ERROR,
          }),
        };
      }
      if (response.status === 409) {
        const unknown = decodeProviderMutationCommitUnknownResponse(body, {
          desiredRevision: 'required',
          unknownError: MUTATION_UNKNOWN_ERROR,
        });
        return unknown
          ? { status: 409, body: unknown }
          : { status: 503, body: UNAVAILABLE };
      }
    } else if (response.status === 200 && isListResponse(body)) {
      return { status: 200, body };
    }
    if (response.status === 400) return { status: 400, body: INVALID_REQUEST };
    if (response.status === 422) return { status: 422, body: REJECTED };
  } catch {
    // Public delivery deliberately redacts malformed loopback and host failures.
  }
  return { status: 503, body: UNAVAILABLE };
}

function isRequest(value: unknown): value is Request {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'provider.routing'
    || !isRecord(value.scope)
    || !hasExactKeys(value.scope, ['kind'])
    || value.scope.kind !== 'provider-routing'
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind'])
    || value.target.kind !== 'provider-routing'
    || !isRecord(value.input)) return false;
  if (value.operationId === 'providerRouting.list') {
    return hasExactKeys(value.input, ['kind']) && value.input.kind === 'list';
  }
  return value.operationId === 'providerRouting.replace'
    && hasExactKeys(value.input, ['kind', 'routing'])
    && value.input.kind === 'replace'
    && isRouting(value.input.routing);
}

function isListResponse(value: unknown): value is ListResponse {
  return isRecord(value)
    && hasExactKeys(value, ['routing'])
    && (value.routing === null || isRouting(value.routing));
}

function isRouting(value: unknown): value is Routing {
  return isRecord(value)
    && hasExactKeys(value, ['revision', 'routes'])
    && isRevision(value.revision)
    && Array.isArray(value.routes)
    && value.routes.every(isRoute);
}

function isRoute(value: unknown): value is Route {
  return isRecord(value)
    && hasOnlyKeys(value, ['capability', 'primary', 'fallbacks', 'timeoutMs'])
    && isCapability(value.capability)
    && isModelReference(value.primary)
    && Array.isArray(value.fallbacks)
    && value.fallbacks.every(isModelReference)
    && (value.timeoutMs === undefined || isPositiveInteger(value.timeoutMs));
}

function isModelReference(value: unknown): value is ModelReference {
  return isRecord(value)
    && hasExactKeys(value, ['accountId', 'modelId'])
    && isNonEmptyText(value.accountId)
    && isNonEmptyText(value.modelId);
}

function isCapability(value: unknown): value is Capability {
  return value === 'chat' || value === 'imageUnderstand' || value === 'imageGenerate'
    || value === 'videoGenerate' || value === 'musicGenerate' || value === 'tts';
}

function isRevision(value: unknown): value is number {
  return isPositiveInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
