import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from '../client';
import {
  decodeProviderMutationCommittedResponse,
  decodeProviderMutationCommitUnknownResponse,
  type ProviderMutationCommittedResponse,
  type ProviderMutationCommitUnknownResponse,
} from './mutation-receipt';

const PROVIDER_ROUTING_PATH = '/api/provider-routing';
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

const ROUTE_KEYS: readonly string[] = ['capability', 'primary', 'fallbacks', 'timeoutMs'];

export function createProviderRoutingTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ProviderRoutingTransport {
  return {
    async execute(request: unknown): Promise<ProviderRoutingTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: INVALID_REQUEST };
      return executeRequest(request, issuer, runtimeHostTransportPort, fetcher);
    },
  };
}

async function executeRequest(
  request: Request,
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch,
): Promise<ProviderRoutingTransportResponse> {
  const response = await sendLoopbackJson({
    port,
    path: PROVIDER_ROUTING_PATH,
    issuer,
    decision: {
      endpoint: PROVIDER_ROUTING_PATH,
      scope: 'providers:routing',
      capability: request.operationId,
      subject: 'provider-routing',
    },
    method: 'POST',
    fetcher,
    body: request,
  });
  if (request.operationId === 'providerRouting.replace') {
    if (response?.status === 200) {
      const decoded = decodeProviderMutationCommittedResponse(response.body, {
        desiredStatus: 'stored',
        desiredRevision: 'required',
        unknownError: MUTATION_UNKNOWN_ERROR,
      });
      return decoded
        ? { status: 200, body: decoded }
        : { status: 503, body: UNAVAILABLE };
    }
    if (response?.status === 409) {
      const unknown = decodeProviderMutationCommitUnknownResponse(response.body, {
        desiredRevision: 'required',
        unknownError: MUTATION_UNKNOWN_ERROR,
      });
      return unknown
        ? { status: 409, body: unknown }
        : { status: 503, body: UNAVAILABLE };
    }
  } else if (response?.status === 200 && isListResponse(response.body)) {
    return { status: 200, body: response.body };
  }
  if (response?.status === 400) return { status: 400, body: INVALID_REQUEST };
  if (response?.status === 422) return { status: 422, body: REJECTED };
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
    && Object.keys(value).every((key) => ROUTE_KEYS.includes(key))
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
  return isSafeNonNegativeInteger(value) && value > 0;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
