import type { PlatformService } from '../../platform-runtime/service';
import type { ToolchainUvService } from '../../toolchain/uv-service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const PLATFORM_RUNTIME_CAPABILITY_ID = 'platform.runtime';

export const platformRuntimeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'platform.startRun', title: 'Start platform runtime run' },
  { id: 'platform.abortRun', title: 'Abort platform runtime run' },
  { id: 'platform.installNativeTool', title: 'Install native platform tool' },
  { id: 'platform.reconcileTools', title: 'Reconcile platform tools' },
  { id: 'platform.upsertTools', title: 'Upsert platform tools' },
  { id: 'platform.setToolEnabled', title: 'Set platform tool enabled' },
  { id: 'toolchain.installUv', title: 'Install uv toolchain' },
] as const;

export function createPlatformRuntimeCapabilityOperationRoutes(deps: {
  platformService: Pick<PlatformService,
    | 'startRun'
    | 'abortRun'
    | 'installNativeTool'
    | 'reconcileTools'
    | 'upsertPlatformTools'
    | 'setToolEnabled'
  >;
  toolchainUvService: Pick<ToolchainUvService, 'install'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: PLATFORM_RUNTIME_CAPABILITY_ID,
      operationId: 'platform.startRun',
      handle: async (context) => ({ status: 200, data: await deps.platformService.startRun(context.domainInput) }),
    },
    {
      capabilityId: PLATFORM_RUNTIME_CAPABILITY_ID,
      operationId: 'platform.abortRun',
      handle: (context) => deps.platformService.abortRun(context.domainInput),
    },
    {
      capabilityId: PLATFORM_RUNTIME_CAPABILITY_ID,
      operationId: 'platform.installNativeTool',
      handle: (context) => deps.platformService.installNativeTool(context.domainInput),
    },
    {
      capabilityId: PLATFORM_RUNTIME_CAPABILITY_ID,
      operationId: 'platform.reconcileTools',
      handle: () => ({ status: 202, data: deps.platformService.reconcileTools() }),
    },
    {
      capabilityId: PLATFORM_RUNTIME_CAPABILITY_ID,
      operationId: 'platform.upsertTools',
      handle: async (context) => ({ status: 200, data: await deps.platformService.upsertPlatformTools(context.domainInput) }),
    },
    {
      capabilityId: PLATFORM_RUNTIME_CAPABILITY_ID,
      operationId: 'platform.setToolEnabled',
      handle: (context) => deps.platformService.setToolEnabled(context.domainInput),
    },
    {
      capabilityId: PLATFORM_RUNTIME_CAPABILITY_ID,
      operationId: 'toolchain.installUv',
      handle: () => ({ status: 202, data: deps.toolchainUvService.install() }),
    },
  ];
}

