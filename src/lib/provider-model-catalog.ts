import { hostApiFetch } from '@/lib/host-api';
import { nativeProjectionError } from '@/lib/provider-projection-errors';
import { isProviderMutationCommitted, waitForProviderMutation } from '@/lib/provider-call';
import { decodeProviderCallDetail, type ProviderCallDetail } from '@/types/call-log/provider';
import { decodeCallReceipt } from '@/types/call-log/receipt';
import { waitForCall } from '@/lib/call-log-await';
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
  receipt: ProviderCallDetail;
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

function decodeDiscoverResult(value: unknown, callId: string, accountId: string, count: number | null): ProviderModelsDiscoverResult {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.callId !== callId || value.accountId !== accountId || !Array.isArray(value.models) || value.models.length !== count) {
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

function logProviderConfigTrace(phase: string, payload: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({
    prefix: '[startup-trace]',
    source: 'provider-model-catalog',
    phase,
    ...payload,
  }));
}

function providerProjectionTrace(receipt: ProviderCallDetail): Record<string, unknown> {
  return {
    changed: receipt.native?.changed,
    applied: receipt.native?.applied,
    observed: receipt.native?.observed,
    diagnostic: receipt.diagnostic,
  };
}

export async function fetchProviderModels(): Promise<ProviderModel[]> {
  return decodeModelList(await hostApiFetch<unknown>('/api/provider-models'));
}

export async function discoverProviderModels(accountId: string, signal?: AbortSignal): Promise<ProviderModelsDiscoverResult> {
  const trimmedAccountId = accountId.trim();
  if (!trimmedAccountId) {
    throw new Error('Provider account is required');
  }
  const receipt = decodeCallReceipt(await hostApiFetch<unknown>(
    `/api/provider-models/discover?accountId=${encodeURIComponent(trimmedAccountId)}`,
    { signal },
  ));
  const call = await waitForCall(receipt, 'provider', { signal });
  const detail = decodeProviderCallDetail(call.detail);
  if (call.command !== 'providerModels.discover' || !detail || detail.kind !== 'discoverModels'
    || detail.accountId !== trimmedAccountId) throw new Error('Provider discovery call identity is invalid');
  if (call.status === 'unknown' || detail.outcome === 'unknown') {
    throw new Error('Provider model discovery outcome is unknown; reopen before retrying');
  }
  if (detail.outcome === 'rejected') throw new Error('Provider model request was rejected');
  if (call.status !== 'succeeded' || detail.phase !== 'terminal' || detail.outcome !== 'discovered') {
    throw new Error('Provider models are unavailable');
  }
  const result = decodeDiscoverResult(await hostApiFetch<unknown>(
    `/api/provider-models/discovery-result?${new URLSearchParams({ callId: receipt.callId, accountId: trimmedAccountId })}`,
    { signal },
  ), receipt.callId, trimmedAccountId, detail.count);
  return result;
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
    const receipt = await waitForProviderMutation(result, 'providerModels.replace', { accountId });
    logProviderConfigTrace('request-finished', providerProjectionTrace(receipt));
    if (!isProviderMutationCommitted(receipt, 'stored')) {
      if (receipt.outcome === 'rejected' || receipt.outcome === 'missing') {
        throw new Error('Provider model request was rejected');
      }
      if (receipt.phase !== 'terminal' || receipt.outcome === 'unknown'
        || receipt.commit === 'unknown' || receipt.persisted === 'unknown') {
        throw new Error('Provider model commit outcome is unknown; reopen before retrying');
      }
      throw new Error('Provider models are unavailable');
    }
    const warning = nativeProjectionError(receipt);
    return { receipt, ...(warning ? { warning } : {}) };
  } catch (error) {
    logProviderConfigTrace('request-failed', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}
