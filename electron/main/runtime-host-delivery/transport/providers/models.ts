import { logger } from '../../../../utils/logger';
import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';
import {
  decodeProviderMutationCommittedResponse,
  decodeProviderMutationCommitUnknownResponse,
  ProviderMutationReceiptUnavailableError,
  type ProviderMutationCommittedResponse,
  type ProviderMutationCommitUnknownResponse,
} from './mutation-receipt';

const DECISION_TTL_MS = 30_000;
const ENDPOINT = '/api/provider-models';
const SELECTABLE_ENDPOINT = '/api/provider-models/selectable';
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

export function createProviderModelsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  providerModelsTransportPort: number,
  fetcher: typeof fetch = fetch,
): ProviderModelsTransport {
  const url = `http://127.0.0.1:${providerModelsTransportPort}${ENDPOINT}`;
  const selectableUrl = `http://127.0.0.1:${providerModelsTransportPort}${SELECTABLE_ENDPOINT}`;
  return {
    async read(): Promise<ProviderModelsTransportResponse> {
      try {
        const response = await fetcher(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: ENDPOINT,
              scope: 'providers:models',
              capability: 'providerModels.list',
              subject: 'provider-models',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
          },
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isListResponse(body)) {
          return { status: 200, body };
        }
        if (response.status === 400) return { status: 400, body: INVALID_REQUEST };
        if (response.status === 422) return { status: 422, body: REJECTED };
      } catch {
        // Public delivery deliberately redacts loopback and host failures.
      }
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
      let stage: 'request' | 'response-json' | 'response-validation' = 'request';
      let status: number | null = null;
      logger.info('[ProviderModels] discover start');
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: ENDPOINT,
              scope: 'providers:models',
              capability: 'providerModels.discover',
              subject: 'provider-models',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        status = response.status;
        stage = 'response-json';
        const body: unknown = await response.json();
        stage = 'response-validation';
        if (response.status === 200 && isDiscoverResponse(body)) {
          logger.info('[ProviderModels] discover result', { status, elapsedMs: Date.now() - startedAt });
          return { status: 200, body };
        }
        logger.warn('[ProviderModels] discover result', {
          stage,
          status,
          elapsedMs: Date.now() - startedAt,
          reason: response.status === 200 ? 'invalid-response' : 'http-error',
        });
        if (response.status === 400) return { status: 400, body: INVALID_REQUEST };
        if (response.status === 422) return { status: 422, body: REJECTED };
      } catch {
        logger.warn('[ProviderModels] discover error', { stage, status, elapsedMs: Date.now() - startedAt });
      }
      return { status: 503, body: UNAVAILABLE };
    },

    async readSelectable(capability: ProviderModelCapability): Promise<ProviderModelsTransportResponse> {
      if (!isProviderModelCapability(capability)) return { status: 400, body: INVALID_REQUEST };
      try {
        const response = await fetcher(`${selectableUrl}?capability=${encodeURIComponent(capability)}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: SELECTABLE_ENDPOINT,
              scope: 'providers:models',
              capability: 'providerModels.listSelectable',
              subject: 'provider-models',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
          },
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isSelectableResponse(body)) {
          return { status: 200, body };
        }
        if (response.status === 400) return { status: 400, body: INVALID_REQUEST };
        if (response.status === 422) return { status: 422, body: REJECTED };
      } catch {
        // Public delivery deliberately redacts loopback and host failures.
      }
      return { status: 503, body: UNAVAILABLE };
    },

    async execute(request: unknown): Promise<ProviderModelsTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: INVALID_REQUEST };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: ENDPOINT,
              scope: 'providers:models',
              capability: request.operationId,
              subject: 'provider-models',
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
          if (response.status === 200) throw new ProviderMutationReceiptUnavailableError();
          return { status: 503, body: UNAVAILABLE };
        }
        if (response.status === 200) {
          return {
            status: 200,
            body: decodeProviderMutationCommittedResponse(body, {
              desiredStatus: 'stored',
              desiredRevision: 'forbidden',
              unknownError: MUTATION_UNKNOWN_ERROR,
            }),
          };
        }
        if (response.status === 409) {
          const unknown = decodeProviderMutationCommitUnknownResponse(body, {
            desiredRevision: 'forbidden',
            unknownError: MUTATION_UNKNOWN_ERROR,
          });
          return unknown
            ? { status: 409, body: unknown }
            : { status: 503, body: UNAVAILABLE };
        }
        if (response.status === 400) return { status: 400, body: INVALID_REQUEST };
        if (response.status === 422) return { status: 422, body: REJECTED };
      } catch {
        // Public delivery deliberately redacts malformed loopback and host failures.
      }
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
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'accountId', 'label', 'modelId', 'capabilities', 'contextWindow', 'maxTokens', 'timeoutMs', 'aspectRatio', 'resolution', 'quality',
  ])) return false;
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
    || !hasOnlyKeys(value, [
      'accountId', 'label', 'modelId', 'capabilities', 'contextWindow', 'maxTokens', 'timeoutMs', 'aspectRatio', 'resolution', 'quality', 'selectionId', 'modelReferences',
    ])
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
    && hasOnlyKeys(value, ['modelId', 'capabilities', 'contextWindow', 'maxTokens', 'timeoutMs', 'aspectRatio', 'resolution', 'quality'])
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
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
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
