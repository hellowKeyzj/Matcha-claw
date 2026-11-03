import type { ModelCapability, ProviderCredential, ProviderVendorInfo } from '../domain/providers';
import { resolveProviderModelCapabilities } from '../domain/provider-model-capabilities';
import type { ProviderModel, ProviderModelDraft } from '../services/provider-model-catalog';

export interface ModelDraftRow {
  modelId: string;
  capabilities: ModelCapability[];
  contextWindow: string;
  maxTokens: string;
  timeoutMs: string;
  aspectRatio: string;
  resolution: string;
  quality: string;
}

export function modelToDraftRow(model: ProviderModelDraft): ModelDraftRow {
  return {
    modelId: model.modelId,
    capabilities: [...model.capabilities],
    contextWindow: model.contextWindow ? String(model.contextWindow) : '',
    maxTokens: model.maxTokens ? String(model.maxTokens) : '',
    timeoutMs: model.timeoutMs ? String(model.timeoutMs) : '',
    aspectRatio: model.aspectRatio ?? '',
    resolution: model.resolution ?? '',
    quality: model.quality ?? '',
  };
}

function parsePositiveInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function draftRowToModel(row: ModelDraftRow): Omit<ProviderModel, 'accountId'> | null {
  const modelId = row.modelId.trim();
  if (!modelId || row.capabilities.length === 0) return null;
  const contextWindow = parsePositiveInteger(row.contextWindow);
  const maxTokens = parsePositiveInteger(row.maxTokens);
  const timeoutMs = parsePositiveInteger(row.timeoutMs);
  const aspectRatio = row.aspectRatio.trim();
  const resolution = row.resolution.trim();
  const quality = row.quality.trim();
  return {
    modelId,
    capabilities: row.capabilities,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(quality ? { quality } : {}),
  };
}

export function collectDraftModels(credential: ProviderCredential, rows: readonly ModelDraftRow[], vendor?: ProviderVendorInfo):
  | { models: Omit<ProviderModel, 'accountId'>[] }
  | { error: 'invalidEntry' | 'duplicate'; modelId: string } {
  const models: Omit<ProviderModel, 'accountId'>[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.modelId.trim()) continue;
    const allowed = resolveProviderModelCapabilities(credential, vendor);
    if (row.capabilities.some((capability) => !allowed.includes(capability))
      || [row.contextWindow, row.maxTokens, row.timeoutMs].some((value) => value.trim() && parsePositiveInteger(value) === undefined)) {
      return { error: 'invalidEntry', modelId: row.modelId };
    }
    const model = draftRowToModel(row);
    if (!model) return { error: 'invalidEntry', modelId: row.modelId };
    if (seen.has(model.modelId)) return { error: 'duplicate', modelId: model.modelId };
    seen.add(model.modelId);
    models.push(model);
  }
  return { models };
}
