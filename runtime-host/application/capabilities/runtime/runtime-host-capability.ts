import type { GatewayService } from '../../gateway/service';
import type { RuntimeHostService } from '../../runtime-host/service';
import { badRequest } from '../../common/application-response';
import type { RuntimeJobTarget } from '../../agent-runtime/contracts/runtime-address';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute, CapabilityOperationContext } from '../contracts/capability-router';

export const RUNTIME_HOST_CAPABILITY_ID = 'runtime.host';

export const runtimeHostCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'runtimeHost.prepareGatewayLaunch', title: 'Prepare gateway launch', targetKind: 'gateway-control' },
  { id: 'runtimeHost.syncProviderAuthBootstrap', title: 'Sync provider auth bootstrap', targetKind: 'runtime-endpoint' },
  { id: 'runtimeHost.gatewayLifecycle', title: 'Handle gateway lifecycle', targetKind: 'gateway-control' },
  { id: 'runtimeHost.gatewayReady', title: 'Probe gateway control readiness', targetKind: 'gateway-control' },
  { id: 'runtimeHost.gatewayControlUiAutoApprove', title: 'Approve gateway control UI pairing', targetKind: 'gateway-control' },
  { id: 'runtimeHost.jobGet', title: 'Read runtime job detail', targetKind: 'runtime-job', targetRequired: true },
  { id: 'diagnostics.collect', title: 'Collect diagnostics bundle', targetKind: 'runtime-endpoint' },
] as const;

export function createRuntimeHostCapabilityOperationRoutes(deps: {
  runtimeHostService: Pick<RuntimeHostService,
    | 'prepareGatewayLaunch'
    | 'syncProviderAuthBootstrap'
    | 'gatewayLifecycle'
    | 'collectDiagnostics'
    | 'runtimeJob'
  >;
  gatewayService: Pick<GatewayService, 'ready' | 'approvePendingControlUiPairingRequests'>;
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
      operationId: 'runtimeHost.gatewayReady',
      handle: (context) => deps.gatewayService.ready(context.domainInput),
    },
    {
      capabilityId: RUNTIME_HOST_CAPABILITY_ID,
      operationId: 'runtimeHost.gatewayControlUiAutoApprove',
      handle: () => deps.gatewayService.approvePendingControlUiPairingRequests(),
    },
    {
      capabilityId: RUNTIME_HOST_CAPABILITY_ID,
      operationId: 'runtimeHost.jobGet',
      handle: (context) => {
        const targetError = validateRuntimeJobTargetInput(context);
        if (targetError) {
          return badRequest(targetError);
        }
        const target = context.target as RuntimeJobTarget;
        return deps.runtimeHostService.runtimeJob({ jobId: target.jobId });
      },
    },
    {
      capabilityId: RUNTIME_HOST_CAPABILITY_ID,
      operationId: 'diagnostics.collect',
      handle: (context) => deps.runtimeHostService.collectDiagnostics(context.domainInput),
    },
  ];
}

function validateRuntimeJobTargetInput(context: CapabilityOperationContext): string | null {
  if (context.target?.kind !== 'runtime-job') {
    return 'Capability target kind must be runtime-job';
  }
  const targetJobId = readString(context.target.jobId);
  const inputJobId = readString(context.domainInput.jobId);
  if (!targetJobId || !inputJobId) {
    return 'Capability target jobId and input jobId are required';
  }
  return targetJobId === inputJobId
    ? null
    : 'Capability target jobId must match input jobId';
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

