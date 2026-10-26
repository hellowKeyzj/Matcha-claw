import { Interaction, notes } from '@serenity-js/core';
import { UseElectron } from '../abilities/use-electron.ability.js';

const privateInputCanary = 'e2e-provider-routing-private-input-canary';
const routingCapabilities = ['chat', 'imageUnderstand', 'imageGenerate', 'videoGenerate', 'musicGenerate', 'tts'];
type ModelReference = { accountId: string; modelId: string };
type CatalogModel = ModelReference & { capabilities: string[] };
type RoutingRoute = { capability: string; primary: ModelReference; fallbacks: ModelReference[]; timeoutMs?: number };
type PublicRoutingList = { routing: null | { revision: number; routes: RoutingRoute[] } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isModelReference(value: unknown): boolean {
  return hasExactKeys(value, ['accountId', 'modelId'])
    && typeof value.accountId === 'string' && value.accountId.trim().length > 0
    && typeof value.modelId === 'string' && value.modelId.trim().length > 0;
}

function isRoutingRoute(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every(key => ['capability', 'primary', 'fallbacks', 'timeoutMs'].includes(key))
    && typeof value.capability === 'string' && routingCapabilities.includes(value.capability)
    && isModelReference(value.primary)
    && Array.isArray(value.fallbacks) && value.fallbacks.every(isModelReference)
    && (value.timeoutMs === undefined || isPositiveInteger(value.timeoutMs));
}

function isPublicRoutingList(value: unknown): value is PublicRoutingList {
  if (!hasExactKeys(value, ['routing'])) return false;
  if (value.routing === null) return true;
  const routing = value.routing;
  return hasExactKeys(routing, ['revision', 'routes']) && isPositiveInteger(routing.revision)
    && Array.isArray(routing.routes) && routing.routes.every(isRoutingRoute)
    && new Set(routing.routes.map(route => (route as Record<string, unknown>).capability)).size === routing.routes.length;
}

function isPublicProjectionSafe(value: unknown): boolean {
  if (typeof value === 'string') {
    return !value.includes(privateInputCanary) && !/(?:[A-Za-z]:[\\/]|127\.0\.0\.1:\d{2,5}|Bearer\s+)/i.test(value);
  }
  if (Array.isArray(value)) return value.every(isPublicProjectionSafe);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(([key, child]) =>
    !/^(?:authorization|token|secret|credential|apiKey|configDir|workspaceDir|sourcePath|session)$/i.test(key)
    && isPublicProjectionSafe(key) && isPublicProjectionSafe(child));
}

export const RequestProviderRouting = (kind: 'list' | 'invalid' | 'unknown') => Interaction.where(`#actor requests ${kind} provider routing through the real renderer IPC`, async actor => {
  const body = {
    id: kind === 'unknown' ? 'e2e.unknown-provider-routing-capability' : 'provider.routing',
    operationId: kind === 'unknown' ? 'e2e.unknown-provider-routing' : 'providerRouting.list',
    scope: { kind: 'provider-routing' }, target: { kind: 'provider-routing' },
    input: { kind: kind === 'unknown' ? 'unknown' : 'list' },
    ...(kind === 'list' ? {} : { privateInput: privateInputCanary }),
  };
  const reply = await actor.abilityTo(UseElectron).fetchHostApi({ path: '/api/capabilities/execute', method: 'POST', body });
  const json = reply.ok ? reply.data.json : undefined;
  const expectedStatus = kind === 'list' ? 200 : kind === 'invalid' ? 400 : 404;
  const matchesBody = kind === 'list' ? isPublicRoutingList(json)
    : hasExactKeys(json, ['success', 'error']) && json.success === false
      && json.error === (kind === 'invalid' ? 'Provider routing request is invalid' : 'Capability is not available');
  const receipt = {
    ipcSucceeded: reply.ok,
    matchesStatus: reply.ok && reply.data.status === expectedStatus && reply.data.ok === (kind === 'list'),
    matchesPublicBody: matchesBody,
    publicProjectionSafe: isPublicProjectionSafe(reply),
  };
  await notes<{ providerRoutingReply: typeof receipt }>().set('providerRoutingReply', receipt).performAs(actor);
  if (kind === 'list' && isPublicRoutingList(json)) {
    await notes().set('providerRoutingRoutes', json.routing?.routes ?? []).performAs(actor);
  }
});

export const ReadProviderRoutingUiExpectation = () => Interaction.where('#actor reads registered model references to compare the routing form without changing it', async actor => {
  const reply = await actor.abilityTo(UseElectron).fetchHostApi({ path: '/api/provider-models', method: 'GET' });
  const body = reply.ok ? reply.data.json : undefined;
  if (!reply.ok || reply.data.status !== 200 || !reply.data.ok || !hasExactKeys(body, ['models']) || !Array.isArray(body.models)) {
    throw new Error('The public model catalog is unavailable for the read-only routing comparison');
  }
  const models = body.models;
  if (!models.every((model): model is CatalogModel => isRecord(model) && typeof model.accountId === 'string' && model.accountId.length > 0
    && typeof model.modelId === 'string' && model.modelId.length > 0 && Array.isArray(model.capabilities)
    && model.capabilities.every(capability => typeof capability === 'string' && [...routingCapabilities, 'transcribe'].includes(capability)))) {
    throw new Error('The public model catalog has invalid routing references');
  }
  const routes = await actor.answer(notes<{ providerRoutingRoutes: RoutingRoute[] }>().get('providerRoutingRoutes'));
  const primary: Record<string, string> = {};
  for (const capability of routingCapabilities) {
    const route = routes.find(candidate => candidate.capability === capability);
    primary[capability] = route && models.some(model => model.accountId === route.primary.accountId
      && model.modelId === route.primary.modelId && model.capabilities.includes(capability))
      ? `${route.primary.accountId}/${route.primary.modelId}` : '';
  }
  await notes().set('providerRoutingPrimary', primary).performAs(actor);
});
