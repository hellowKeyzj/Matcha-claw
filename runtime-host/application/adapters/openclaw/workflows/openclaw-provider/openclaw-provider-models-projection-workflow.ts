/**
 * OpenClaw 模型清单写盘 workflow。
 *
 * 把已经适配为 OpenClaw providerKey 的模型清单 upsert 到 openclaw.json 的：
 *   models.providers.<providerKey>.models = [{ id, name, contextWindow?, maxTokens? }, ...]
 *
 * 这是 OpenClaw adapter projection，不是 MatchaClaw 的模型事实源。
 */

import type { OpenClawConfigRepositoryPort } from '../../infrastructure/openclaw-config-repository';
import { pruneUnknownModelRefsInAgentsConfig } from '../../projections/openclaw-provider-model-pruning';

export interface ProviderModelEntry {
  readonly modelId: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: readonly string[];
  readonly cost?: Record<string, number>;
}

export interface OpenClawProviderModelsEntry {
  readonly baseUrl: string;
  readonly api: string;
  readonly apiKeyEnv?: string;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly replaceProviderKeys?: readonly string[];
  readonly models: readonly ProviderModelEntry[];
}

export type OpenClawProviderModelsMap = Record<string, OpenClawProviderModelsEntry>;

export class OpenClawProviderModelsProjectionWorkflow {
  constructor(private readonly configRepository: OpenClawConfigRepositoryPort) {}

  async readAll(): Promise<Record<string, ProviderModelEntry[]>> {
    const config = await this.configRepository.read();
    const providers = isRecord((isRecord(config.models) ? config.models : {}).providers)
      ? ((config.models as Record<string, unknown>).providers as Record<string, unknown>)
      : {};
    const out: Record<string, ProviderModelEntry[]> = {};
    for (const [providerKey, provider] of Object.entries(providers)) {
      if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
      const entries = provider.models
        .map((entry) => decodeModelEntry(entry))
        .filter((entry): entry is ProviderModelEntry => entry !== null);
      if (entries.length > 0) {
        out[providerKey] = entries;
      }
    }
    return out;
  }

  async replaceAll(providerMap: OpenClawProviderModelsMap, validModelRefs?: readonly string[]): Promise<void> {
    return await this.configRepository.updateDirty((config) => {
      for (const [providerKey, entry] of Object.entries(providerMap)) {
        const normalized = entry.models
          .map((entry) => decodeModelEntry(entry))
          .filter((entry): entry is ProviderModelEntry => entry !== null);
        applyModelsToProviderNode(config, providerKey, {
          ...entry,
          models: normalized,
        });
      }
      if (validModelRefs) {
        pruneUnknownModelRefsInAgentsConfig(config, new Set(validModelRefs));
      }
      return { result: undefined, changed: true };
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeModelEntry(value: unknown): ProviderModelEntry | null {
  if (!isRecord(value)) return null;
  const idCandidate = typeof value.id === 'string' ? value.id : (typeof value.modelId === 'string' ? value.modelId : '');
  const modelId = idCandidate.trim();
  if (!modelId) return null;
  const contextWindow = typeof value.contextWindow === 'number' && Number.isFinite(value.contextWindow) && value.contextWindow > 0
    ? Math.floor(value.contextWindow)
    : undefined;
  const maxTokens = typeof value.maxTokens === 'number' && Number.isFinite(value.maxTokens) && value.maxTokens > 0
    ? Math.floor(value.maxTokens)
    : undefined;
  return {
    modelId,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(Array.isArray(value.input) ? { input: value.input.filter((item): item is string => typeof item === 'string') } : {}),
    ...(normalizeCost(value.cost) ? { cost: normalizeCost(value.cost) } : {}),
  };
}

function ensureProviderNode(config: Record<string, unknown>, providerKey: string): Record<string, unknown> {
  const models = isRecord(config.models) ? { ...config.models } : {};
  const providers = isRecord(models.providers) ? { ...models.providers } : {};
  const provider = isRecord(providers[providerKey]) ? { ...providers[providerKey] as Record<string, unknown> } : {};
  providers[providerKey] = provider;
  models.providers = providers;
  config.models = models;
  return provider;
}

function removeProviderNode(config: Record<string, unknown>, providerKey: string): void {
  const models = isRecord(config.models) ? { ...config.models } : {};
  const providers = isRecord(models.providers) ? { ...models.providers } : {};
  delete providers[providerKey];
  models.providers = providers;
  config.models = models;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].trim().length > 0 && entry[1].trim().length > 0)
    .map(([key, item]) => [key, item.trim()] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeCost(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0) {
      out[key] = item;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function zeroCost(): Record<string, number> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

function applyModelsToProviderNode(
  config: Record<string, unknown>,
  providerKey: string,
  entry: OpenClawProviderModelsEntry,
): void {
  for (const oldProviderKey of entry.replaceProviderKeys ?? []) {
    if (oldProviderKey && oldProviderKey !== providerKey) {
      removeProviderNode(config, oldProviderKey);
    }
  }
  const provider = ensureProviderNode(config, providerKey);
  const baseUrl = normalizeString(entry.baseUrl);
  const api = normalizeString(entry.api);
  if (!baseUrl || !api) {
    removeProviderNode(config, providerKey);
    return;
  }
  provider.baseUrl = baseUrl;
  provider.api = api;
  if (entry.apiKeyEnv) provider.apiKey = entry.apiKeyEnv;
  const headers = normalizeHeaders(entry.headers);
  if (headers) {
    provider.headers = headers;
  } else {
    delete provider.headers;
  }
  if (entry.authHeader !== undefined) {
    provider.authHeader = entry.authHeader;
  } else {
    delete provider.authHeader;
  }
  const entries = entry.models;
  provider.models = entries.map((entry) => {
    const out: Record<string, unknown> = {
      id: entry.modelId,
      name: entry.modelId,
    };
    if (entry.input) out.input = entry.input;
    if (entry.contextWindow !== undefined) out.contextWindow = entry.contextWindow;
    if (entry.maxTokens !== undefined) out.maxTokens = entry.maxTokens;
    out.cost = normalizeCost(entry.cost) ?? zeroCost();
    return out;
  });
}
