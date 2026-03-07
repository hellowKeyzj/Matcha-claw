import type { ConfigGetResult, ConfigProviderEntry } from '@/types/subagent';

function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeModelIdWithProviderHint(
  rawModelId: string | undefined,
  providerHint?: string,
): string | undefined {
  const normalizedRawModelId = getOptionalString(rawModelId);
  if (!normalizedRawModelId) {
    return undefined;
  }
  const normalizedProviderHint = getOptionalString(providerHint);
  if (!normalizedProviderHint) {
    return normalizedRawModelId;
  }
  if (normalizedRawModelId.includes('/')) {
    return normalizedRawModelId;
  }
  return `${normalizedProviderHint}/${normalizedRawModelId}`;
}

function pushUniqueModelId(
  modelId: string | undefined,
  ordered: string[],
  seen: Set<string>,
): void {
  if (!modelId || seen.has(modelId)) {
    return;
  }
  seen.add(modelId);
  ordered.push(modelId);
}

function collectModelIdsFromProviders(
  configGetResult: ConfigGetResult,
  ordered: string[],
  seen: Set<string>,
): void {
  const providers = configGetResult.config?.models?.providers;
  if (!providers || typeof providers !== 'object') {
    return;
  }

  for (const [providerId, providerEntry] of Object.entries(providers)) {
    const providerHint = getOptionalString(providerId);
    const providerModels = (providerEntry as ConfigProviderEntry | undefined)?.models;
    if (!Array.isArray(providerModels)) {
      continue;
    }
    for (const modelEntry of providerModels) {
      if (typeof modelEntry === 'string') {
        pushUniqueModelId(
          normalizeModelIdWithProviderHint(modelEntry, providerHint),
          ordered,
          seen,
        );
        continue;
      }
      if (!modelEntry || typeof modelEntry !== 'object') {
        continue;
      }
      const rawModelId = getOptionalString((modelEntry as { id?: unknown }).id);
      pushUniqueModelId(
        normalizeModelIdWithProviderHint(rawModelId, providerHint),
        ordered,
        seen,
      );
    }
  }
}

function collectModelIdsFromAgentDefaultsModels(
  configGetResult: ConfigGetResult,
  ordered: string[],
  seen: Set<string>,
): void {
  const defaultsModels = configGetResult.config?.agents?.defaults?.models;
  if (!defaultsModels || typeof defaultsModels !== 'object' || Array.isArray(defaultsModels)) {
    return;
  }

  for (const [rawModelId] of Object.entries(defaultsModels)) {
    pushUniqueModelId(getOptionalString(rawModelId), ordered, seen);
  }
}

export function collectConfiguredModelIdsFromConfig(configGetResult?: ConfigGetResult): string[] {
  if (!configGetResult) {
    return [];
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  collectModelIdsFromProviders(configGetResult, ordered, seen);
  collectModelIdsFromAgentDefaultsModels(configGetResult, ordered, seen);
  return ordered;
}

