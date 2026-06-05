import type { RuntimeHostService } from '../../runtime-host/service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const RUNTIME_HOST_CAPABILITY_ID = 'runtime.host';

export const runtimeHostCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'runtimeHost.prepareGatewayLaunch', title: 'Prepare gateway launch' },
  { id: 'runtimeHost.syncProviderAuthBootstrap', title: 'Sync provider auth bootstrap' },
  { id: 'runtimeHost.gatewayLifecycle', title: 'Handle gateway lifecycle' },
  { id: 'diagnostics.collect', title: 'Collect diagnostics bundle' },
] as const;

export function createRuntimeHostCapabilityOperationRoutes(deps: {
  runtimeHostService: Pick<RuntimeHostService,
    | 'prepareGatewayLaunch'
    | 'syncProviderAuthBootstrap'
    | 'gatewayLifecycle'
    | 'collectDiagnostics'
  >;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: RUNTIME_HOST_CAPABILITY_ID,
      operationId: 'runtimeHost.prepareGatewayLaunch',
      handle: (context) => deps.runtimeHostService.prepareGatewayLaunch(context.domainInput),
    },
    {
      capabilityId: RUNTIME_HOST_CAPABILITY_ID,
      operationId: 'runtimeHost.syncProviderAuthBootstrap',
      handle: () => deps.runtimeHostService.syncProviderAuthBootstrap(),
    },
    {
      capabilityId: RUNTIME_HOST_CAPABILITY_ID,
      operationId: 'runtimeHost.gatewayLifecycle',
      handle: (context) => deps.runtimeHostService.gatewayLifecycle(context.domainInput),
    },
    {
      capabilityId: RUNTIME_HOST_CAPABILITY_ID,
      operationId: 'diagnostics.collect',
      handle: (context) => deps.runtimeHostService.collectDiagnostics(context.domainInput),
    },
  ];
}

