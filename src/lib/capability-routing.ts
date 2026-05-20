import { hostApiFetch } from '@/lib/host-api';

export type CapabilityKey =
  | 'chat'
  | 'imageUnderstand'
  | 'imageGenerate'
  | 'videoGenerate'
  | 'musicGenerate'
  | 'tts';

export interface ModelRouteRef {
  credentialId: string;
  modelId: string;
}

export interface ModelRoute {
  primary: ModelRouteRef;
  fallbacks: ModelRouteRef[];
  timeoutMs?: number;
}

export type CapabilityRouting = Partial<Record<CapabilityKey, ModelRoute>>;

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

function normalizeRouteRef(value: unknown): ModelRouteRef | null {
  if (!isRecord(value)) return null;
  const credentialId = typeof value.credentialId === 'string' ? value.credentialId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  if (!credentialId || !modelId) return null;
  return { credentialId, modelId };
}

function normalizeRoute(value: unknown): ModelRoute | null {
  if (!isRecord(value)) return null;
  const primary = normalizeRouteRef(value.primary);
  if (!primary) return null;
  const fallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks
      .map((entry) => normalizeRouteRef(entry))
      .filter((entry): entry is ModelRouteRef => entry !== null)
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

export function normalizeCapabilityRouting(value: unknown): CapabilityRouting {
  if (!isRecord(value)) return {};
  const routing: CapabilityRouting = {};
  for (const key of ROUTING_KEYS) {
    const route = normalizeRoute(value[key]);
    if (route) routing[key] = route;
  }
  return routing;
}

export function modelRouteRefToString(ref: ModelRouteRef): string {
  return `${ref.credentialId}/${ref.modelId}`;
}

export function parseModelRouteRefString(raw: string): ModelRouteRef | null {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const credentialId = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (!credentialId || !modelId) return null;
  return { credentialId, modelId };
}

export async function fetchCapabilityRouting(): Promise<CapabilityRouting> {
  return normalizeCapabilityRouting(await hostApiFetch<unknown>('/api/capability-routing'));
}

export async function persistCapabilityRouting(
  routing: CapabilityRouting,
): Promise<{ success: boolean; routing: CapabilityRouting; error?: string }> {
  const result = await hostApiFetch<{ success?: boolean; routing?: unknown; error?: string }>(
    '/api/capability-routing',
    {
      method: 'PUT',
      body: JSON.stringify(routing),
    },
  );
  return {
    success: result?.success === true,
    routing: normalizeCapabilityRouting(result?.routing),
    ...(typeof result?.error === 'string' ? { error: result.error } : {}),
  };
}
