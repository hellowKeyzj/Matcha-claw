import { logger } from '../../../../utils/logger';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from '../client';
import {
  decodeProviderMutationCommittedResponse,
  decodeProviderMutationCommitUnknownResponse,
  type ProviderMutationCommittedResponse,
  type ProviderMutationCommitUnknownResponse,
} from './mutation-receipt';

const PROVIDER_MODELS_PATH = '/api/provider-models';
const SELECTABLE_PROVIDER_MODELS_PATH = '/api/provider-models/selectable';
const MUTATION_UNKNOWN_ERROR = 'Provider mutation commit outcome is unknown; reopen before retrying';

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

type ModelDraft = Readonly<{
  modelId: string;
  capabilities: readonly ProviderModelCapability[];
  contextWindow?: number;
  maxTokens?: number;
  timeoutMs?: number;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
}>;

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
type DiscoverResponse = Readonly<{ models: ModelDraft[] }>;
type SelectableResponse = Readonly<{ models: SelectableProviderModel[] }>;
type ReplaceResponse = ProviderMutationCommittedResponse | ProviderMutationCommitUnknownResponse;

export type ProviderModelsTransportResponse = Readonly<{
  status: 200 | 400 | 409 | 422 | 503;
  body: ListResponse | DiscoverResponse | SelectableResponse | ReplaceResponse | typeof INVALID_REQUEST | typeof REJECTED | typeof UNAVAILABLE;
}>;

export interface ProviderModelsTransport {
  read(): Promise<ProviderModelsTransportResponse>;
  discover(accountId: string): Promise<ProviderModelsTransportResponse>;
  readSelectable(capability: ProviderModelCapability): Promise<ProviderModelsTransportResponse>;
  execute(request: unknown): Promise<ProviderModelsTransportResponse>;
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
    async read(): Promise<ProviderModelsTransportResponse> {
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

    async discover(accountId: string): Promise<ProviderModelsTransportResponse> {
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
      logger.info('[ProviderModels] discover start');
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
      if (response?.status === 200 && isDiscoverResponse(response.body)) {
        logger.info('[ProviderModels] discover result', { status: status.value, elapsedMs: Date.now() - startedAt });
        return { status: 200, body: response.body };
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

    async readSelectable(capability: ProviderModelCapability): Promise<ProviderModelsTransportResponse> {
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

    async execute(request: unknown): Promise<ProviderModelsTransportResponse> {
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
      if (response?.status === 200) {
        const decoded = decodeProviderMutationCommittedResponse(response.body, {
          desiredStatus: 'stored',
          desiredRevision: 'forbidden',
          unknownError: MUTATION_UNKNOWN_ERROR,
        });
        return decoded
          ? { status: 200, body: decoded }
          : { status: 503, body: UNAVAILABLE };
      }
      if (response?.status === 409) {
        const unknown = decodeProviderMutationCommitUnknownResponse(response.body, {
          desiredRevision: 'forbidden',
          unknownError: MUTATION_UNKNOWN_ERROR,
        });
        return unknown
          ? { status: 409, body: unknown }
          : { status: 503, body: UNAVAILABLE };
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
    && hasExactKeys(value, ['models'])
    && Array.isArray(value.models)
    && value.models.every(isModelDraft);
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
    && isModelId(value.modelId)
    && Array.isArray(value.capabilities)
    && value.capabilities.length > 0
    && value.capabilities.every(isProviderModelCapability)
    && optionalPositive(value.contextWindow)
    && optionalPositive(value.maxTokens)
    && optionalPositive(value.timeoutMs)
    && optionalText(value.aspectRatio)
    && optionalText(value.resolution)
    && optionalText(value.quality);
}

function isSelectableProviderModel(value: unknown): value is SelectableProviderModel {
  if (!isRecord(value)
    || !Object.hasOwn(value, 'selectionId')
    || !Object.keys(value).every((key) => SELECTABLE_PROVIDER_MODEL_KEYS.includes(key))
    || !isBoundedText(value.selectionId, 2048)
    || !Array.isArray(value.modelReferences)
    || value.modelReferences.length === 0
    || !value.modelReferences.every((item) => isBoundedText(item, 2048))) return false;
  return isProviderModel({
    accountId: value.accountId,
    label: value.label,
    modelId: value.modelId,
    capabilities: value.capabilities,
    ...(Object.hasOwn(value, 'contextWindow') ? { contextWindow: value.contextWindow } : {}),
    ...(Object.hasOwn(value, 'maxTokens') ? { maxTokens: value.maxTokens } : {}),
    ...(Object.hasOwn(value, 'timeoutMs') ? { timeoutMs: value.timeoutMs } : {}),
    ...(Object.hasOwn(value, 'aspectRatio') ? { aspectRatio: value.aspectRatio } : {}),
    ...(Object.hasOwn(value, 'resolution') ? { resolution: value.resolution } : {}),
    ...(Object.hasOwn(value, 'quality') ? { quality: value.quality } : {}),
  });
}

function isModelDraft(value: unknown): value is ModelDraft {
  return isRecord(value)
    && Object.keys(value).every((key) => MODEL_DRAFT_KEYS.includes(key))
    && isModelId(value.modelId)
    && Array.isArray(value.capabilities)
    && value.capabilities.length > 0
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
