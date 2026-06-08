import type { PlatformService } from '../../platform-runtime/service';
import type { ToolchainUvService } from '../../toolchain/uv-service';
import { badRequest } from '../../common/application-response';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute, CapabilityOperationContext } from '../contracts/capability-router';

export const PLATFORM_RUNTIME_CAPABILITY_ID = 'platform.runtime';

export const platformRuntimeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'platform.startRun', title: 'Start platform runtime run', targetKind: 'runtime-job' },
  { id: 'platform.abortRun', title: 'Abort platform runtime run', targetKind: 'runtime-job' },
  { id: 'platform.installNativeTool', title: 'Install native platform tool', targetKind: 'tool' },
  { id: 'platform.reconcileTools', title: 'Reconcile platform tools', targetKind: 'runtime-endpoint' },
  { id: 'platform.upsertTools', title: 'Upsert platform tools', targetKind: 'runtime-endpoint' },
  { id: 'platform.setToolEnabled', title: 'Set platform tool enabled', targetKind: 'runtime-endpoint' },
  { id: 'toolchain.installUv', title: 'Install uv toolchain', targetKind: 'runtime-job' },
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
      handle: (context) => {
        const targetError = validateAbortRunTargetInput(context);
        return targetError ? badRequest(targetError) : deps.platformService.abortRun(context.domainInput);
      },
    },
    {
      capabilityId: PLATFORM_RUNTIME_CAPABILITY_ID,
      operationId: 'platform.installNativeTool',
      handle: (context) => {
        const targetError = validateInstallNativeToolTargetInput(context);
        return targetError ? badRequest(targetError) : deps.platformService.installNativeTool(context.domainInput);
      },
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

function validateAbortRunTargetInput(context: CapabilityOperationContext): string | null {
  if (context.target?.kind !== 'runtime-job') {
    return 'Capability target kind must be runtime-job';
  }
  const runId = readString(context.domainInput.runId);
  if (!runId) {
    return 'input runId is required';
  }
  return context.target.jobId === runId
    ? null
    : 'Capability target jobId must match input runId';
}

function validateInstallNativeToolTargetInput(context: CapabilityOperationContext): string | null {
  if (context.target?.kind !== 'tool') {
    return 'Capability target kind must be tool';
  }
  const source = readRecord(context.domainInput.source);
  const inputToolName = readString(context.domainInput.toolId)
    || readString(source.toolId)
    || readString(source.id)
    || readString(source.spec);
  if (!inputToolName) {
    return 'Capability input toolId or source id/spec is required';
  }
  return context.target.toolName === inputToolName
    ? null
    : 'Capability target toolName must match input tool id/source spec';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

