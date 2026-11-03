import { createHash } from 'node:crypto';
import { logger } from '../../../../utils/logger';
import { parseAccount, isSecret, type ProviderAccountIntent } from '../../../providers/account-intent';
import { traceDebug } from '../../../../utils/trace-logger';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from '../client';
import type { CallReceipt } from '../../../../../src/types/call-log';
import { decodeCallReceipt } from '../../../../../src/types/call-log/receipt';

const PROVIDER_MODELS_PATH = '/api/provider-models';
const SELECTABLE_PROVIDER_MODELS_PATH = '/api/provider-models/selectable';
const DISCOVERY_RESULT_PATH = '/api/provider-models/discovery-result';
const DISCOVERY_PENDING = { success: false, error: 'Provider model discovery is still running' } as const;
const DISCOVERY_EXPIRED = { success: false, error: 'Provider model discovery result expired; discover again' } as const;

const UNAVAILABLE = {
  success: false,
  error: 'Provider models are unavailable',
} as const;

const INVALID_REQUEST = {
  success: false,
  error: 'Provider model request is invalid',
} as const;

const REJECTED = {
  success: false,
  error: 'Provider model request was rejected',
} as const;

export type ProviderModelCapability =
  | 'chat'
  | 'imageUnderstand'
  | 'imageGenerate'
  | 'videoGenerate'
  | 'musicGenerate'
  | 'tts'
  | 'transcribe';

export type ModelDraft = Readonly<{
  modelId: string;
  capabilities: readonly ProviderModelCapability[];
  contextWindow?: number;
  maxTokens?: number;
  timeoutMs?: number;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
}>;

export type ProviderDraftDiscoveryInput = Readonly<{ account: ProviderAccountIntent; apiKey?: string; token?: string }>;
export type ProviderDraftDiscoveryReason = 'invalid-request' | 'unsupported' | 'credential-missing' | 'credential-unavailable'
  | 'authentication' | 'permission-denied' | 'rate-limited' | 'deadline' | 'invalid-response' | 'unavailable' | 'outcome-unknown';
export type ProviderDraftDiscoveryResult = Readonly<{ models: ModelDraft[] }> | Readonly<{ reason: ProviderDraftDiscoveryReason }>;

export function parseProviderDraftDiscoveryInput(input: unknown): ProviderDraftDiscoveryInput | null {
  if (!isRecord(input) || !Object.keys(input).every((key) => ['account', 'apiKey', 'token'].includes(key))
    || !isRecord(input.account) || !Object.keys(input.account).every((key) =>
      ['id', 'provider', 'label', 'enabled', 'kind', 'endpoint', 'protocol', 'mediaProtocol', 'authMode', 'revision'].includes(key))) return null;
  const account = parseAccount(input.account);
  if (!account || input.apiKey !== undefined && (account.authMode !== 'apiKey' || !isSecret(input.apiKey))
    || input.token !== undefined && (account.authMode !== 'token' || !isSecret(input.token))) return null;
  return { account, ...(typeof input.apiKey === 'string' ? { apiKey: input.apiKey } : {}), ...(typeof input.token === 'string' ? { token: input.token } : {}) };
}

type DiscoverRequest = Readonly<{
  id: 'provider.models';
  operationId: 'providerModels.discover';
  scope: Readonly<{ kind: 'provider-model-catalog' }>;
  target: Readonly<{ kind: 'provider-models' }>;
  input: Readonly<{ kind: 'discover'; accountId: string }>;
}>;

type ReplaceRequest = Readonly<{
  id: 'provider.models';
  operationId: 'providerModels.replace';
  scope: Readonly<{ kind: 'provider-model-catalog' }>;
  target: Readonly<{ kind: 'provider-models' }>;
  input: Readonly<{ kind: 'replace'; accountId: string; models: readonly ModelDraft[] }>;
}>;

export type ProviderModel = Readonly<{
  accountId: string;
  label: string;
  modelId: string;
  capabilities: ProviderModelCapability[];
  contextWindow?: number;
  maxTokens?: number;
  timeoutMs?: number;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
}>;

export type SelectableProviderModel = ProviderModel & Readonly<{
  selectionId: string;
  modelReferences: string[];
}>;

type ListResponse = Readonly<{ models: ProviderModel[] }>;
type DiscoverResponse = Readonly<{ callId: string; accountId: string; models: ModelDraft[] }>;
type SelectableResponse = Readonly<{ models: SelectableProviderModel[] }>;
type ReplaceResponse = CallReceipt;

export type ProviderModelsTransportResponse<
  T = ListResponse | DiscoverResponse | SelectableResponse | ReplaceResponse,
  S extends 200 | 202 = 200 | 202,
> =
  | Readonly<{ status: S; body: T }>
  | Readonly<{ status: 400; body: typeof INVALID_REQUEST }>
  | Readonly<{ status: 409; body: typeof DISCOVERY_PENDING }>
  | Readonly<{ status: 410; body: typeof DISCOVERY_EXPIRED }>
  | Readonly<{ status: 422; body: typeof REJECTED }>
  | Readonly<{ status: 503; body: typeof UNAVAILABLE }>;

export interface ProviderModelsTransport {
  read(): Promise<ProviderModelsTransportResponse<ListResponse, 200>>;
  discoverDraft(input: ProviderDraftDiscoveryInput, signal: AbortSignal): Promise<ProviderDraftDiscoveryResult>;
  discover(accountId: string): Promise<ProviderModelsTransportResponse<CallReceipt, 202>>;
  readDiscoveryResult(callId: string, accountId: string): Promise<ProviderModelsTransportResponse<DiscoverResponse, 200>>;
  readSelectable(capability: ProviderModelCapability): Promise<ProviderModelsTransportResponse<SelectableResponse, 200>>;
  execute(request: unknown): Promise<ProviderModelsTransportResponse<ReplaceResponse, 202>>;
}

const PROVIDER_MODEL_KEYS: readonly string[] = [
  'accountId', 'label', 'modelId', 'capabilities', 'contextWindow', 'maxTokens', 'timeoutMs', 'aspectRatio', 'resolution', 'quality',
];
const SELECTABLE_PROVIDER_MODEL_KEYS: readonly string[] = [
  'accountId', 'label', 'modelId', 'capabilities', 'contextWindow', 'maxTokens', 'timeoutMs', 'aspectRatio', 'resolution', 'quality', 'selectionId', 'modelReferences',
];
const MODEL_DRAFT_KEYS: readonly string[] = ['modelId', 'capabilities', 'contextWindow', 'maxTokens', 'timeoutMs', 'aspectRatio', 'resolution', 'quality'];

export function createProviderModelsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ProviderModelsTransport {
  return {
    async discoverDraft(input: ProviderDraftDiscoveryInput, signal: AbortSignal): Promise<ProviderDraftDiscoveryResult> {
      const parsed = parseProviderDraftDiscoveryInput(input);
      if (!parsed) return { reason: 'invalid-request' };
      const serializedBody = JSON.stringify(parsed);
      if (Buffer.byteLength(serializedBody) > 64 * 1024) return { reason: 'invalid-request' };
      const path = '/api/provider-models/discover-draft';
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort, path, issuer,
        decision: { endpoint: path, scope: 'providers:models', capability: 'providerModels.discoverDraft', subject: 'provider-models',
          revision: createHash('sha256').update(serializedBody).digest('hex') },
        method: 'POST', fetcher, serializedBody, signal, timeoutMs: 20_000,
      });
      if (response?.status === 200 && isRecord(response.body) && hasExactKeys(response.body, ['models'])
        && Array.isArray(response.body.models) && response.body.models.length <= 4096
        && response.body.models.every(isDiscoveryDraft)) return { models: response.body.models };
      if (response && isRecord(response.body) && hasExactKeys(response.body, ['reason']) && isDraftDiscoveryReason(response.body.reason)) {
        return { reason: response.body.reason };
      }
      return { reason: 'outcome-unknown' };
    },

    async read(): Promise<ProviderModelsTransportResponse<ListResponse, 200>> {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: PROVIDER_MODELS_PATH,
        issuer,
        decision: {
          endpoint: PROVIDER_MODELS_PATH,
          scope: 'providers:models',
          capability: 'providerModels.list',
          subject: 'provider-models',
        },
        method: 'GET',
        fetcher,
      });
      if (response?.status === 200 && isListResponse(response.body)) return { status: 200, body: response.body };
      if (response?.status === 400) return { status: 400, body: INVALID_REQUEST };
      if (response?.status === 422) return { status: 422, body: REJECTED };
      return { status: 503, body: UNAVAILABLE };
    },

    async discover(accountId: string): Promise<ProviderModelsTransportResponse<CallReceipt, 202>> {
      const request: DiscoverRequest = {
        id: 'provider.models',
        operationId: 'providerModels.discover',
        scope: { kind: 'provider-model-catalog' },
        target: { kind: 'provider-models' },
        input: { kind: 'discover', accountId },
      };
      if (!isDiscoverRequest(request)) return { status: 400, body: INVALID_REQUEST };
      const startedAt = Date.now();
      const status = { value: null as number | null };
      traceDebug('[ProviderModels] discover start');
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: PROVIDER_MODELS_PATH,
        issuer,
        decision: {
          endpoint: PROVIDER_MODELS_PATH,
          scope: 'providers:models',
          capability: 'providerModels.discover',
          subject: 'provider-models',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      status.value = response?.status ?? null;
      if (response?.status === 202) {
        try {
          const receipt = decodeCallReceipt(response.body);
          traceDebug(() => ['[ProviderModels] discover admitted', { status: status.value, elapsedMs: Date.now() - startedAt }]);
          return { status: 202, body: receipt };
        } catch { /* closed public admission boundary */ }
      }
      logger.warn('[ProviderModels] discover result', {
        stage: response === null ? 'request' : 'response-validation',
        status: status.value,
        elapsedMs: Date.now() - startedAt,
        reason: response?.status === 200 ? 'invalid-response' : 'http-error',
      });
      if (response?.status === 400) return { status: 400, body: INVALID_REQUEST };
      if (response?.status === 422) return { status: 422, body: REJECTED };
      return { status: 503, body: UNAVAILABLE };
    },

    async readDiscoveryResult(callId: string, accountId: string): Promise<ProviderModelsTransportResponse<DiscoverResponse, 200>> {
      if (!/^[0-9a-f]{32}$/.test(callId) || !isIdentifier(accountId)) return { status: 400, body: INVALID_REQUEST };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: DISCOVERY_RESULT_PATH,
        issuer,
        decision: {
          endpoint: DISCOVERY_RESULT_PATH,
          scope: 'providers:models',
          capability: 'providerModels.discoveryResult',
          subject: 'provider-models',
        },
        method: 'GET',
        fetcher,
        query: new URLSearchParams({ callId, accountId }),
      });
      if (response?.status === 200 && isDiscoverResponse(response.body)
        && response.body.callId === callId && response.body.accountId === accountId) return { status: 200, body: response.body };
      if (response?.status === 400) return { status: 400, body: INVALID_REQUEST };
      if (response?.status === 409) return { status: 409, body: DISCOVERY_PENDING };
      if (response?.status === 410) return { status: 410, body: DISCOVERY_EXPIRED };
      if (response?.status === 422) return { status: 422, body: REJECTED };
      return { status: 503, body: UNAVAILABLE };
    },

    async readSelectable(capability: ProviderModelCapability): Promise<ProviderModelsTransportResponse<SelectableResponse, 200>> {
      if (!isProviderModelCapability(capability)) return { status: 400, body: INVALID_REQUEST };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: SELECTABLE_PROVIDER_MODELS_PATH,
        issuer,
        decision: {
          endpoint: SELECTABLE_PROVIDER_MODELS_PATH,
          scope: 'providers:models',
          capability: 'providerModels.listSelectable',
          subject: 'provider-models',
        },
        method: 'GET',
        fetcher,
        query: new URLSearchParams({ capability }),
      });
      if (response?.status === 200 && isSelectableResponse(response.body)) return { status: 200, body: response.body };
      if (response?.status === 400) return { status: 400, body: INVALID_REQUEST };
      if (response?.status === 422) return { status: 422, body: REJECTED };
      return { status: 503, body: UNAVAILABLE };
    },

    async execute(request: unknown): Promise<ProviderModelsTransportResponse<ReplaceResponse, 202>> {
      if (!isRequest(request)) return { status: 400, body: INVALID_REQUEST };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: PROVIDER_MODELS_PATH,
        issuer,
        decision: {
          endpoint: PROVIDER_MODELS_PATH,
          scope: 'providers:models',
          capability: request.operationId,
          subject: 'provider-models',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 202) {
        try {
          return { status: 202, body: decodeCallReceipt(response.body) };
        } catch { /* closed public admission boundary */ }
      }
      if (response?.status === 400) return { status: 400, body: INVALID_REQUEST };
      if (response?.status === 422) return { status: 422, body: REJECTED };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is ReplaceRequest {
  return isProviderModelsRequestBase(value)
    && value.operationId === 'providerModels.replace'
    && hasExactKeys(value.input, ['kind', 'accountId', 'models'])
    && value.input.kind === 'replace'
    && isIdentifier(value.input.accountId)
    && Array.isArray(value.input.models)
    && value.input.models.every(isModelDraft);
}

function isDiscoverRequest(value: unknown): value is DiscoverRequest {
  return isProviderModelsRequestBase(value)
    && value.operationId === 'providerModels.discover'
    && isDiscoverInput(value.input);
}

function isProviderModelsRequestBase(value: unknown): value is Readonly<{
  id: 'provider.models';
  operationId: unknown;
  scope: Record<string, unknown>;
  target: Record<string, unknown>;
  input: Record<string, unknown>;
}> {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'provider.models'
    && isRecord(value.scope)
    && hasExactKeys(value.scope, ['kind'])
    && value.scope.kind === 'provider-model-catalog'
    && isRecord(value.target)
    && hasExactKeys(value.target, ['kind'])
    && value.target.kind === 'provider-models'
    && isRecord(value.input);
}

function isDiscoverInput(value: Record<string, unknown>): value is DiscoverRequest['input'] {
  return hasExactKeys(value, ['kind', 'accountId'])
    && value.kind === 'discover'
    && isIdentifier(value.accountId);
}

function isListResponse(value: unknown): value is ListResponse {
  return isRecord(value)
    && hasExactKeys(value, ['models'])
    && Array.isArray(value.models)
    && value.models.every(isProviderModel);
}

function isDiscoverResponse(value: unknown): value is DiscoverResponse {
  return isRecord(value)
    && hasExactKeys(value, ['callId', 'accountId', 'models'])
    && typeof value.callId === 'string' && /^[0-9a-f]{32}$/.test(value.callId)
    && isIdentifier(value.accountId)
    && Array.isArray(value.models)
    && value.models.every(isDiscoveryDraft);
}

function isSelectableResponse(value: unknown): value is SelectableResponse {
  return isRecord(value)
    && hasExactKeys(value, ['models'])
    && Array.isArray(value.models)
    && value.models.every(isSelectableProviderModel);
}

function isProviderModel(value: unknown): value is ProviderModel {
  if (!isRecord(value) || !Object.keys(value).every((key) => PROVIDER_MODEL_KEYS.includes(key))) return false;
  return isIdentifier(value.accountId)
    && isBoundedText(value.label, 256)
    && hasModelFields(value);
}

function isSelectableProviderModel(value: unknown): value is SelectableProviderModel {
  if (!isRecord(value)
    || !Object.hasOwn(value, 'selectionId')
    || !Object.keys(value).every((key) => SELECTABLE_PROVIDER_MODEL_KEYS.includes(key))
    || !isBoundedText(value.selectionId, 2048)
    || !Array.isArray(value.modelReferences)
    || value.modelReferences.length === 0
    || !value.modelReferences.every((item) => isBoundedText(item, 2048))) return false;
  return isIdentifier(value.accountId)
    && isBoundedText(value.label, 256)
    && hasModelFields(value);
}

function isDraftDiscoveryReason(value: unknown): value is ProviderDraftDiscoveryReason {
  return typeof value === 'string' && ['invalid-request', 'unsupported', 'credential-missing', 'credential-unavailable',
    'authentication', 'permission-denied', 'rate-limited', 'deadline', 'invalid-response', 'unavailable', 'outcome-unknown'].includes(value);
}

function isDiscoveryDraft(value: unknown): value is ModelDraft {
  return isRecord(value) && Object.keys(value).every((key) => MODEL_DRAFT_KEYS.includes(key)) && hasModelFields(value, true);
}

function isModelDraft(value: unknown): value is ModelDraft {
  return isRecord(value)
    && Object.keys(value).every((key) => MODEL_DRAFT_KEYS.includes(key))
    && hasModelFields(value);
}

function hasModelFields(value: Record<string, unknown>, discovery = false): boolean {
  return isModelId(value.modelId)
    && Array.isArray(value.capabilities)
    && (discovery || value.capabilities.length > 0)
    && value.capabilities.every(isProviderModelCapability)
    && optionalPositive(value.contextWindow)
    && optionalPositive(value.maxTokens)
    && optionalPositive(value.timeoutMs)
    && optionalText(value.aspectRatio)
    && optionalText(value.resolution)
    && optionalText(value.quality);
}

export function isProviderModelAccountIdentifier(value: unknown): value is string {
  return isIdentifier(value);
}

export function isProviderModelCapability(value: unknown): value is ProviderModelCapability {
  return value === 'chat'
    || value === 'imageUnderstand'
    || value === 'imageGenerate'
    || value === 'videoGenerate'
    || value === 'musicGenerate'
    || value === 'tts'
    || value === 'transcribe';
}

function optionalPositive(value: unknown): boolean {
  return value === undefined || (isSafeNonNegativeInteger(value) && value > 0);
}

function optionalText(value: unknown): boolean {
  return value === undefined || isBoundedText(value, 128);
}

function isModelId(value: unknown): value is string {
  return isBoundedText(value, 512);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !Array.from(value).some((character) => character < ' ' || character === '');
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
