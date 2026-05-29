import { hostApiFetch } from '@/lib/host-api';
import type { ModelCapability } from '@/lib/provider-model-catalog';
import { MODEL_CAPABILITIES } from '@/lib/provider-model-capabilities';
import type { ModelCatalogEntry } from '@/types/subagent';

type SelectableProviderModel = {
  credentialId: string;
  providerKey: string;
  runtimeModelRef: string;
  label?: string;
  modelId: string;
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxTokens?: number;
};

const MODEL_CAPABILITY_SET = new Set<ModelCapability>(MODEL_CAPABILITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
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

function normalizeSelectableModel(value: unknown): SelectableProviderModel | null {
  if (!isRecord(value)) return null;
  const credentialId = typeof value.credentialId === 'string' ? value.credentialId.trim() : '';
  const providerKey = typeof value.providerKey === 'string' ? value.providerKey.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const runtimeModelRef = typeof value.runtimeModelRef === 'string' ? value.runtimeModelRef.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const capabilities = normalizeCapabilities(value.capabilities);
  if (!credentialId || !providerKey || !modelId || !runtimeModelRef || capabilities.length === 0) return null;
  const contextWindow = normalizePositiveInteger(value.contextWindow);
  const maxTokens = normalizePositiveInteger(value.maxTokens);
  return {
    credentialId,
    providerKey,
    modelId,
    runtimeModelRef,
    label,
    capabilities,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export function buildSelectableProviderModels(models: readonly SelectableProviderModel[]): ModelCatalogEntry[] {
  const out: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const modelRef = model.runtimeModelRef?.trim();
    if (!modelRef) continue;
    if (seen.has(modelRef)) continue;
    seen.add(modelRef);
    const providerLabel = model.label || model.providerKey || model.credentialId;
    out.push({
      id: modelRef,
      provider: model.providerKey || model.credentialId,
      credentialId: model.credentialId,
      providerLabel,
      modelLabel: model.modelId,
      displayLabel: `${providerLabel} / ${model.modelId}`,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    });
  }
  return out.sort((left, right) => left.displayLabel.localeCompare(right.displayLabel));
}

export async function fetchSelectableProviderModels(): Promise<ModelCatalogEntry[]> {
  const payload = await hostApiFetch<unknown>('/api/provider-models/selectable');
  const rawModels = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  return buildSelectableProviderModels(
    rawModels
      .map((model) => normalizeSelectableModel(model))
      .filter((model): model is SelectableProviderModel => model !== null),
  );
}
