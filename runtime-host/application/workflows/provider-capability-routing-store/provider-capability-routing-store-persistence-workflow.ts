import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { CapabilityRouting, ModelRef, ModelRoute } from '../../providers/provider-types';
import type {
  CapabilityRoutingStoragePort,
  CapabilityRoutingStoreRecord,
} from '../../providers/capability-routing-store';

const ROUTE_FIELDS = [
  'chat',
  'imageUnderstand',
  'imageGenerate',
  'videoGenerate',
  'musicGenerate',
  'tts',
] as const;

export interface ProviderCapabilityRoutingStorePersistenceWorkflowDeps {
  readonly storage: CapabilityRoutingStoragePort;
  readonly fileSystem: RuntimeFileSystemPort;
}

export class ProviderCapabilityRoutingStorePersistenceWorkflow {
  private cachedStore: CapabilityRoutingStoreRecord | null = null;
  private cachedStat: { size: number; mtimeMs: number } | null = null;

  constructor(private readonly deps: ProviderCapabilityRoutingStorePersistenceWorkflowDeps) {}

  async read(): Promise<CapabilityRoutingStoreRecord> {
    const filePath = this.deps.storage.getCapabilityRoutingStoreFilePath();
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

  async write(store: CapabilityRoutingStoreRecord): Promise<void> {
    const filePath = this.deps.storage.getCapabilityRoutingStoreFilePath();
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

function normalizeRef(value: unknown): ModelRef | null {
  if (!isRecord(value)) return null;
  const credentialId = typeof value.credentialId === 'string' ? value.credentialId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  if (!credentialId || !modelId) return null;
  return { credentialId, modelId };
}

function normalizeRoute(value: unknown): ModelRoute | undefined {
  if (!isRecord(value)) return undefined;
  const primary = normalizeRef(value.primary);
  if (!primary) return undefined;
  const fallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks
      .map((entry) => normalizeRef(entry))
      .filter((entry): entry is ModelRef => entry !== null)
    : [];
  const timeoutMs = typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
    ? Math.floor(value.timeoutMs)
    : undefined;
  return {
    primary,
    fallbacks,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function normalizeRouting(value: unknown): CapabilityRouting {
  if (!isRecord(value)) return {};
  const routing: CapabilityRouting = {};
  for (const field of ROUTE_FIELDS) {
    const route = normalizeRoute(value[field]);
    if (route) routing[field] = route;
  }
  return routing;
}

function createEmptyStore(): CapabilityRoutingStoreRecord {
  return { schemaVersion: 1, routing: {} };
}

function cloneRoute(route: ModelRoute): ModelRoute {
  return {
    primary: { ...route.primary },
    fallbacks: route.fallbacks.map((fallback) => ({ ...fallback })),
    ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : {}),
  };
}

function cloneRouting(routing: CapabilityRouting): CapabilityRouting {
  return {
    ...(routing.chat ? { chat: cloneRoute(routing.chat) } : {}),
    ...(routing.imageUnderstand ? { imageUnderstand: cloneRoute(routing.imageUnderstand) } : {}),
    ...(routing.imageGenerate ? { imageGenerate: cloneRoute(routing.imageGenerate) } : {}),
    ...(routing.videoGenerate ? { videoGenerate: cloneRoute(routing.videoGenerate) } : {}),
    ...(routing.musicGenerate ? { musicGenerate: cloneRoute(routing.musicGenerate) } : {}),
    ...(routing.tts ? { tts: cloneRoute(routing.tts) } : {}),
  };
}

function cloneStore(store: CapabilityRoutingStoreRecord): CapabilityRoutingStoreRecord {
  return { schemaVersion: 1, routing: cloneRouting(store.routing) };
}

function normalizeStore(value: unknown): CapabilityRoutingStoreRecord {
  if (!isRecord(value)) return createEmptyStore();
  return {
    schemaVersion: 1,
    routing: normalizeRouting(value.routing),
  };
}
