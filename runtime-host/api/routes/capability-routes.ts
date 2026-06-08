import {
  validateCapabilityTarget,
  validateRuntimeScope,
  type CapabilityTarget,
  type RuntimeScope,
} from '../../application/agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../../application/capabilities/contracts/capability-descriptor';
import type { CapabilityExecuteRequest } from '../../application/capabilities/contracts/capability-router';
import { badRequest, readRecord, routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface CapabilityRouteService {
  listCapabilities: () => readonly CapabilityDescriptor[];
  describeCapability: (input: { id: string; scope: RuntimeScope }) => CapabilityDescriptor;
  executeCapability: (request: CapabilityExecuteRequest) => Promise<ApplicationResponse>;
}

function readCapabilityScopeRequest(payload: unknown): { id: string; scope: RuntimeScope; body: Record<string, unknown> } | { error: string } {
  const body = readRecord(payload);
  const id = body.id;
  if (typeof id !== 'string' || !id.trim()) {
    return { error: 'Capability id is required' };
  }
  const scope = body.scope;
  const scopeError = validateRuntimeScope(scope);
  if (scopeError) {
    return { error: scopeError };
  }
  return { id, scope: scope as RuntimeScope, body };
}

function readCapabilityExecuteRequest(payload: unknown): CapabilityExecuteRequest | { error: string } {
  const request = readCapabilityScopeRequest(payload);
  if ('error' in request) {
    return request;
  }
  const operationId = request.body.operationId;
  if (typeof operationId !== 'string' || !operationId.trim()) {
    return { error: 'Capability operationId is required' };
  }
  if (request.body.runtimeAddress !== undefined) {
    return { error: 'Capability runtimeAddress is not allowed' };
  }
  const target = request.body.target ?? null;
  if (target !== null) {
    const targetError = validateCapabilityTarget(target);
    if (targetError) {
      return { error: targetError };
    }
  }
  return {
    id: request.id,
    operationId,
    scope: request.scope,
    target: target as CapabilityTarget | null,
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
      const request = readCapabilityScopeRequest(context.payload);
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
