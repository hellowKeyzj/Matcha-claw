import { CronService } from '../../application/cron/service';
import {
  CRON_CREATE_JOB,
  CRON_DELETE_JOB,
  CRON_REFRESH_JOBS_JOB,
  CRON_REPAIR_DELIVERY_JOB,
  CRON_TOGGLE_JOB,
  CRON_TRIGGER_JOB,
  CRON_UPDATE_JOB,
  createCronRuntimeJobPort,
  type CronRuntimeJobPort,
} from '../../application/cron/cron-jobs';
import { CronRunHistoryRepository, CronSessionHistoryService } from '../../application/cron/cron-session-history';
import { LicenseService } from '../../application/license/service';
import { NodeLicenseRuntime } from '../license-node-runtime';
import { FileService } from '../../application/files/file-service';
import { PlatformService } from '../../application/platform-runtime/service';
import {
  PLATFORM_INSTALL_NATIVE_TOOL_JOB,
  PLATFORM_RECONCILE_TOOLS_JOB,
  createPlatformJobPort,
  type PlatformJobPort,
} from '../../application/platform-runtime/platform-jobs';
import {
  SECURITY_ADVISORIES_CHECK_JOB,
  SECURITY_EMERGENCY_RESPONSE_JOB,
  SECURITY_INTEGRITY_CHECK_JOB,
  SECURITY_INTEGRITY_REBASELINE_JOB,
  SECURITY_QUICK_AUDIT_JOB,
  SECURITY_REMEDIATION_APPLY_JOB,
  SECURITY_REMEDIATION_PREVIEW_JOB,
  SECURITY_REMEDIATION_ROLLBACK_JOB,
  SECURITY_SKILLS_SCAN_JOB,
  SECURITY_POLICY_SYNC_JOB,
  createSecurityJobPort,
  type SecurityJobPort,
} from '../../application/security/security-jobs';
import { SecurityRuntimeService } from '../../application/security/service';
import { SecurityPolicyRepository } from '../../application/security/security-policy-store';
import { TeamRuntimeService, createTeamRuntimeRootResolver } from '../../application/team-runtime/service';
import { TeamRuntimeApplicationService } from '../../application/team-runtime/team-runtime-application-service';
import { TeamRuntimeStorageRepository } from '../../application/team-runtime/team-runtime-storage-repository';
import { TaskManagerService } from '../../application/tasks/service';
import type { GatewayPluginCapabilityPort } from '../../application/gateway/gateway-capability-service';
import { ToolchainUvService } from '../../application/toolchain/uv-service';
import {
  TOOLCHAIN_UV_INSTALL_JOB,
  createToolchainJobPort,
  type ToolchainJobPort,
} from '../../application/toolchain/toolchain-jobs';
import type { OpenClawConfigRepositoryPort } from '../../application/openclaw/openclaw-config-repository';
import type { OpenClawEnvironmentRepository } from '../../application/openclaw/openclaw-environment-repository';
import type { OpenClawWorkspacePort } from '../../application/openclaw/openclaw-workspace-service';
import {
  REFRESH_TOKEN_USAGE_HISTORY_JOB,
  createTokenUsageHistoryJobPort,
  type TokenUsageHistoryJobPort,
} from '../../application/usage/token-usage-history-jobs';
import { TokenUsageHistoryRepository } from '../../application/usage/token-usage-history';
import {
  registerRuntimeJobDefinitions,
  type RuntimeJobDefinition,
  type RuntimeJobRegistry,
} from '../../core/jobs';
import {
  registerRuntimeLifecycleDefinitions,
  type RuntimeHostLifecycle,
} from '../../core/lifecycle';
import type { RuntimeHostApplicationServicesContext } from '../application-services';
import type { RuntimeHostContainer } from '../container';
import type { RuntimeLongTaskSubmissionPort } from '../../application/runtime-host/runtime-task-ports';
import type {
  RuntimeClockPort,
  RuntimeCommandExecutorPort,
  RuntimeFileSystemPort,
  RuntimeIdGeneratorPort,
  RuntimeSystemEnvironmentPort,
  RuntimeTimerPort,
} from '../../application/common/runtime-ports';

export interface OperationsApplicationServices {
  readonly cronService: CronService;
  readonly fileService: FileService;
  readonly licenseService: LicenseService;
  readonly platformService: PlatformService;
  readonly securityService: SecurityRuntimeService;
  readonly taskService: TaskManagerService;
  readonly teamRuntimeService: TeamRuntimeService;
  readonly toolchainUvService: ToolchainUvService;
}

export function registerOperationsApplicationServices(
  container: RuntimeHostContainer,
  context: RuntimeHostApplicationServicesContext,
): void {
  container.register('cron.runHistoryRepository', (scope) => new CronRunHistoryRepository({
    workspace: scope.resolve<OpenClawWorkspacePort>('openclaw.workspaceService'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('cron.sessionHistoryService', (scope) => new CronSessionHistoryService(
    scope.resolve<CronRunHistoryRepository>('cron.runHistoryRepository'),
    scope.resolve<RuntimeClockPort>('runtime.clock'),
  ));
  container.register('cron.jobs', (scope): CronRuntimeJobPort => createCronRuntimeJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('cron.service', (scope) => new CronService({
    gateway: context.openclawBridge,
    sessionHistory: scope.resolve<CronSessionHistoryService>('cron.sessionHistoryService'),
    usageHistory: scope.resolve<TokenUsageHistoryRepository>('usage.tokenHistoryRepository'),
    timer: scope.resolve<RuntimeTimerPort>('runtime.timer'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    jobs: scope.resolve<CronRuntimeJobPort>('cron.jobs'),
    requestUsageHistoryRefresh: () => {
      scope.resolve<TokenUsageHistoryJobPort>('usage.tokenHistoryJobs').submitRefreshHistory();
    },
  }));
  container.register('file.service', (scope) => new FileService({
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    systemEnvironment: scope.resolve<RuntimeSystemEnvironmentPort>('runtime.systemEnvironment'),
    environment: scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
  }));
  container.register('license.runtime', () => new NodeLicenseRuntime());
  container.register('license.service', (scope) => new LicenseService(scope.resolve('license.runtime')));
  container.register('platform.service', (scope) => new PlatformService({
    platformRuntime: context.platformRuntime,
    jobs: scope.resolve<PlatformJobPort>('platform.jobs'),
  }));
  container.register('platform.jobs', (scope): PlatformJobPort => createPlatformJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('security.policyRepository', (scope) => new SecurityPolicyRepository(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('security.jobs', (scope): SecurityJobPort => createSecurityJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('usage.tokenHistoryRepository', (scope) => new TokenUsageHistoryRepository({
    configRepository: scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('usage.tokenHistoryJobs', (scope): TokenUsageHistoryJobPort => createTokenUsageHistoryJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('security.service', (scope) => new SecurityRuntimeService({
    gateway: context.openclawBridge,
    policyRepository: scope.resolve<SecurityPolicyRepository>('security.policyRepository'),
    jobs: scope.resolve<SecurityJobPort>('security.jobs'),
  }));
  container.register('teamRuntime.storageRepository', (scope) => new TeamRuntimeStorageRepository({
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('teamRuntime.applicationService', (scope) => new TeamRuntimeApplicationService(
    scope.resolve('teamRuntime.storageRepository'),
    createTeamRuntimeRootResolver(scope.resolve<OpenClawWorkspacePort>('openclaw.workspaceService')),
  ));
  container.register('teamRuntime.service', (scope) => new TeamRuntimeService(
    scope.resolve('teamRuntime.applicationService'),
  ));
  container.register('task.service', (scope) => new TaskManagerService({
    gateway: context.openclawBridge,
    capabilities: scope.resolve<GatewayPluginCapabilityPort>('gateway.capabilities'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('toolchainUv.service', (scope) => new ToolchainUvService(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
    scope.resolve<RuntimeCommandExecutorPort>('runtime.commandExecutor'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    scope.resolve<ToolchainJobPort>('toolchain.jobs'),
  ));
  container.register('toolchain.jobs', (scope): ToolchainJobPort => createToolchainJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
}

export function resolveOperationsApplicationServices(container: RuntimeHostContainer): OperationsApplicationServices {
  return {
    cronService: container.resolve<CronService>('cron.service'),
    fileService: container.resolve<FileService>('file.service'),
    licenseService: container.resolve<LicenseService>('license.service'),
    platformService: container.resolve<PlatformService>('platform.service'),
    securityService: container.resolve<SecurityRuntimeService>('security.service'),
    taskService: container.resolve<TaskManagerService>('task.service'),
    teamRuntimeService: container.resolve<TeamRuntimeService>('teamRuntime.service'),
    toolchainUvService: container.resolve<ToolchainUvService>('toolchainUv.service'),
  };
}

export function registerOperationsJobs(
  container: RuntimeHostContainer,
  deps: {
    readonly jobRegistry: RuntimeJobRegistry;
  },
): void {
  registerRuntimeJobDefinitions(deps.jobRegistry, createOperationsJobDefinitions(container));
}

function createOperationsJobDefinitions(
  container: RuntimeHostContainer,
): readonly RuntimeJobDefinition[] {
  return [
    {
      type: REFRESH_TOKEN_USAGE_HISTORY_JOB,
      handler: async () => {
        await container.resolve<TokenUsageHistoryRepository>('usage.tokenHistoryRepository').refreshCache();
      },
    },
    {
      type: CRON_REPAIR_DELIVERY_JOB,
      handler: async () => {
        return await container.resolve<CronService>('cron.service').executeDeliveryRepair();
      },
    },
    {
      type: CRON_REFRESH_JOBS_JOB,
      handler: async () => {
        return await container.resolve<CronService>('cron.service').refreshJobsSnapshot();
      },
    },
    {
      type: CRON_TRIGGER_JOB,
      handler: async (payload) => {
        return await container.resolve<CronService>('cron.service').executeTrigger(payload);
      },
    },
    {
      type: CRON_CREATE_JOB,
      handler: async (payload) => {
        return await container.resolve<CronService>('cron.service').executeCreateJob(payload);
      },
    },
    {
      type: CRON_UPDATE_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const jobId = typeof body.jobId === 'string' ? body.jobId : '';
        if (!jobId) {
          throw new Error('jobId is required');
        }
        return await container.resolve<CronService>('cron.service').executeUpdateJob(jobId, body.updates);
      },
    },
    {
      type: CRON_DELETE_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const jobId = typeof body.jobId === 'string' ? body.jobId : '';
        if (!jobId) {
          throw new Error('jobId is required');
        }
        return await container.resolve<CronService>('cron.service').executeDeleteJob(jobId);
      },
    },
    {
      type: CRON_TOGGLE_JOB,
      handler: async (payload) => {
        return await container.resolve<CronService>('cron.service').executeToggleJob(payload);
      },
    },
    {
      type: SECURITY_POLICY_SYNC_JOB,
      handler: async () => {
        return await container.resolve<SecurityRuntimeService>('security.service').executePolicySync();
      },
    },
    {
      type: SECURITY_SKILLS_SCAN_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const scanPath = typeof body.scanPath === 'string' ? body.scanPath : undefined;
        return await container.resolve<SecurityRuntimeService>('security.service').executeSkillsScan(scanPath);
      },
    },
    {
      type: SECURITY_QUICK_AUDIT_JOB,
      handler: async () => {
        return await container.resolve<SecurityRuntimeService>('security.service').executeQuickAudit();
      },
    },
    {
      type: SECURITY_EMERGENCY_RESPONSE_JOB,
      handler: async () => {
        return await container.resolve<SecurityRuntimeService>('security.service').executeEmergencyResponse();
      },
    },
    {
      type: SECURITY_INTEGRITY_CHECK_JOB,
      handler: async () => {
        return await container.resolve<SecurityRuntimeService>('security.service').executeIntegrityCheck();
      },
    },
    {
      type: SECURITY_INTEGRITY_REBASELINE_JOB,
      handler: async () => {
        return await container.resolve<SecurityRuntimeService>('security.service').executeIntegrityRebaseline();
      },
    },
    {
      type: SECURITY_ADVISORIES_CHECK_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const feedUrl = typeof body.feedUrl === 'string' ? body.feedUrl : null;
        return await container.resolve<SecurityRuntimeService>('security.service').executeAdvisoriesCheck(feedUrl);
      },
    },
    {
      type: SECURITY_REMEDIATION_PREVIEW_JOB,
      handler: async () => {
        return await container.resolve<SecurityRuntimeService>('security.service').executeRemediationPreview();
      },
    },
    {
      type: SECURITY_REMEDIATION_APPLY_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const actions = Array.isArray(body.actions)
          ? body.actions.filter((item): item is string => typeof item === 'string')
          : [];
        return await container.resolve<SecurityRuntimeService>('security.service').executeRemediationApply(actions);
      },
    },
    {
      type: SECURITY_REMEDIATION_ROLLBACK_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const snapshotId = typeof body.snapshotId === 'string' ? body.snapshotId : undefined;
        return await container.resolve<SecurityRuntimeService>('security.service').executeRemediationRollback(snapshotId);
      },
    },
    {
      type: TOOLCHAIN_UV_INSTALL_JOB,
      handler: async () => {
        return await container.resolve<ToolchainUvService>('toolchainUv.service').executeInstall();
      },
    },
    {
      type: PLATFORM_INSTALL_NATIVE_TOOL_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        if (!body.source || typeof body.source !== 'object' || Array.isArray(body.source)) {
          throw new Error('source is required');
        }
        return await container.resolve<PlatformService>('platform.service').executeInstallNativeTool(body.source as never);
      },
    },
    {
      type: PLATFORM_RECONCILE_TOOLS_JOB,
      handler: async () => {
        return await container.resolve<PlatformService>('platform.service').executeReconcileTools();
      },
    },
  ];
}

function readJobPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

export function registerOperationsLifecycle(
  container: RuntimeHostContainer,
  deps: {
    readonly lifecycle: RuntimeHostLifecycle;
  },
): void {
  registerRuntimeLifecycleDefinitions(deps.lifecycle, {
    backgroundServices: [
      {
        name: 'usage.history-refresh',
        start: () => {
          container.resolve<TokenUsageHistoryJobPort>('usage.tokenHistoryJobs').submitRefreshHistory();
        },
      },
      {
        name: 'cron.jobs-refresh',
        start: () => {
          container.resolve<CronRuntimeJobPort>('cron.jobs').submitRefreshJobs();
        },
      },
    ],
  });
}
