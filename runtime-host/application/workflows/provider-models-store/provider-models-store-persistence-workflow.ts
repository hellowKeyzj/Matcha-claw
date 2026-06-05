import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import { MODEL_CAPABILITIES } from '../../providers/provider-model-capabilities';
import type { ModelCapability, ProviderModel } from '../../providers/provider-types';
import type {
  ProviderModelsStoragePort,
  ProviderModelsStoreRecord,
} from '../../providers/provider-models-store';

const MODEL_CAPABILITY_SET = new Set<ModelCapability>(MODEL_CAPABILITIES);

export interface ProviderModelsStorePersistenceWorkflowDeps {
  readonly storage: ProviderModelsStoragePort;
  readonly fileSystem: RuntimeFileSystemPort;
}

export class ProviderModelsStorePersistenceWorkflow {
  private cachedStore: ProviderModelsStoreRecord | null = null;
  private cachedStat: { size: number; mtimeMs: number } | null = null;

  constructor(private readonly deps: ProviderModelsStorePersistenceWorkflowDeps) {}

  async read(): Promise<ProviderModelsStoreRecord> {
    const filePath = this.deps.storage.getProviderModelsStoreFilePath();
    const stat = await this.readStoreStat(filePath);

    if (
      stat
      && this.cachedStore
      && this.cachedStat
      && this.cachedStat.size === stat.size
      && this.cachedStat.mtimeMs === stat.mtimeMs
    ) {
      return cloneStore(this.cachedStore);
    }

    try {
      const normalized = normalizeStore(JSON.parse(await this.deps.fileSystem.readTextFile(filePath)));
      this.cachedStore = cloneStore(normalized);
      this.cachedStat = stat;
      return normalized;
    } catch {
      this.cachedStore = null;
      this.cachedStat = null;
      return createEmptyStore();
    }
  }

  async write(store: ProviderModelsStoreRecord): Promise<void> {
    const filePath = this.deps.storage.getProviderModelsStoreFilePath();
    await this.deps.storage.ensureParentDir(filePath);
    await this.deps.fileSystem.writeTextFile(filePath, `${JSON.stringify(cloneStore(store), null, 2)}\n`);
    this.cachedStore = null;
    this.cachedStat = null;
  }

  private async readStoreStat(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const fileStat = await this.deps.fileSystem.stat(filePath);
      return { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
    } catch {
      return null;
    }
  }
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
    if (!MODEL_CAPABILITY_SET.has(raw as ModelCapability) || seen.has(raw as ModelCapability)) continue;
    seen.add(raw as ModelCapability);
    out.push(raw as ModelCapability);
  }
  return out;
}

function normalizeProviderModel(value: unknown): ProviderModel | null {
  if (!isRecord(value)) return null;
  const credentialId = typeof value.credentialId === 'string' ? value.credentialId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  if (!credentialId || !modelId) return null;
  const capabilities = normalizeCapabilities(value.capabilities);
  if (capabilities.length === 0) return null;
  const contextWindow = normalizePositiveInteger(value.contextWindow);
  const maxTokens = normalizePositiveInteger(value.maxTokens);
  const timeoutMs = normalizePositiveInteger(value.timeoutMs);
  const aspectRatio = normalizeOptionalString(value.aspectRatio);
  const resolution = normalizeOptionalString(value.resolution);
  const quality = normalizeOptionalString(value.quality);
  return {
    credentialId,
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

function createEmptyStore(): ProviderModelsStoreRecord {
  return { schemaVersion: 1, models: [] };
}

function cloneStore(store: ProviderModelsStoreRecord): ProviderModelsStoreRecord {
  return {
    schemaVersion: 1,
    models: store.models.map((model) => ({
      ...model,
      capabilities: [...model.capabilities],
    })),
  };
}

function normalizeStore(value: unknown): ProviderModelsStoreRecord {
  if (!isRecord(value) || !Array.isArray(value.models)) return createEmptyStore();
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const raw of value.models) {
    const model = normalizeProviderModel(raw);
    if (!model) continue;
    const key = `${model.credentialId}\n${model.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(model);
  }
  return { schemaVersion: 1, models };
}
