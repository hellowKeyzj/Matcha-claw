import { hostApiFetch } from '@/lib/host-api';
import { nativeProjectionError } from '@/lib/provider-projection-errors';
import {
  decodeProviderMutationReceipt,
  ProviderMutationCommitOutcomeUnknownError,
  type ProviderMutationReceipt,
} from '@/lib/host-api-transport-contract';
import { summarizeIdentifier } from '@/lib/session-trace';
import type { ModelCapability } from '@/lib/providers';
import { MODEL_CAPABILITIES } from '@/lib/provider-model-capabilities';

export type { ModelCapability } from '@/lib/providers';

export interface ProviderModel {
  accountId: string;
  label?: string;
  modelId: string;
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxTokens?: number;
  timeoutMs?: number;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
}

export type ProviderModelDraft = Omit<ProviderModel, 'accountId' | 'label'>;

export interface ProviderModelsReplaceResult {
  desired: { status: 'stored' };
  receipt: ProviderMutationReceipt;
  warning?: string;
}

export interface ProviderModelsDiscoverResult {
  models: ProviderModelDraft[];
}

const MODEL_CAPABILITY_SET = new Set<ModelCapability>(MODEL_CAPABILITIES);
const LEGACY_MODEL_FIELDS = ['credentialId', 'providerKey', 'runtimeModelRef'] as const;
const DISCOVERY_MODEL_FIELDS = new Set([
  'modelId',
  'capabilities',
  'contextWindow',
  'maxTokens',
  'timeoutMs',
  'aspectRatio',
  'resolution',
  'quality',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasLegacyModelFields(value: Record<string, unknown>): boolean {
  return LEGACY_MODEL_FIELDS.some((field) => Object.hasOwn(value, field));
}

function hasOnlyDiscoveryModelFields(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((field) => DISCOVERY_MODEL_FIELDS.has(field));
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeCapabilities(value: unknown): ModelCapability[] {
  if (!Array.isArray(value)) return [];
  const out: ModelCapability[] = [];
  const seen = new Set<ModelCapability>();
  for (const raw of value) {
    if (!MODEL_CAPABILITY_SET.has(raw as ModelCapability)) continue;
    const capability = raw as ModelCapability;
    if (seen.has(capability)) continue;
    seen.add(capability);
    out.push(capability);
  }
  return out;
}

function normalizeProviderModelDraft(value: unknown, options: { strictFields?: boolean } = {}): ProviderModelDraft | null {
  if (!isRecord(value) || hasLegacyModelFields(value)) return null;
  if (options.strictFields && !hasOnlyDiscoveryModelFields(value)) return null;
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const capabilities = normalizeCapabilities(value.capabilities);
  if (!modelId || capabilities.length === 0) return null;
  const contextWindow = normalizePositiveInteger(value.contextWindow);
  const maxTokens = normalizePositiveInteger(value.maxTokens);
  const timeoutMs = normalizePositiveInteger(value.timeoutMs);
  const aspectRatio = normalizeOptionalString(value.aspectRatio);
  const resolution = normalizeOptionalString(value.resolution);
  const quality = normalizeOptionalString(value.quality);
  return {
    modelId,
    capabilities,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(quality !== undefined ? { quality } : {}),
  };
}

function normalizeProviderModel(value: unknown): ProviderModel | null {
  if (!isRecord(value)) return null;
  const accountId = typeof value.accountId === 'string' ? value.accountId.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const draft = normalizeProviderModelDraft(value);
  if (!accountId || !draft) return null;
  return {
    accountId,
    ...(label ? { label } : {}),
    ...draft,
  };
}

export function normalizeProviderModels(value: unknown): ProviderModel[] {
  const rawModels = isRecord(value) && Array.isArray(value.models) ? value.models : value;
  if (!Array.isArray(rawModels)) return [];
  const out: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const raw of rawModels) {
    const model = normalizeProviderModel(raw);
    if (!model) continue;
    const key = `${model.accountId}\n${model.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

function decodeModelList(value: unknown): ProviderModel[] {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error('Provider models are unavailable');
  }
  const models = normalizeProviderModels(value.models);
  if (models.length !== value.models.length) {
    throw new Error('Provider models are unavailable');
  }
  return models;
}

function decodeDiscoverResult(value: unknown): ProviderModelsDiscoverResult {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.models)) {
    throw new Error('Provider model discovery is unavailable');
  }
  const models: ProviderModelDraft[] = [];
  const seen = new Set<string>();
  for (const raw of value.models) {
    const model = normalizeProviderModelDraft(raw, { strictFields: true });
    if (!model) {
      throw new Error('Provider model discovery is unavailable');
    }
    if (seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    models.push(model);
  }
  return { models };
}

function decodeReplaceResult(value: unknown): ProviderModelsReplaceResult {
  if (isRecord(value)
    && value.success === false
    && value.error === 'Provider model request was rejected') {
    throw new Error('Provider model request was rejected');
  }
  if (!isRecord(value) || value.success !== true) {
    throw new Error('Provider models are unavailable');
  }
  const receipt = decodeProviderMutationReceipt(value, 'committed');
  if (!receipt || receipt.desired.status !== 'stored' || receipt.persisted.status !== 'confirmed') {
    throw new Error('Provider models are unavailable');
  }
  const warning = nativeProjectionError(receipt);
  return {
    desired: { status: 'stored' },
    receipt,
    ...(warning ? { warning } : {}),
  };
}

function logProviderConfigTrace(phase: string, payload: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({
    prefix: '[startup-trace]',
    source: 'provider-model-catalog',
    phase,
    ...payload,
  }));
}

function providerProjectionTrace(receipt: ProviderMutationReceipt): Record<string, unknown> {
  return {
    changed: receipt.native.changed,
    applied: receipt.native.applied.status,
    observed: receipt.native.observed.status,
    diagnostic: receipt.native.diagnostic
      ? {
          phase: receipt.native.diagnostic.phase,
          reason: receipt.native.diagnostic.reason,
          configPath: receipt.native.diagnostic.configPath,
          method: receipt.native.diagnostic.method,
          expectedPath: receipt.native.diagnostic.expectedPath,
          detail: receipt.native.diagnostic.detail
            ? summarizeIdentifier(receipt.native.diagnostic.detail)
            : undefined,
        }
      : undefined,
  };
}

export async function fetchProviderModels(): Promise<ProviderModel[]> {
  return decodeModelList(await hostApiFetch<unknown>('/api/provider-models'));
}

export async function discoverProviderModels(accountId: string): Promise<ProviderModelsDiscoverResult> {
  const trimmedAccountId = accountId.trim();
  if (!trimmedAccountId) {
    throw new Error('Provider account is required');
  }
  return decodeDiscoverResult(await hostApiFetch<unknown>(
    `/api/provider-models/discover?accountId=${encodeURIComponent(trimmedAccountId)}`,
    { timeoutMs: 60_000 },
  ));
}

export async function persistProviderModels(
  accountId: string,
  models: readonly ProviderModelDraft[],
): Promise<ProviderModelsReplaceResult> {
  try {
    logProviderConfigTrace('request-start', { accountId: summarizeIdentifier(accountId), modelCount: models.length });
    const result = await hostApiFetch<unknown>('/api/provider-models', {
      method: 'POST',
      body: JSON.stringify({
        id: 'provider.models',
        operationId: 'providerModels.replace',
        scope: { kind: 'provider-model-catalog' },
        target: { kind: 'provider-models' },
        input: { kind: 'replace', accountId, models },
      }),
    });
    const decoded = decodeReplaceResult(result);
    logProviderConfigTrace('request-finished', providerProjectionTrace(decoded.receipt));
    return decoded;
  } catch (error) {
    logProviderConfigTrace('request-failed', {
      errorName: error instanceof Error ? error.name : typeof error,
      message: summarizeIdentifier(error instanceof Error ? error.message : String(error)),
    });
    if (error instanceof ProviderMutationCommitOutcomeUnknownError) {
      const unknown = new Error('Provider model commit outcome is unknown; reopen before retrying');
      unknown.cause = error;
      throw unknown;
    }
    throw error;
  }
}
