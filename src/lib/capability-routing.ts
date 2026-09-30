import { hostApiFetch } from '@/lib/host-api';
import { isProviderMutationCommitted, waitForProviderMutation } from '@/lib/provider-call';
import type { ProviderCallDetail } from '@/types/call-log/provider';
import { nativeProjectionError } from '@/lib/provider-projection-errors';

export type CapabilityKey =
  | 'chat'
  | 'imageUnderstand'
  | 'imageGenerate'
  | 'videoGenerate'
  | 'musicGenerate'
  | 'tts';

export interface ModelRouteRef {
  accountId: string;
  modelId: string;
}

export interface ModelRoute {
  primary: ModelRouteRef;
  fallbacks: ModelRouteRef[];
  timeoutMs?: number;
}

export type CapabilityRouting = Partial<Record<CapabilityKey, ModelRoute>>;

export interface CapabilityRoutingSnapshot {
  revision: number | null;
  routing: CapabilityRouting;
}

export interface PersistCapabilityRoutingResult {
  success: boolean;
  revision: number | null;
  routing: CapabilityRouting;
  receipt?: ProviderCallDetail;
  error?: string;
  warning?: string;
}

const PROVIDER_ROUTING_PATH = '/api/provider-routing';

export const CAPABILITY_KEYS: readonly Exclude<CapabilityKey, 'tts'>[] = [
  'chat',
  'imageUnderstand',
  'imageGenerate',
  'videoGenerate',
  'musicGenerate',
];

const ROUTING_KEYS: readonly CapabilityKey[] = [...CAPABILITY_KEYS, 'tts'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isCapabilityKey(value: unknown): value is CapabilityKey {
  return ROUTING_KEYS.includes(value as CapabilityKey);
}

function decodeRouteRef(value: unknown): ModelRouteRef | null {
  if (!isRecord(value) || !hasExactKeys(value, ['accountId', 'modelId'])) return null;
  const accountId = typeof value.accountId === 'string' ? value.accountId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  return accountId && modelId ? { accountId, modelId } : null;
}

function decodeRoute(value: unknown): ModelRoute | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['capability', 'primary', 'fallbacks', 'timeoutMs'])
    || !Object.hasOwn(value, 'primary')
    || !Object.hasOwn(value, 'fallbacks')
    || !Array.isArray(value.fallbacks)) {
    return null;
  }
  const primary = decodeRouteRef(value.primary);
  if (!primary) return null;
  const fallbacks: ModelRouteRef[] = [];
  for (const fallback of value.fallbacks) {
    const decoded = decodeRouteRef(fallback);
    if (!decoded) return null;
    fallbacks.push(decoded);
  }
  if (value.timeoutMs !== undefined && !isPositiveInteger(value.timeoutMs)) return null;
  return {
    primary,
    fallbacks,
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
  };
}

function decodeRoutingDocument(value: unknown): CapabilityRoutingSnapshot | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['revision', 'routes'])
    || !isPositiveInteger(value.revision)
    || !Array.isArray(value.routes)) {
    return null;
  }
  const routing: CapabilityRouting = {};
  const seen = new Set<CapabilityKey>();
  for (const rawRoute of value.routes) {
    if (!isRecord(rawRoute)
      || !hasOnlyKeys(rawRoute, ['capability', 'primary', 'fallbacks', 'timeoutMs'])
      || !['capability', 'primary', 'fallbacks'].every((key) => Object.hasOwn(rawRoute, key))
      || !isCapabilityKey(rawRoute.capability)) {
      return null;
    }
    if (seen.has(rawRoute.capability)) return null;
    const route = decodeRoute(rawRoute);
    if (!route) return null;
    seen.add(rawRoute.capability);
    routing[rawRoute.capability] = route;
  }
  return { revision: value.revision, routing };
}

function decodeListResponse(value: unknown): CapabilityRoutingSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['routing'])) {
    throw new Error('Provider routing response is invalid');
  }
  if (value.routing === null) return { revision: null, routing: {} };
  const decoded = decodeRoutingDocument(value.routing);
  if (!decoded) throw new Error('Provider routing response is invalid');
  return decoded;
}

function routingToDocument(routing: CapabilityRouting, revision: number) {
  return {
    revision,
    routes: ROUTING_KEYS.flatMap((capability) => {
      const route = routing[capability];
      if (!route) return [];
      return [{
        capability,
        primary: route.primary,
        fallbacks: route.fallbacks,
        ...(route.timeoutMs === undefined ? {} : { timeoutMs: route.timeoutMs }),
      }];
    }),
  };
}

export function normalizeCapabilityRouting(value: unknown): CapabilityRouting {
  return decodeRoutingDocument(value)?.routing ?? {};
}

export function modelRouteRefToString(ref: ModelRouteRef): string {
  return `${ref.accountId}/${ref.modelId}`;
}

export function parseModelRouteRefString(raw: string): ModelRouteRef | null {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const accountId = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (!accountId || !modelId) return null;
  return { accountId, modelId };
}

export async function fetchCapabilityRouting(): Promise<CapabilityRoutingSnapshot> {
  return decodeListResponse(await hostApiFetch<unknown>(PROVIDER_ROUTING_PATH, { method: 'GET' }));
}

export async function persistCapabilityRouting(
  routing: CapabilityRouting,
  revision: number,
): Promise<PersistCapabilityRoutingResult> {
  const result = await hostApiFetch<unknown>(PROVIDER_ROUTING_PATH, {
    method: 'POST',
    body: JSON.stringify({
      id: 'provider.routing',
      operationId: 'providerRouting.replace',
      scope: { kind: 'provider-routing' },
      target: { kind: 'provider-routing' },
      input: { kind: 'replace', routing: routingToDocument(routing, revision) },
    }),
  });
  const receipt = await waitForProviderMutation(result, 'providerRouting.replace');
  if (!isProviderMutationCommitted(receipt, 'stored')) {
    const unknown = receipt.phase !== 'terminal' || receipt.outcome === 'unknown'
      || receipt.commit === 'unknown' || receipt.persisted === 'unknown';
    return {
      success: false,
      revision: null,
      routing: {},
      receipt,
      error: unknown ? 'Provider routing commit outcome is unknown; reopen before retrying'
        : receipt.outcome === 'rejected' || receipt.outcome === 'missing'
          ? 'Provider routing request was rejected' : 'Provider routing is unavailable',
    };
  }
  const snapshot = await fetchCapabilityRouting();
  const warning = nativeProjectionError(receipt);
  return { success: true, ...snapshot, receipt, ...(warning ? { warning } : {}) };
}
