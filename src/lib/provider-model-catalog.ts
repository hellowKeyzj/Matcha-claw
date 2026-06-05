import { hostCapabilityExecute } from '@/lib/host-api';
import type { ModelCapability } from '@/lib/providers';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';
import { MODEL_CAPABILITIES } from '@/lib/provider-model-capabilities';

export type { ModelCapability } from '@/lib/providers';

export interface ProviderModel {
  credentialId: string;
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

const MODEL_PROVIDER_CAPABILITY_ID = 'model.provider';
const MODEL_CAPABILITY_SET = new Set<ModelCapability>(MODEL_CAPABILITIES);

async function modelProviderCapabilityExecute<TResult>(
  operationId: string,
  runtimeAddress: RuntimeAddress,
  input: Record<string, unknown> = {},
): Promise<TResult> {
  return await hostCapabilityExecute<TResult>({
    id: MODEL_PROVIDER_CAPABILITY_ID,
    operationId,
    runtimeAddress,
    input: {
      ...input,
      runtimeAddress,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function normalizeProviderModel(value: unknown): ProviderModel | null {
  if (!isRecord(value)) return null;
  const credentialId = typeof value.credentialId === 'string' ? value.credentialId.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const capabilities = normalizeCapabilities(value.capabilities);
  if (!credentialId || !modelId || capabilities.length === 0) return null;
  const contextWindow = normalizePositiveInteger(value.contextWindow);
  const maxTokens = normalizePositiveInteger(value.maxTokens);
  const timeoutMs = normalizePositiveInteger(value.timeoutMs);
  const aspectRatio = normalizeOptionalString(value.aspectRatio);
  const resolution = normalizeOptionalString(value.resolution);
  const quality = normalizeOptionalString(value.quality);
  return {
    credentialId,
    ...(label ? { label } : {}),
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

export function normalizeProviderModels(value: unknown): ProviderModel[] {
  const rawModels = isRecord(value) && Array.isArray(value.models) ? value.models : value;
  if (!Array.isArray(rawModels)) return [];
  const out: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const raw of rawModels) {
    const model = normalizeProviderModel(raw);
    if (!model) continue;
    const key = `${model.credentialId}\n${model.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

export async function fetchProviderModels(runtimeAddress: RuntimeAddress): Promise<ProviderModel[]> {
  return normalizeProviderModels(await modelProviderCapabilityExecute<unknown>(
    'providerModels.list',
    runtimeAddress,
  ));
}

export async function persistProviderModels(
  credentialId: string,
  models: readonly Omit<ProviderModel, 'credentialId'>[],
  runtimeAddress: RuntimeAddress,
): Promise<{ success: boolean; credentialId: string; models: ProviderModel[]; error?: string }> {
  const result = await modelProviderCapabilityExecute<{ success?: boolean; credentialId?: string; models?: unknown; error?: string }>(
    'providerModels.replace',
    runtimeAddress,
    { credentialId, models },
  );
  return {
    success: result?.success === true,
    credentialId: typeof result?.credentialId === 'string' ? result.credentialId : credentialId,
    models: normalizeProviderModels(result?.models),
    ...(typeof result?.error === 'string' ? { error: result.error } : {}),
  };
}
