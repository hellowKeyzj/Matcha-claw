import { join } from 'node:path';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';

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

export interface OpenClawAgentModelStoreConfigPort {
  getConfigDir(): string;
}

export interface OpenClawAgentModelStoreWorkflowDeps {
  readonly configRepository: OpenClawAgentModelStoreConfigPort;
  readonly fileSystem: RuntimeFileSystemPort;
}

export class OpenClawAgentModelStoreWorkflow {
  constructor(private readonly deps: OpenClawAgentModelStoreWorkflowDeps) {}

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
      const modelsPath = this.modelsPathFor(agentId);
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
      const modelsPath = this.modelsPathFor(agentId);
      if (!(await this.deps.fileSystem.exists(modelsPath))) {
        continue;
      }
      const raw = await this.deps.fileSystem.readTextFile(modelsPath);
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

  private modelsPathFor(agentId: string): string {
    return join(this.deps.configRepository.getConfigDir(), 'agents', agentId, 'agent', 'models.json');
  }

  private async readModelsJson(modelsPath: string): Promise<unknown> {
    try {
      if (!(await this.deps.fileSystem.exists(modelsPath))) return {};
      return JSON.parse(await this.deps.fileSystem.readTextFile(modelsPath)) as unknown;
    } catch {
      return {};
    }
  }

  private async writeModelsJson(modelsPath: string, data: Record<string, unknown>): Promise<void> {
    await this.deps.fileSystem.ensureDirectory(join(modelsPath, '..'));
    await this.deps.fileSystem.writeTextFile(modelsPath, JSON.stringify(data, null, 2));
  }
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
