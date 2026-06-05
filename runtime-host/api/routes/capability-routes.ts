import { validateRuntimeAddress, type RuntimeAddress } from '../../application/agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../../application/capabilities/contracts/capability-descriptor';
import type { CapabilityExecuteRequest } from '../../application/capabilities/contracts/capability-router';
import { badRequest, readRecord, routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface CapabilityRouteService {
  listCapabilities: () => readonly CapabilityDescriptor[];
  describeCapability: (input: { id: string; address: RuntimeAddress }) => CapabilityDescriptor;
  executeCapability: (request: CapabilityExecuteRequest) => Promise<ApplicationResponse>;
}

function readCapabilityAddressRequest(payload: unknown): { id: string; address: RuntimeAddress; body: Record<string, unknown> } | { error: string } {
  const body = readRecord(payload);
  const id = body.id;
  if (typeof id !== 'string' || !id.trim()) {
    return { error: 'Capability id is required' };
  }
  const runtimeAddress = body.runtimeAddress;
  if (runtimeAddress === undefined) {
    return { error: 'RuntimeAddress is required' };
  }
  const runtimeAddressError = validateRuntimeAddress(runtimeAddress);
  if (runtimeAddressError) {
    return { error: runtimeAddressError };
  }
  const address = runtimeAddress as RuntimeAddress;
  if (address.capabilityId !== id) {
    return { error: 'Capability id does not match RuntimeAddress capabilityId' };
  }
  return { id, address, body };
}

function readCapabilityExecuteRequest(payload: unknown): CapabilityExecuteRequest | { error: string } {
  const request = readCapabilityAddressRequest(payload);
  if ('error' in request) {
    return request;
  }
  const operationId = request.body.operationId;
  if (typeof operationId !== 'string' || !operationId.trim()) {
    return { error: 'Capability operationId is required' };
  }
  return {
    id: request.id,
    operationId,
    address: request.address,
    input: request.body.input,
  };
}

export const capabilityRoutes: readonly RuntimeRouteDefinition<CapabilityRouteService>[] = [
  {
    method: 'GET',
    path: '/api/capabilities/list',
    handle: (_context, service) => routeResponder.value(() => ({
      capabilities: service.listCapabilities(),
    }), (message) => ({ success: false, error: message })),
  },
  {
    method: 'POST',
    path: '/api/capabilities/describe',
    handle: (context, service) => {
      const request = readCapabilityAddressRequest(context.payload);
      if ('error' in request) {
        return badRequest(request.error);
      }
      return routeResponder.value(() => ({
        capability: service.describeCapability(request),
      }), (message) => ({ success: false, error: message }));
    },
  },
  {
    method: 'POST',
    path: '/api/capabilities/execute',
    handle: (context, service) => {
      const request = readCapabilityExecuteRequest(context.payload);
      if ('error' in request) {
        return badRequest(request.error);
      }
      return routeResponder.result(() => service.executeCapability(request), (message) => ({ success: false, error: message }));
    },
  },
] as const;
