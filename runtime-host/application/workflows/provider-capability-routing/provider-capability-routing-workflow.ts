import { badRequest, ok, type ApplicationResponse } from '../../common/application-response';
import type { ProviderStorePort } from '../../providers/provider-store-repository';
import type { CapabilityRoutingStorePort } from '../../providers/capability-routing-store';
import type { ProviderModelsStorePort } from '../../providers/provider-models-store';
import type { CapabilityRouting, ModelRef, ModelRoute, ProviderModel } from '../../providers/provider-types';
import {
  isRecord,
  normalizeProviderStoreForProjection,
  type ProviderProjectionKeyResolverPort,
} from '../../providers/provider-store-model';
import {
  MATCHACLAW_MEDIA_PROVIDER_ID,
  isCustomMediaCredential,
  parseMatchaClawMediaRouteModelId,
  toMatchaClawMediaRouteModelId,
} from '../../providers/custom-media-runtime-projection';
import type {
  CapabilityRoutingProjectionModelRef,
  CapabilityRoutingProjectionPort,
  CapabilityRoutingProjectionRoute,
  CapabilityRoutingProjectionValue,
} from '../../providers/capability-routing-service';

const ROUTE_FIELDS = [
  'chat',
  'imageUnderstand',
  'imageGenerate',
  'videoGenerate',
  'musicGenerate',
  'tts',
] as const;

export interface ProviderCapabilityRoutingWorkflowDeps {
  readonly store: CapabilityRoutingStorePort;
  readonly credentials: ProviderStorePort;
  readonly models: ProviderModelsStorePort;
  readonly writer: CapabilityRoutingProjectionPort;
  readonly projectionKeys: ProviderProjectionKeyResolverPort;
}

export class ProviderCapabilityRoutingWorkflow {
  constructor(private readonly deps: ProviderCapabilityRoutingWorkflowDeps) {}

  async read(): Promise<CapabilityRouting> {
    const store = await this.deps.store.read();
    const prunedRouting = pruneRoutesUnavailableInCatalog(store.routing, (await this.deps.models.read()).models);
    if (JSON.stringify(prunedRouting) !== JSON.stringify(store.routing)) {
      store.routing = prunedRouting;
      await this.deps.store.write(store);
    }
    if (hasRouting(store.routing)) {
      await this.syncRuntimeRoutingProjectionIfStale(store.routing);
      return store.routing;
    }
    const imported = await this.importRuntimeRoutingProjection();
    if (!hasRouting(imported)) {
      return store.routing;
    }
    store.routing = imported;
    await this.deps.store.write(store);
    return imported;
  }

  async write(payload: unknown): Promise<ApplicationResponse> {
    const decoded = decodeRouting(payload);
    if (!decoded) {
      return badRequest('capability routing payload 参数无效');
    }
    const store = await this.deps.store.read();
    await this.syncRuntimeRoutingProjection(decoded);
    store.routing = decoded;
    await this.deps.store.write(store);
    return ok({ success: true, routing: decoded });
  }

  async syncRuntimeProjection(): Promise<void> {
    await this.syncRuntimeRoutingProjection(await this.read());
  }

  async removeCredentialRoutes(credentialId: string): Promise<void> {
    const store = await this.deps.store.read();
    const next = pruneCredentialRoutes(store.routing, credentialId);
    if (JSON.stringify(next) === JSON.stringify(store.routing)) return;
    store.routing = next;
    await this.deps.store.write(store);
    await this.syncRuntimeRoutingProjection(next);
  }

  async pruneUnavailableModelRoutes(models: readonly ProviderModel[]): Promise<void> {
    const store = await this.deps.store.read();
    const next = pruneRoutesUnavailableInCatalog(store.routing, models);
    if (JSON.stringify(next) === JSON.stringify(store.routing)) return;
    store.routing = next;
    await this.deps.store.write(store);
    await this.syncRuntimeRoutingProjection(next);
  }

  private async syncRuntimeRoutingProjection(routing: CapabilityRouting): Promise<void> {
    await this.deps.writer.replace(await this.buildRuntimeRoutingProjection(routing));
  }

  private async syncRuntimeRoutingProjectionIfStale(routing: CapabilityRouting): Promise<void> {
    const projected = await this.buildRuntimeRoutingProjection(routing);
    const current = await this.deps.writer.read();
    if (JSON.stringify(current) === JSON.stringify(projected)) {
      return;
    }
    await this.deps.writer.replace(projected);
  }

  private async buildRuntimeRoutingProjection(routing: CapabilityRouting): Promise<CapabilityRoutingProjectionValue> {
    const providerStore = await this.deps.credentials.read();
    const { accounts, storeModified } = normalizeProviderStoreForProjection(providerStore, this.deps.projectionKeys);
    if (storeModified) {
      await this.deps.credentials.write(providerStore);
    }
    const routeContextByCredentialId = new Map(accounts.map((account) => [
      account.accountId,
      resolveRoutingRefContext(account),
    ]));
    return toRuntimeRoutingProjection(routing, routeContextByCredentialId);
  }

  private async importRuntimeRoutingProjection(): Promise<CapabilityRouting> {
    const providerStore = await this.deps.credentials.read();
    const { accounts, storeModified } = normalizeProviderStoreForProjection(providerStore, this.deps.projectionKeys);
    if (storeModified) {
      await this.deps.credentials.write(providerStore);
    }
    const models = (await this.deps.models.read()).models;
    const credentialIdByProviderKey = new Map(accounts.map((account) => [account.providerKey, account.accountId]));
    return fromRuntimeRoutingProjection(await this.deps.writer.read(), credentialIdByProviderKey, models);
  }
}

function decodeRef(value: unknown): ModelRef | null {
  if (!isRecord(value)) return null;
  const credentialId = typeof value.credentialId === 'string' ? value.credentialId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  if (!credentialId || !modelId) return null;
  return { credentialId, modelId };
}

function decodeRoute(value: unknown): ModelRoute | null {
  if (!isRecord(value)) return null;
  const primary = decodeRef(value.primary);
  if (!primary) return null;
  const fallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks
      .map((entry) => decodeRef(entry))
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

function decodeRouting(payload: unknown): CapabilityRouting | null {
  if (!isRecord(payload)) return null;
  const routing: CapabilityRouting = {};
  for (const field of ROUTE_FIELDS) {
    if (payload[field] === undefined || payload[field] === null) continue;
    const route = decodeRoute(payload[field]);
    if (!route) return null;
    routing[field] = route;
  }
  return routing;
}

type RoutingRefContext = {
  readonly providerKey: string;
  readonly isCustomMedia: boolean;
};

function resolveRoutingRefContext(account: { providerKey: string; account: Record<string, unknown> }): RoutingRefContext {
  return {
    providerKey: account.providerKey,
    isCustomMedia: isCustomMediaCredential(account.account),
  };
}

function refUsesCredential(ref: ModelRef, credentialId: string): boolean {
  return ref.credentialId === credentialId;
}

function pruneRoute(route: ModelRoute | undefined, credentialId: string): ModelRoute | undefined {
  if (!route || refUsesCredential(route.primary, credentialId)) return undefined;
  return {
    ...route,
    fallbacks: route.fallbacks.filter((fallback) => !refUsesCredential(fallback, credentialId)),
  };
}

function pruneCredentialRoutes(routing: CapabilityRouting, credentialId: string): CapabilityRouting {
  return {
    ...(pruneRoute(routing.chat, credentialId) ? { chat: pruneRoute(routing.chat, credentialId)! } : {}),
    ...(pruneRoute(routing.imageUnderstand, credentialId) ? { imageUnderstand: pruneRoute(routing.imageUnderstand, credentialId)! } : {}),
    ...(pruneRoute(routing.imageGenerate, credentialId) ? { imageGenerate: pruneRoute(routing.imageGenerate, credentialId)! } : {}),
    ...(pruneRoute(routing.videoGenerate, credentialId) ? { videoGenerate: pruneRoute(routing.videoGenerate, credentialId)! } : {}),
    ...(pruneRoute(routing.musicGenerate, credentialId) ? { musicGenerate: pruneRoute(routing.musicGenerate, credentialId)! } : {}),
    ...(pruneRoute(routing.tts, credentialId) ? { tts: pruneRoute(routing.tts, credentialId)! } : {}),
  };
}

function refKey(ref: ModelRef): string {
  return `${ref.credentialId}\n${ref.modelId}`;
}

function availableRefsForCapability(
  models: readonly ProviderModel[],
  capability: keyof CapabilityRouting,
): ReadonlySet<string> {
  return new Set(
    models
      .filter((model) => model.capabilities.includes(capability))
      .map((model) => refKey(model)),
  );
}

function pruneRouteUnavailableInCatalog(
  route: ModelRoute | undefined,
  available: ReadonlySet<string>,
): ModelRoute | undefined {
  if (!route || !available.has(refKey(route.primary))) return undefined;
  return {
    ...route,
    fallbacks: route.fallbacks.filter((fallback) => available.has(refKey(fallback))),
  };
}

function pruneRoutesUnavailableInCatalog(
  routing: CapabilityRouting,
  models: readonly ProviderModel[],
): CapabilityRouting {
  const chat = pruneRouteUnavailableInCatalog(routing.chat, availableRefsForCapability(models, 'chat'));
  const imageUnderstand = pruneRouteUnavailableInCatalog(routing.imageUnderstand, availableRefsForCapability(models, 'imageUnderstand'));
  const imageGenerate = pruneRouteUnavailableInCatalog(routing.imageGenerate, availableRefsForCapability(models, 'imageGenerate'));
  const videoGenerate = pruneRouteUnavailableInCatalog(routing.videoGenerate, availableRefsForCapability(models, 'videoGenerate'));
  const musicGenerate = pruneRouteUnavailableInCatalog(routing.musicGenerate, availableRefsForCapability(models, 'musicGenerate'));
  const tts = pruneRouteUnavailableInCatalog(routing.tts, availableRefsForCapability(models, 'tts'));
  return {
    ...(chat ? { chat } : {}),
    ...(imageUnderstand ? { imageUnderstand } : {}),
    ...(imageGenerate ? { imageGenerate } : {}),
    ...(videoGenerate ? { videoGenerate } : {}),
    ...(musicGenerate ? { musicGenerate } : {}),
    ...(tts ? { tts } : {}),
  };
}

function toRuntimeProjectionRef(
  ref: ModelRef,
  routeContextByCredentialId: ReadonlyMap<string, RoutingRefContext>,
): CapabilityRoutingProjectionModelRef | null {
  const context = routeContextByCredentialId.get(ref.credentialId);
  if (!context) return null;
  return context.isCustomMedia
    ? { providerKey: MATCHACLAW_MEDIA_PROVIDER_ID, modelId: toMatchaClawMediaRouteModelId(context.providerKey, ref.modelId) }
    : { providerKey: context.providerKey, modelId: ref.modelId };
}

function toRuntimeProjectionRoute(
  route: ModelRoute | undefined,
  routeContextByCredentialId: ReadonlyMap<string, RoutingRefContext>,
): CapabilityRoutingProjectionRoute | undefined {
  if (!route) return undefined;
  const primary = toRuntimeProjectionRef(route.primary, routeContextByCredentialId);
  if (!primary) return undefined;
  return {
    primary,
    fallbacks: route.fallbacks
      .map((fallback) => toRuntimeProjectionRef(fallback, routeContextByCredentialId))
      .filter((fallback): fallback is CapabilityRoutingProjectionModelRef => fallback !== null),
    ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : {}),
  };
}

function toRuntimeRoutingProjection(
  routing: CapabilityRouting,
  routeContextByCredentialId: ReadonlyMap<string, RoutingRefContext>,
): CapabilityRoutingProjectionValue {
  const ttsPrimary = routing.tts ? toRuntimeProjectionRef(routing.tts.primary, routeContextByCredentialId) : null;
  return {
    ...(toRuntimeProjectionRoute(routing.chat, routeContextByCredentialId) ? { chat: toRuntimeProjectionRoute(routing.chat, routeContextByCredentialId)! } : {}),
    ...(toRuntimeProjectionRoute(routing.imageUnderstand, routeContextByCredentialId) ? { imageUnderstand: toRuntimeProjectionRoute(routing.imageUnderstand, routeContextByCredentialId)! } : {}),
    ...(toRuntimeProjectionRoute(routing.imageGenerate, routeContextByCredentialId) ? { imageGenerate: toRuntimeProjectionRoute(routing.imageGenerate, routeContextByCredentialId)! } : {}),
    ...(toRuntimeProjectionRoute(routing.videoGenerate, routeContextByCredentialId) ? { videoGenerate: toRuntimeProjectionRoute(routing.videoGenerate, routeContextByCredentialId)! } : {}),
    ...(toRuntimeProjectionRoute(routing.musicGenerate, routeContextByCredentialId) ? { musicGenerate: toRuntimeProjectionRoute(routing.musicGenerate, routeContextByCredentialId)! } : {}),
    ...(ttsPrimary ? { tts: { providerKey: ttsPrimary.providerKey } } : {}),
  };
}

function fromRuntimeProjectionRef(
  ref: CapabilityRoutingProjectionModelRef,
  credentialIdByProviderKey: ReadonlyMap<string, string>,
): ModelRef | null {
  if (ref.providerKey === MATCHACLAW_MEDIA_PROVIDER_ID) {
    const parsed = parseMatchaClawMediaRouteModelId(ref.modelId);
    if (!parsed) return null;
    const credentialId = credentialIdByProviderKey.get(parsed.providerKey);
    return credentialId ? { credentialId, modelId: parsed.modelId } : null;
  }
  const credentialId = credentialIdByProviderKey.get(ref.providerKey);
  if (!credentialId) return null;
  return { credentialId, modelId: ref.modelId };
}

function fromRuntimeProjectionRoute(
  route: CapabilityRoutingProjectionRoute | undefined,
  credentialIdByProviderKey: ReadonlyMap<string, string>,
): ModelRoute | undefined {
  if (!route) return undefined;
  const primary = fromRuntimeProjectionRef(route.primary, credentialIdByProviderKey);
  if (!primary) return undefined;
  return {
    primary,
    fallbacks: route.fallbacks
      .map((fallback) => fromRuntimeProjectionRef(fallback, credentialIdByProviderKey))
      .filter((fallback): fallback is ModelRef => fallback !== null),
    ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : {}),
  };
}

function resolveTtsRoute(
  providerKey: string | undefined,
  credentialIdByProviderKey: ReadonlyMap<string, string>,
  models: readonly ProviderModel[],
): ModelRoute | undefined {
  if (!providerKey) {
    return undefined;
  }
  const credentialId = credentialIdByProviderKey.get(providerKey);
  if (!credentialId) {
    return undefined;
  }
  const model = models.find((entry) => entry.credentialId === credentialId && entry.capabilities.includes('tts'));
  if (!model) {
    return undefined;
  }
  return {
    primary: {
      credentialId,
      modelId: model.modelId,
    },
    fallbacks: [],
  };
}

function fromRuntimeRoutingProjection(
  routing: CapabilityRoutingProjectionValue,
  credentialIdByProviderKey: ReadonlyMap<string, string>,
  models: readonly ProviderModel[],
): CapabilityRouting {
  const tts = resolveTtsRoute(routing.tts?.providerKey, credentialIdByProviderKey, models);
  return {
    ...(fromRuntimeProjectionRoute(routing.chat, credentialIdByProviderKey) ? { chat: fromRuntimeProjectionRoute(routing.chat, credentialIdByProviderKey)! } : {}),
    ...(fromRuntimeProjectionRoute(routing.imageUnderstand, credentialIdByProviderKey) ? { imageUnderstand: fromRuntimeProjectionRoute(routing.imageUnderstand, credentialIdByProviderKey)! } : {}),
    ...(fromRuntimeProjectionRoute(routing.imageGenerate, credentialIdByProviderKey) ? { imageGenerate: fromRuntimeProjectionRoute(routing.imageGenerate, credentialIdByProviderKey)! } : {}),
    ...(fromRuntimeProjectionRoute(routing.videoGenerate, credentialIdByProviderKey) ? { videoGenerate: fromRuntimeProjectionRoute(routing.videoGenerate, credentialIdByProviderKey)! } : {}),
    ...(fromRuntimeProjectionRoute(routing.musicGenerate, credentialIdByProviderKey) ? { musicGenerate: fromRuntimeProjectionRoute(routing.musicGenerate, credentialIdByProviderKey)! } : {}),
    ...(tts ? { tts } : {}),
  };
}

function hasRoute(route: ModelRoute | undefined): boolean {
  return Boolean(route?.primary);
}

function hasRouting(routing: CapabilityRouting): boolean {
  return hasRoute(routing.chat)
    || hasRoute(routing.imageUnderstand)
    || hasRoute(routing.imageGenerate)
    || hasRoute(routing.videoGenerate)
    || hasRoute(routing.musicGenerate)
    || hasRoute(routing.tts);
}
