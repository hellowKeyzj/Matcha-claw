import type { CapabilityDescriptor } from '../../runtime-host/shared/capability-descriptor';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';
import type { RuntimeHostManager } from './runtime-host-manager';
import type { RuntimeHostHttpClient } from './runtime-host-client';

const CAPABILITY_ADDRESS_CACHE_TTL_MS = 5_000;
const capabilityAddressCache = new Map<string, { address: RuntimeAddress; expiresAt: number }>();

interface RuntimeHostCapabilityClient {
  request<TResponse>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', route: string, payload?: unknown, options?: { timeoutMs?: number }): Promise<{ data?: TResponse }>;
}

export async function resolveSingleCapabilityRuntimeAddress(
  client: RuntimeHostManager | RuntimeHostHttpClient,
  capabilityId: string,
): Promise<RuntimeAddress> {
  const now = Date.now();
  const cached = capabilityAddressCache.get(capabilityId);
  if (cached && cached.expiresAt > now) {
    return cached.address;
  }
  const response = await (client as RuntimeHostCapabilityClient).request<{ capabilities?: CapabilityDescriptor[] }>(
    'GET',
    '/api/capabilities/list',
  );
  const capabilities = Array.isArray(response.data?.capabilities) ? response.data.capabilities : [];
  const available = capabilities.filter((capability) => (
    capability.id === capabilityId && capability.availability === 'available'
  ));
  if (available.length !== 1) {
    capabilityAddressCache.delete(capabilityId);
    throw new Error(`Expected exactly one RuntimeAddress for ${capabilityId} capability, got ${available.length}`);
  }
  const address = available[0].address;
  capabilityAddressCache.set(capabilityId, {
    address,
    expiresAt: now + CAPABILITY_ADDRESS_CACHE_TTL_MS,
  });
  return address;
}

export async function createCapabilityPayload(
  client: RuntimeHostManager | RuntimeHostHttpClient,
  capabilityId: string,
  operationId: string,
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const runtimeAddress = await resolveSingleCapabilityRuntimeAddress(client, capabilityId);
  return {
    id: capabilityId,
    operationId,
    runtimeAddress,
    input: {
      ...input,
      runtimeAddress,
    },
  };
}

export async function createRuntimeHostCapabilityPayload(
  client: RuntimeHostManager | RuntimeHostHttpClient,
  operationId: string,
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return await createCapabilityPayload(client, 'runtime.host', operationId, input);
}
