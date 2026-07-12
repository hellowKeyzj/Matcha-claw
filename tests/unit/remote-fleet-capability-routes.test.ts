import { describe, expect, it, vi } from 'vitest';
import type { CapabilityOperationRoute } from '../../runtime-host/application/capabilities/contracts/capability-router';
import type { RuntimeScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import {
  createRemoteFleetCapabilityOperationRoutes,
  REMOTE_FLEET_RUNTIME_CONTROL_CAPABILITY_ID,
} from '../../runtime-host/application/remote-fleet/remote-fleet-capability-routes';
import type { RemoteFleetOperationId } from '../../runtime-host/application/remote-fleet/remote-fleet-operation-id';

const runtimeScope: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'remote-fleet',
    runtimeInstanceId: 'node-1:openclaw',
  },
};

const nonRemoteFleetRuntimeScope: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'node-1:openclaw',
  },
};

const runtimeEndpointTarget = { kind: 'runtime-endpoint' } as const;

type RemoteFleetCapabilityOperationId =
  | 'remoteFleet.runtime.status'
  | 'remoteFleet.runtime.start'
  | 'remoteFleet.runtime.stop'
  | 'remoteFleet.capabilities.sync';

function createRouteFor(operationId: RemoteFleetCapabilityOperationId) {
  const invoke = vi.fn(async () => ({ status: 200, data: { success: true } }));
  const route = createRemoteFleetCapabilityOperationRoutes({
    remoteFleetService: { invoke },
  }).find((candidate) => candidate.operationId === operationId);

  if (!route) {
    throw new Error(`Missing Remote Fleet capability route: ${operationId}`);
  }

  return { route, invoke };
}

function handleRoute(route: CapabilityOperationRoute, operationId: RemoteFleetCapabilityOperationId, input: Record<string, unknown> = {}) {
  return Promise.resolve(route.handle({
    capabilityId: REMOTE_FLEET_RUNTIME_CONTROL_CAPABILITY_ID,
    operationId,
    scope: runtimeScope,
    target: runtimeEndpointTarget,
    input,
    domainInput: input,
  }));
}

describe('createRemoteFleetCapabilityOperationRoutes', () => {
  it.each([
    ['remoteFleet.runtime.status', 'snapshot', {}],
    ['remoteFleet.runtime.start', 'start', { runtimeId: 'node-1:openclaw' }],
    ['remoteFleet.runtime.stop', 'stop', { runtimeId: 'node-1:openclaw' }],
    ['remoteFleet.capabilities.sync', 'sync', { runtimeId: 'node-1:openclaw' }],
  ] as const)('maps %s to Remote Fleet %s', async (operationId, remoteFleetOperationId, params) => {
    const { route, invoke } = createRouteFor(operationId);

    await expect(handleRoute(route, operationId, { runtimeId: 'ignored-input-runtime' })).resolves.toEqual({
      status: 200,
      data: { success: true },
    });

    expect(route.capabilityId).toBe(REMOTE_FLEET_RUNTIME_CONTROL_CAPABILITY_ID);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(remoteFleetOperationId satisfies RemoteFleetOperationId, params);
  });

  it('rejects non-runtime-endpoint targets before invoking Remote Fleet', async () => {
    const { route, invoke } = createRouteFor('remoteFleet.runtime.start');

    await expect(Promise.resolve(route.handle({
      capabilityId: REMOTE_FLEET_RUNTIME_CONTROL_CAPABILITY_ID,
      operationId: 'remoteFleet.runtime.start',
      scope: runtimeScope,
      target: { kind: 'runtime-job' },
      input: {},
      domainInput: {},
    }))).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Remote Fleet capability target must be runtime-endpoint' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects runtimeAddress input before invoking Remote Fleet', async () => {
    const { route, invoke } = createRouteFor('remoteFleet.runtime.stop');

    await expect(handleRoute(route, 'remoteFleet.runtime.stop', { runtimeAddress: { kind: 'legacy' } })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Remote Fleet capability input runtimeAddress is not allowed' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects non Remote Fleet runtime scopes before invoking Remote Fleet', async () => {
    const { route, invoke } = createRouteFor('remoteFleet.runtime.start');

    await expect(Promise.resolve(route.handle({
      capabilityId: REMOTE_FLEET_RUNTIME_CONTROL_CAPABILITY_ID,
      operationId: 'remoteFleet.runtime.start',
      scope: nonRemoteFleetRuntimeScope,
      target: runtimeEndpointTarget,
      input: {},
      domainInput: {},
    }))).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Remote Fleet runtime control requires a remote-fleet native runtime endpoint' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
