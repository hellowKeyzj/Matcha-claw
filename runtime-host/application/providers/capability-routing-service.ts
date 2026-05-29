/**
 * 能力路由应用服务。
 *
 * MatchaClaw 内部路由引用 `{ credentialId, modelId }`。
 * OpenClaw 写盘前才转换成 `"providerKey/modelId"`。
 */

import { badRequest, ok, type ApplicationResponse } from '../common/application-response';
import type {
  CapabilityRoutingValue as OpenClawCapabilityRoutingValue,
  ModelRouteRef as OpenClawModelRouteRef,
  ModelRouteValue as OpenClawModelRouteValue,
  OpenClawCapabilityRoutingService,
} from '../openclaw/openclaw-capability-routing-service';
import type { ProviderStorePort } from './provider-store-repository';
import type { CapabilityRoutingStorePort } from './capability-routing-store';
import type { ProviderModelsStorePort } from './provider-models-store';
import type { CapabilityRouting, ModelRef, ModelRoute, ProviderModel } from './provider-types';
import {
  isRecord,
  normalizeProviderStoreForRuntime,
} from './provider-store-model';
import {
  MATCHACLAW_MEDIA_PROVIDER_ID,
  isCustomMediaCredential,
  parseMatchaClawMediaRouteModelId,
  toMatchaClawMediaRouteModelId,
} from './custom-media-openclaw';

const ROUTE_FIELDS = [
  'chat',
  'imageUnderstand',
  'imageGenerate',
  'videoGenerate',
  'musicGenerate',
  'tts',
] as const;

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

export class CapabilityRoutingApplicationService {
  constructor(
    private readonly store: CapabilityRoutingStorePort,
    private readonly credentials: ProviderStorePort,
    private readonly models: ProviderModelsStorePort,
    private readonly writer: OpenClawCapabilityRoutingService,
  ) {}

  async read(): Promise<CapabilityRouting> {
    const store = await this.store.read();
    const prunedRouting = pruneRoutesUnavailableInCatalog(store.routing, (await this.models.read()).models);
    if (JSON.stringify(prunedRouting) !== JSON.stringify(store.routing)) {
      store.routing = prunedRouting;
      await this.store.write(store);
    }
    if (hasRouting(store.routing)) {
      await this.syncOpenClawRoutingIfStale(store.routing);
      return store.routing;
    }
    const imported = await this.importOpenClawRouting();
    if (!hasRouting(imported)) {
      return store.routing;
    }
    store.routing = imported;
    await this.store.write(store);
    return imported;
  }

  async write(payload: unknown): Promise<ApplicationResponse> {
    const decoded = decodeRouting(payload);
    if (!decoded) {
      return badRequest('capability routing payload 参数无效');
    }
    const store = await this.store.read();
    await this.syncOpenClawRouting(decoded);
    store.routing = decoded;
    await this.store.write(store);
    return ok({ success: true, routing: decoded });
  }

  async syncOpenClaw(): Promise<void> {
    await this.syncOpenClawRouting(await this.read());
  }

  async removeCredentialRoutes(credentialId: string): Promise<void> {
    const store = await this.store.read();
    const next = pruneCredentialRoutes(store.routing, credentialId);
    if (JSON.stringify(next) === JSON.stringify(store.routing)) return;
    store.routing = next;
    await this.store.write(store);
    await this.syncOpenClawRouting(next);
  }

  async pruneUnavailableModelRoutes(models: readonly ProviderModel[]): Promise<void> {
    const store = await this.store.read();
    const next = pruneRoutesUnavailableInCatalog(store.routing, models);
    if (JSON.stringify(next) === JSON.stringify(store.routing)) return;
    store.routing = next;
    await this.store.write(store);
    await this.syncOpenClawRouting(next);
  }

  private async syncOpenClawRouting(routing: CapabilityRouting): Promise<void> {
    await this.writer.replace(await this.buildOpenClawRouting(routing));
  }

  private async syncOpenClawRoutingIfStale(routing: CapabilityRouting): Promise<void> {
    const projected = await this.buildOpenClawRouting(routing);
    const current = await this.writer.read();
    if (JSON.stringify(current) === JSON.stringify(projected)) {
      return;
    }
    await this.writer.replace(projected);
  }

  private async buildOpenClawRouting(routing: CapabilityRouting): Promise<OpenClawCapabilityRoutingValue> {
    const providerStore = await this.credentials.read();
    const { accounts, storeModified } = normalizeProviderStoreForRuntime(providerStore);
    if (storeModified) {
      await this.credentials.write(providerStore);
    }
    const routeContextByCredentialId = new Map(accounts.map((account) => [
      account.accountId,
      resolveRoutingRefContext(account),
    ]));
    return toOpenClawRouting(routing, routeContextByCredentialId);
  }

  private async importOpenClawRouting(): Promise<CapabilityRouting> {
    const providerStore = await this.credentials.read();
    const { accounts, storeModified } = normalizeProviderStoreForRuntime(providerStore);
    if (storeModified) {
      await this.credentials.write(providerStore);
    }
    const credentialIdByProviderKey = new Map(accounts.map((account) => [account.providerKey, account.accountId]));
    return fromOpenClawRouting(await this.writer.read(), credentialIdByProviderKey);
  }
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

function toOpenClawRef(
  ref: ModelRef,
  routeContextByCredentialId: ReadonlyMap<string, RoutingRefContext>,
): OpenClawModelRouteRef | null {
  const context = routeContextByCredentialId.get(ref.credentialId);
  if (!context) return null;
  return context.isCustomMedia
    ? { providerKey: MATCHACLAW_MEDIA_PROVIDER_ID, modelId: toMatchaClawMediaRouteModelId(context.providerKey, ref.modelId) }
    : { providerKey: context.providerKey, modelId: ref.modelId };
}

function toOpenClawRoute(
  route: ModelRoute | undefined,
  routeContextByCredentialId: ReadonlyMap<string, RoutingRefContext>,
): OpenClawModelRouteValue | undefined {
  if (!route) return undefined;
  const primary = toOpenClawRef(route.primary, routeContextByCredentialId);
  if (!primary) return undefined;
  return {
    primary,
    fallbacks: route.fallbacks
      .map((fallback) => toOpenClawRef(fallback, routeContextByCredentialId))
      .filter((fallback): fallback is OpenClawModelRouteRef => fallback !== null),
    ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : {}),
  };
}

function toOpenClawRouting(
  routing: CapabilityRouting,
  routeContextByCredentialId: ReadonlyMap<string, RoutingRefContext>,
): OpenClawCapabilityRoutingValue {
  const ttsPrimary = routing.tts ? toOpenClawRef(routing.tts.primary, routeContextByCredentialId) : null;
  return {
    ...(toOpenClawRoute(routing.chat, routeContextByCredentialId) ? { chat: toOpenClawRoute(routing.chat, routeContextByCredentialId)! } : {}),
    ...(toOpenClawRoute(routing.imageUnderstand, routeContextByCredentialId) ? { imageUnderstand: toOpenClawRoute(routing.imageUnderstand, routeContextByCredentialId)! } : {}),
    ...(toOpenClawRoute(routing.imageGenerate, routeContextByCredentialId) ? { imageGenerate: toOpenClawRoute(routing.imageGenerate, routeContextByCredentialId)! } : {}),
    ...(toOpenClawRoute(routing.videoGenerate, routeContextByCredentialId) ? { videoGenerate: toOpenClawRoute(routing.videoGenerate, routeContextByCredentialId)! } : {}),
    ...(toOpenClawRoute(routing.musicGenerate, routeContextByCredentialId) ? { musicGenerate: toOpenClawRoute(routing.musicGenerate, routeContextByCredentialId)! } : {}),
    ...(ttsPrimary ? { tts: { providerKey: ttsPrimary.providerKey } } : {}),
  };
}

function fromOpenClawRef(
  ref: OpenClawModelRouteRef,
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

function fromOpenClawRoute(
  route: OpenClawModelRouteValue | undefined,
  credentialIdByProviderKey: ReadonlyMap<string, string>,
): ModelRoute | undefined {
  if (!route) return undefined;
  const primary = fromOpenClawRef(route.primary, credentialIdByProviderKey);
  if (!primary) return undefined;
  return {
    primary,
    fallbacks: route.fallbacks
      .map((fallback) => fromOpenClawRef(fallback, credentialIdByProviderKey))
      .filter((fallback): fallback is ModelRef => fallback !== null),
    ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : {}),
  };
}

function fromOpenClawRouting(
  routing: OpenClawCapabilityRoutingValue,
  credentialIdByProviderKey: ReadonlyMap<string, string>,
): CapabilityRouting {
  return {
    ...(fromOpenClawRoute(routing.chat, credentialIdByProviderKey) ? { chat: fromOpenClawRoute(routing.chat, credentialIdByProviderKey)! } : {}),
    ...(fromOpenClawRoute(routing.imageUnderstand, credentialIdByProviderKey) ? { imageUnderstand: fromOpenClawRoute(routing.imageUnderstand, credentialIdByProviderKey)! } : {}),
    ...(fromOpenClawRoute(routing.imageGenerate, credentialIdByProviderKey) ? { imageGenerate: fromOpenClawRoute(routing.imageGenerate, credentialIdByProviderKey)! } : {}),
    ...(fromOpenClawRoute(routing.videoGenerate, credentialIdByProviderKey) ? { videoGenerate: fromOpenClawRoute(routing.videoGenerate, credentialIdByProviderKey)! } : {}),
    ...(fromOpenClawRoute(routing.musicGenerate, credentialIdByProviderKey) ? { musicGenerate: fromOpenClawRoute(routing.musicGenerate, credentialIdByProviderKey)! } : {}),
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
