import { hostApiFetch } from '@/lib/host-api';
import {
  decodeProviderMutationReceipt,
  ProviderMutationCommitOutcomeUnknownError,
  type ProviderMutationReceipt,
} from '@/lib/host-api-transport-contract';
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
  revision: number;
  routing: CapabilityRouting;
  receipt?: ProviderMutationReceipt;
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

function isStoredReplacement(value: unknown): value is {
  success: true;
  desired: { status: 'stored'; revision: number };
  persisted: { status: 'confirmed' };
  native: ProviderMutationReceipt['native'];
  commit: 'committed';
} {
  if (!isRecord(value)
    || !hasExactKeys(value, ['success', 'desired', 'persisted', 'native', 'commit'])
    || value.success !== true) return false;
  const receipt = decodeProviderMutationReceipt(value, 'committed');
  return receipt?.desired.status === 'stored'
    && receipt.desired.revision !== undefined
    && isPositiveInteger(receipt.desired.revision)
    && receipt.persisted.status === 'confirmed';
}

function isRejectedReplacement(value: unknown): value is { success: false; error: 'Provider routing request was rejected' } {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && value.error === 'Provider routing request was rejected';
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
  let result: unknown;
  try {
    result = await hostApiFetch<unknown>(PROVIDER_ROUTING_PATH, {
      method: 'POST',
      body: JSON.stringify({
        id: 'provider.routing',
        operationId: 'providerRouting.replace',
        scope: { kind: 'provider-routing' },
        target: { kind: 'provider-routing' },
        input: { kind: 'replace', routing: routingToDocument(routing, revision) },
      }),
    });
  } catch (error) {
    if (error instanceof ProviderMutationCommitOutcomeUnknownError) {
      return {
        success: false,
        revision,
        routing: {},
        receipt: error.receipt,
        error: 'Provider routing commit outcome is unknown; reopen before retrying',
      };
    }
    throw error;
  }
  if (isStoredReplacement(result)) {
    const receipt = decodeProviderMutationReceipt(result, 'committed');
    const warning = receipt ? nativeProjectionError(receipt) : undefined;
    return {
      success: true,
      revision: result.desired.revision,
      routing,
      ...(receipt ? { receipt } : {}),
      ...(warning ? { warning } : {}),
    };
  }
  if (isRejectedReplacement(result)) {
    return {
      success: false,
      revision,
      routing: {},
      error: result.error,
    };
  }
  throw new Error('Provider routing response is invalid');
}
