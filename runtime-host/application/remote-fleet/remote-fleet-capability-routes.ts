import { badRequest } from '../common/application-response';
import type { CapabilityOperationRoute } from '../capabilities/contracts/capability-router';
import type { RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { RemoteFleetPort } from './remote-fleet-service';
import type { RemoteFleetOperationId } from './remote-fleet-operation-id';

export const REMOTE_FLEET_RUNTIME_CONTROL_CAPABILITY_ID = 'remote-fleet.runtime-control';

const REMOTE_FLEET_CAPABILITY_OPERATION_MAP = {
  'remoteFleet.runtime.status': 'snapshot',
  'remoteFleet.runtime.start': 'start',
  'remoteFleet.runtime.stop': 'stop',
  'remoteFleet.capabilities.sync': 'sync',
} as const satisfies Record<string, RemoteFleetOperationId>;

type RemoteFleetCapabilityOperationId = keyof typeof REMOTE_FLEET_CAPABILITY_OPERATION_MAP;

export function createRemoteFleetCapabilityOperationRoutes(deps: {
  remoteFleetService: Pick<RemoteFleetPort, 'invoke'>;
}): readonly CapabilityOperationRoute[] {
  return Object.entries(REMOTE_FLEET_CAPABILITY_OPERATION_MAP).map(([capabilityOperationId, remoteFleetOperationId]) => ({
    capabilityId: REMOTE_FLEET_RUNTIME_CONTROL_CAPABILITY_ID,
    operationId: capabilityOperationId,
    handle: (context) => {
      const targetError = validateRuntimeEndpointTarget(context.target, context.domainInput);
      if (targetError) {
        return badRequest(targetError);
      }

      const params = buildRemoteFleetOperationParams(capabilityOperationId as RemoteFleetCapabilityOperationId, context.scope);
      if ('error' in params) {
        return badRequest(params.error);
      }

      return deps.remoteFleetService.invoke(
        remoteFleetOperationId,
        params.value,
      );
    },
  }));
}

function validateRuntimeEndpointTarget(target: unknown, input: Record<string, unknown>): string | null {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return 'Remote Fleet runtime endpoint target is required';
  }
  if ((target as Record<string, unknown>).kind !== 'runtime-endpoint') {
    return 'Remote Fleet capability target must be runtime-endpoint';
  }
  return input.runtimeAddress === undefined
    ? null
    : 'Remote Fleet capability input runtimeAddress is not allowed';
}

type RemoteFleetOperationParamsResult =
  | { readonly value: Record<string, unknown> }
  | { readonly error: string };

function buildRemoteFleetOperationParams(operationId: RemoteFleetCapabilityOperationId, scope: RuntimeScope): RemoteFleetOperationParamsResult {
  switch (operationId) {
    case 'remoteFleet.runtime.start':
    case 'remoteFleet.runtime.stop':
    case 'remoteFleet.capabilities.sync': {
      const runtimeId = readRemoteFleetRuntimeId(scope);
      return 'error' in runtimeId ? runtimeId : { value: { runtimeId: runtimeId.value } };
    }
    case 'remoteFleet.runtime.status':
      return { value: {} };
  }
}

function readRemoteFleetRuntimeId(scope: RuntimeScope): { readonly value: string } | { readonly error: string } {
  if (scope.kind !== 'runtime-instance') {
    return { error: 'Remote Fleet runtime control requires a runtime-instance scope' };
  }
  const endpoint = scope.endpoint;
  if (endpoint.kind !== 'native-runtime' || endpoint.runtimeAdapterId !== 'remote-fleet') {
    return { error: 'Remote Fleet runtime control requires a remote-fleet native runtime endpoint' };
  }
  return { value: endpoint.runtimeInstanceId };
}
