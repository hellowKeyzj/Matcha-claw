import { buildCapabilityScopeKey, type CapabilityTarget, type RuntimeEndpointRef, type RuntimeScope } from '../../runtime-host/shared/runtime-address';
import type { CapabilityDescriptor } from '../../runtime-host/shared/capability-descriptor';
import type { RuntimeHostManager } from './runtime-host-manager';
import type { RuntimeHostHttpClient } from './runtime-host-client';

const CAPABILITY_SCOPE_CACHE_TTL_MS = 5_000;
const capabilityScopeCache = new Map<string, { scope: RuntimeScope; expiresAt: number }>();
const capabilityScopeInflight = new Map<string, Promise<RuntimeScope>>();

interface RuntimeHostCapabilityClient {
  request<TResponse>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', route: string, payload?: unknown, options?: { timeoutMs?: number }): Promise<{ data?: TResponse }>;
}

interface RuntimeEndpointSummaryLike {
  readonly capabilitySummaries?: readonly {
    readonly id?: string;
    readonly availability?: string;
  }[];
  readonly runtimeAdapterId?: string;
  readonly runtimeInstanceId?: string;
  readonly protocolId?: string;
  readonly connectorId?: string;
  readonly id?: string;
}

function capabilityScopeCacheKey(capabilityId: string, scope?: RuntimeScope): string {
  return scope ? `${capabilityId}:${buildCapabilityScopeKey(scope)}` : capabilityId;
}

function describeCapabilityScope(scope: RuntimeScope): string {
  return buildCapabilityScopeKey(scope);
}

function resolveCapabilityScopeFromList(
  capabilityId: string,
  capabilities: readonly CapabilityDescriptor[],
  sourceScope?: RuntimeScope,
): RuntimeScope {
  const available = capabilities.filter((capability) => (
    capability.id === capabilityId && capability.availability === 'available'
  ));
  const matched = sourceScope
    ? available.find((capability) => buildCapabilityScopeKey(capability.scope) === buildCapabilityScopeKey(sourceScope))
    : null;
  const scope = matched?.scope ?? (available.length === 1 ? available[0]!.scope : null);
  if (!scope) {
    const scopeHint = sourceScope ? ` for source scope ${describeCapabilityScope(sourceScope)}` : '';
    const availableHint = available.length > 0
      ? `; available scopes: ${available.map((capability) => describeCapabilityScope(capability.scope)).join(', ')}`
      : '; available scopes: none';
    throw new Error(`Expected exactly one RuntimeScope for ${capabilityId} capability${scopeHint}, got ${available.length}${availableHint}`);
  }
  return scope;
}

export async function resolveSingleCapabilityScope(
  client: RuntimeHostManager | RuntimeHostHttpClient,
  capabilityId: string,
  sourceScope?: RuntimeScope,
): Promise<RuntimeScope> {
  const cacheKey = capabilityScopeCacheKey(capabilityId, sourceScope);
  const now = Date.now();
  const cached = capabilityScopeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.scope;
  }
  const inflight = capabilityScopeInflight.get(cacheKey);
  if (inflight) {
    return await inflight;
  }
  const task = (async () => {
    const response = await (client as RuntimeHostCapabilityClient).request<{ capabilities?: CapabilityDescriptor[] }>(
      'GET',
      '/api/capabilities/list',
    );
    const capabilities = Array.isArray(response.data?.capabilities) ? response.data.capabilities : [];
    const scope = resolveCapabilityScopeFromList(capabilityId, capabilities, sourceScope);
    capabilityScopeCache.set(cacheKey, {
      scope,
      expiresAt: Date.now() + CAPABILITY_SCOPE_CACHE_TTL_MS,
    });
    return scope;
  })();
  capabilityScopeInflight.set(cacheKey, task);
  try {
    return await task;
  } catch (error) {
    capabilityScopeCache.delete(cacheKey);
    throw error;
  } finally {
    if (capabilityScopeInflight.get(cacheKey) === task) {
      capabilityScopeInflight.delete(cacheKey);
    }
  }
}

export async function createCapabilityPayload(
  client: RuntimeHostManager | RuntimeHostHttpClient,
  capabilityId: string,
  operationId: string,
  input: Record<string, unknown> = {},
  options: {
    scope?: RuntimeScope;
    target?: CapabilityTarget | null;
  } = {},
): Promise<Record<string, unknown>> {
  return {
    id: capabilityId,
    operationId,
    scope: await resolveSingleCapabilityScope(client, capabilityId, options.scope),
    target: options.target ?? null,
    input,
  };
}

function runtimeHostOperationTarget(operationId: string, input: Record<string, unknown>): CapabilityTarget {
  if (operationId === 'runtimeHost.prepareGatewayLaunch'
    || operationId === 'runtimeHost.gatewayLifecycle'
    || operationId === 'runtimeHost.gatewayReady'
    || operationId === 'runtimeHost.gatewayControlUiAutoApprove') {
    return { kind: 'gateway-control' };
  }
  if (operationId === 'runtimeHost.jobGet') {
    const jobId = typeof input.jobId === 'string' ? input.jobId : undefined;
    return jobId ? { kind: 'runtime-job', jobId } : { kind: 'runtime-job' };
  }
  return { kind: 'runtime-endpoint' };
}

function runtimeEndpointFromSummary(endpoint: RuntimeEndpointSummaryLike): RuntimeEndpointRef | null {
  const runtimeAdapterId = typeof endpoint.runtimeAdapterId === 'string' ? endpoint.runtimeAdapterId.trim() : '';
  const runtimeInstanceId = typeof endpoint.runtimeInstanceId === 'string' ? endpoint.runtimeInstanceId.trim() : '';
  if (runtimeAdapterId && runtimeInstanceId) {
    return { kind: 'native-runtime', runtimeAdapterId, runtimeInstanceId };
  }
  const protocolId = typeof endpoint.protocolId === 'string' ? endpoint.protocolId.trim() : '';
  const connectorId = typeof endpoint.connectorId === 'string' ? endpoint.connectorId.trim() : '';
  const endpointId = typeof endpoint.id === 'string' ? endpoint.id.trim() : '';
  if (protocolId && connectorId && endpointId) {
    return { kind: 'protocol-connector', protocolId, connectorId, endpointId };
  }
  return null;
}

export async function resolveRuntimeHostEndpoint(
  client: RuntimeHostManager | RuntimeHostHttpClient,
): Promise<RuntimeEndpointRef> {
  const response = await (client as RuntimeHostCapabilityClient).request<{ endpoints?: RuntimeEndpointSummaryLike[] }>(
    'GET',
    '/api/runtime-endpoints/list',
  );
  const endpoints = Array.isArray(response.data?.endpoints) ? response.data.endpoints : [];
  const candidates = endpoints
    .filter((endpoint) => endpoint.capabilitySummaries?.some((capability) => (
      capability.id === 'runtime.host' && capability.availability === 'available'
    )))
    .map(runtimeEndpointFromSummary)
    .filter((endpoint): endpoint is RuntimeEndpointRef => endpoint !== null);
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one runtime.host endpoint, got ${candidates.length}`);
  }
  return candidates[0]!;
}

export async function createRuntimeHostCapabilityPayload(
  client: RuntimeHostManager | RuntimeHostHttpClient,
  operationId: string,
  input: Record<string, unknown> = {},
  options: { endpoint: RuntimeEndpointRef },
): Promise<Record<string, unknown>> {
  return await createCapabilityPayload(client, 'runtime.host', operationId, input, {
    scope: { kind: 'runtime-instance' as const, endpoint: options.endpoint },
    target: runtimeHostOperationTarget(operationId, input),
  });
}
