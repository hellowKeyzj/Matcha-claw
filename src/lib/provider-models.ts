import { hostApiFetch } from '@/lib/host-api';
import type { ModelCapability } from '@/lib/provider-model-catalog';
import { MODEL_CAPABILITIES } from '@/lib/provider-model-capabilities';
import type { ModelCatalogEntry } from '@/types/subagent';

interface SelectableProviderModel {
  accountId: string;
  selectionId: string;
  label?: string;
  modelId: string;
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxTokens?: number;
}

const MODEL_CAPABILITY_SET = new Set<ModelCapability>(MODEL_CAPABILITIES);
const LEGACY_MODEL_FIELDS = ['credentialId', 'providerKey', 'runtimeModelRef'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasLegacyModelFields(value: Record<string, unknown>): boolean {
  return LEGACY_MODEL_FIELDS.some((field) => Object.hasOwn(value, field));
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
  if (!isRecord(value) || hasLegacyModelFields(value)) return null;
  const accountId = typeof value.accountId === 'string' ? value.accountId.trim() : '';
  const selectionId = typeof value.selectionId === 'string' ? value.selectionId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const capabilities = normalizeCapabilities(value.capabilities);
  if (!accountId || !selectionId || !modelId || capabilities.length === 0) return null;
  const contextWindow = normalizePositiveInteger(value.contextWindow);
  const maxTokens = normalizePositiveInteger(value.maxTokens);
  return {
    accountId,
    selectionId,
    ...(label ? { label } : {}),
    modelId,
    capabilities,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export function buildSelectableProviderModels(models: readonly SelectableProviderModel[]): ModelCatalogEntry[] {
  const out: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.selectionId)) continue;
    seen.add(model.selectionId);
    const providerLabel = model.label || model.accountId;
    out.push({
      id: model.selectionId,
      provider: providerLabel,
      accountId: model.accountId,
      providerLabel,
      modelLabel: model.modelId,
      displayLabel: `${providerLabel} / ${model.modelId}`,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    });
  }
  return out.sort((left, right) => left.displayLabel.localeCompare(right.displayLabel));
}

export async function fetchSelectableProviderModels(
  capability: ModelCapability = 'chat',
): Promise<ModelCatalogEntry[]> {
  const payload = await hostApiFetch<unknown>(
    `/api/provider-models/selectable?capability=${encodeURIComponent(capability)}`,
  );
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error('Provider models are unavailable');
  }
  const models = payload.models
    .map((model) => normalizeSelectableModel(model))
    .filter((model): model is SelectableProviderModel => model !== null);
  if (models.length !== payload.models.length) {
    throw new Error('Provider models are unavailable');
  }
  return buildSelectableProviderModels(models);
}
