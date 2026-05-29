import { join } from 'node:path';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawConfigRepositoryPort } from './openclaw-config-repository';

export interface OpenClawAgentModelEntry {
  readonly id: string;
  readonly name?: string;
  readonly input?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: Record<string, number>;
}

export interface OpenClawAgentModelProviderEntry {
  readonly baseUrl: string;
  readonly api: string;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly models?: readonly OpenClawAgentModelEntry[];
}

export interface OpenClawAgentModelRepositoryPort {
  upsertProviderInAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
    entry: OpenClawAgentModelProviderEntry;
  }): Promise<string[]>;
  removeProviderFromAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
  }): Promise<string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
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

function normalizeModelEntry(entry: OpenClawAgentModelEntry): Record<string, unknown> | null {
  const id = normalizeString(entry.id);
  if (!id) return null;
  const out: Record<string, unknown> = {
    id,
    name: normalizeString(entry.name) ?? id,
  };
  const input = Array.isArray(entry.input)
    ? entry.input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : undefined;
  if (input && input.length > 0) out.input = [...new Set(input)];
  const contextWindow = normalizePositiveInteger(entry.contextWindow);
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  const maxTokens = normalizePositiveInteger(entry.maxTokens);
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  const cost = normalizeCost(entry.cost);
  if (cost) out.cost = cost;
  return out;
}

function modelsPathFor(configDir: string, agentId: string): string {
  return join(configDir, 'agents', agentId, 'agent', 'models.json');
}

export class OpenClawAgentModelRepository implements OpenClawAgentModelRepositoryPort {
  constructor(
    private readonly configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir'>,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  async upsertProviderInAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
    entry: OpenClawAgentModelProviderEntry;
  }): Promise<string[]> {
    const provider = normalizeString(input.provider);
    const baseUrl = normalizeString(input.entry.baseUrl);
    const api = normalizeString(input.entry.api);
    if (!provider || !baseUrl || !api) {
      return [];
    }
    const touchedAgentIds: string[] = [];
    for (const agentId of input.agentIds) {
      const modelsPath = modelsPathFor(this.configRepository.getConfigDir(), agentId);
      const rawData = await this.readModelsJson(modelsPath);
      const data = isRecord(rawData) ? rawData : {};
      const providers = isRecord(data.providers) ? { ...data.providers } : {};
      const existing = isRecord(providers[provider]) ? { ...providers[provider] as Record<string, unknown> } : {};
      existing.baseUrl = baseUrl;
      existing.api = api;
      delete existing.apiKey;
      delete existing.apiKeyEnv;
      const headers = normalizeHeaders(input.entry.headers);
      if (headers) existing.headers = headers;
      else delete existing.headers;
      if (input.entry.authHeader !== undefined) existing.authHeader = input.entry.authHeader;
      else delete existing.authHeader;
      if (input.entry.models) {
        existing.models = input.entry.models
          .map((model) => normalizeModelEntry(model))
          .filter((model): model is Record<string, unknown> => model !== null);
      } else if (!Array.isArray(existing.models)) {
        existing.models = [];
      }
      providers[provider] = existing;
      data.providers = providers;
      await this.writeModelsJson(modelsPath, data);
      touchedAgentIds.push(agentId);
    }
    return touchedAgentIds;
  }

  async removeProviderFromAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
  }): Promise<string[]> {
    const touchedAgentIds: string[] = [];
    for (const agentId of input.agentIds) {
      const modelsPath = modelsPathFor(this.configRepository.getConfigDir(), agentId);
      if (!(await this.fileSystem.exists(modelsPath))) {
        continue;
      }
      const raw = await this.fileSystem.readTextFile(modelsPath);
      const data = JSON.parse(raw) as Record<string, unknown>;
      const providers = data.providers as Record<string, unknown> | undefined;
      if (!providers || !providers[input.provider]) {
        continue;
      }
      delete providers[input.provider];
      await this.writeModelsJson(modelsPath, data);
      touchedAgentIds.push(agentId);
    }
    return touchedAgentIds;
  }

  private async readModelsJson(modelsPath: string): Promise<unknown> {
    try {
      if (!(await this.fileSystem.exists(modelsPath))) return {};
      return JSON.parse(await this.fileSystem.readTextFile(modelsPath)) as unknown;
    } catch {
      return {};
    }
  }

  private async writeModelsJson(modelsPath: string, data: Record<string, unknown>): Promise<void> {
    await this.fileSystem.ensureDirectory(join(modelsPath, '..'));
    await this.fileSystem.writeTextFile(modelsPath, JSON.stringify(data, null, 2));
  }
}
