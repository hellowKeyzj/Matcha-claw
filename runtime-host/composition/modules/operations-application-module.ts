import path from 'node:path';
import { CronService } from '../../application/cron/service';
import type { CronDeliveryChannelProjectionPort } from '../../application/cron/cron-model';
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
import { FileService, type FileRuntimeDataStorePort } from '../../application/files/file-service';
import type { OpenClawWorkspaceService } from '../../application/adapters/openclaw/infrastructure/openclaw-workspace-service';
import { PlatformService } from '../../application/platform-runtime/service';
import type { RuntimeHostPlatformFacade } from '../../application/platform-runtime';
import type { RuntimeHostLogger } from '../../shared/logger';
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
import { PluginRuntimeService } from '../../application/plugins/plugin-runtime-service';
import { SecurityRuntimeService } from '../../application/security/service';
import { SecurityPluginConfigApplier, type SecurityPluginConfigProjectionPort } from '../../application/security/security-plugin-config-applier';
import { SecurityPolicyRepository, type SecurityPolicyStoragePort } from '../../application/security/security-policy-store';
import { SecurityPolicyStoreWorkflow } from '../../application/workflows/security-policy/security-policy-store-workflow';
import { WorkerBackedTeamRuntimeService } from '../../application/team-runtime/team-runtime-worker-client';
import type { TeamRuntimePort } from '../../application/team-runtime/team-runtime-port';
import { TeamRuntimeWebhookAuthService } from '../../application/team-runtime/team-runtime-webhook-auth';
import {
  DELETE_TEAM_MANAGED_AGENTS_JOB,
  createTeamRuntimeJobPort,
  type TeamRuntimeJobPort,
} from '../../application/team-runtime/team-runtime-jobs';
import { OpenClawTeamAgentMaterializationAdapter } from '../../application/team-runtime/adapters/openclaw/openclaw-team-agent-materialization-adapter';
import type { TeamAgentMaterializationPort } from '../../application/team-runtime/ports/team-agent-materialization-port';
import { SessionRuntimeTeamRoleSessionAdapter } from '../../application/team-runtime/adapters/session-runtime-team-role-session-adapter';
import { OpenClawTeamRoleSessionMaterializationAdapter } from '../../application/team-runtime/adapters/openclaw/openclaw-team-role-session-materialization-adapter';
import { SkillsService } from '../../application/skills/service';
import { TaskManagerService } from '../../application/tasks/service';
import type { SessionRuntimeService } from '../../application/sessions/service';
import type { TaskWorkspacePort } from '../../application/workflows/task-runtime/task-runtime-workflow';
import { TaskOperationsWorkflow } from '../../application/workflows/task-runtime/task-operations-workflow';
import { TaskRuntimeWorkflow } from '../../application/workflows/task-runtime/task-runtime-workflow';
import type { GatewayPluginCapabilityPort } from '../../application/gateway/gateway-capability-service';
import type { GatewayCronPort, GatewayRuntimePort, GatewaySecurityPort } from '../../application/gateway/gateway-runtime-port';
import { ToolchainUvService, type ToolchainUvRuntimePort } from '../../application/toolchain/uv-service';
import {
  TOOLCHAIN_UV_INSTALL_JOB,
  createToolchainJobPort,
  type ToolchainJobPort,
} from '../../application/toolchain/toolchain-jobs';
import {
  REFRESH_TOKEN_USAGE_HISTORY_JOB,
  createTokenUsageHistoryJobPort,
  type TokenUsageHistoryJobPort,
} from '../../application/usage/token-usage-history-jobs';
import { TokenUsageHistoryRepository, type TokenUsageRuntimeDataPort, type TokenUsageTranscriptLayoutPort } from '../../application/usage/token-usage-history';
import { TokenUsageHistoryWorkflow } from '../../application/workflows/usage/token-usage-history-workflow';
import { ScheduledAgentTriggerWorkflow } from '../../application/workflows/scheduled-agent/scheduled-agent-trigger-workflow';
import { CronJobMutationWorkflow } from '../../application/workflows/cron/cron-job-mutation-workflow';
import { CronOperationsWorkflow } from '../../application/workflows/cron/cron-operations-workflow';
import { SecurityEmergencyResponseWorkflow } from '../../application/workflows/security-emergency/security-emergency-response-workflow';
import { SecurityGatewayOperationsWorkflow } from '../../application/workflows/security-operations/security-gateway-operations-workflow';
import { SecurityOperationsWorkflow } from '../../application/workflows/security-operations/security-operations-workflow';
import { SecurityPolicySyncWorkflow } from '../../application/workflows/security-policy/security-policy-sync-workflow';
import { UvPythonInstallWorkflow } from '../../application/workflows/toolchain-install/uv-python-install-workflow';
import { PlatformRuntimeOperationsWorkflow } from '../../application/workflows/platform-runtime/platform-runtime-operations-workflow';
import { PlatformToolRuntimeWorkflow } from '../../application/workflows/platform-runtime/platform-tool-runtime-workflow';
import { WorkspaceFileRuntimeWorkflow } from '../../application/workflows/workspace-file/workspace-file-runtime-workflow';
import { createPluginRuntimeCapabilityOperationRoutes } from '../../application/capabilities/plugin/plugin-runtime-capability';
import { createCronSchedulerCapabilityOperationRoutes } from '../../application/capabilities/scheduler/cron-scheduler-capability';
import { createSecurityRuntimeCapabilityOperationRoutes } from '../../application/capabilities/security/security-runtime-capability';
import { createTaskControlCapabilityOperationRoutes } from '../../application/capabilities/task/task-control-capability';
import { createTeamRuntimeCapabilityOperationRoutes } from '../../application/capabilities/team/team-runtime-capability';
import { createToolInvokeCapabilityOperationRoutes } from '../../application/capabilities/tool/tool-invoke-capability';
import { createWorkspaceFileCapabilityOperationRoutes } from '../../application/capabilities/workspace/workspace-file-capability';
import { createLicenseRuntimeCapabilityOperationRoutes } from '../../application/capabilities/license/license-runtime-capability';
import { createPlatformRuntimeCapabilityOperationRoutes } from '../../application/capabilities/platform/platform-runtime-capability';
import type { CapabilityOperationRoute } from '../../application/capabilities/contracts/capability-router';
import type { RuntimeEndpointRef } from '../../application/agent-runtime/contracts/runtime-address';
import type { RemoveTeamAgentsInput } from '../../application/team-runtime/ports/team-agent-materialization-port';
import {
  registerRuntimeJobDefinitions,
  type RuntimeJobDefinition,
  type RuntimeJobRegistry,
} from '../../core/jobs';
import {
  registerRuntimeLifecycleDefinitions,
  type RuntimeHostLifecycle,
} from '../../core/lifecycle';
import type { ApplicationServiceRegistry } from '../application-service-registry';
import type { ParentGatewayForwardEventName } from '../../shared/parent-transport-contracts';
import type { RuntimeHostContainer } from '../container';
import type { RuntimeLongTaskSubmissionPort } from '../../application/runtime-host/runtime-task-ports';
import type { BackgroundTaskManager } from '../../services/background-task-manager';
import {
  CRON_SERVICE_TOKEN,
  FILE_SERVICE_TOKEN,
  LICENSE_SERVICE_TOKEN,
  PLATFORM_SERVICE_TOKEN,
  SECURITY_SERVICE_TOKEN,
  SESSION_RUNTIME_TOKEN,
  TASK_SERVICE_TOKEN,
  TEAM_RUNTIME_SERVICE_TOKEN,
  TEAM_RUNTIME_WEBHOOK_AUTH_TOKEN,
  TOOLCHAIN_UV_SERVICE_TOKEN,
} from '../runtime-host-tokens';
import type {
  RuntimeClockPort,
  RuntimeCommandExecutorPort,
  RuntimeDataRootPort,
  RuntimeFileSystemPort,
  RuntimeIdGeneratorPort,
  RuntimeSystemEnvironmentPort,
  RuntimeTimerPort,
} from '../../application/common/runtime-ports';

export function registerOperationsApplicationServices(
  container: RuntimeHostContainer,
  facades: ApplicationServiceRegistry,
  options: { only?: 'license' } = {},
): void {
  if (options.only === 'license') {
    container.register('license.runtime', (scope) => new NodeLicenseRuntime({
      onGateChanged: (snapshot) => {
        void scope.resolve<{ emit: (eventName: ParentGatewayForwardEventName, payload: unknown) => Promise<void> }>('runtimeHost.parentGatewayEvents').emit('license:gate-changed', snapshot).catch(() => undefined);
      },
    }));
    container.register('license.service', (scope) => new LicenseService(scope.resolve('license.runtime')));
    return;
  }
  container.register('cron.runtimeData', (scope): RuntimeDataRootPort => scope.resolve<RuntimeDataRootPort>('runtimeHost.runtimeDataRoot'));
  container.register('cron.runHistoryRepository', (scope) => new CronRunHistoryRepository({
    runtimeData: scope.resolve<RuntimeDataRootPort>('cron.runtimeData'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('cron.sessionHistoryService', (scope) => new CronSessionHistoryService(
    scope.resolve<CronRunHistoryRepository>('cron.runHistoryRepository'),
    scope.resolve<RuntimeClockPort>('runtime.clock'),
  ));
  container.register('cron.jobs', (scope): CronRuntimeJobPort => createCronRuntimeJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('scheduledAgent.triggerWorkflow', (scope) => new ScheduledAgentTriggerWorkflow({
    gateway: scope.resolve<GatewayCronPort>('gateway.runtime'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    timer: scope.resolve<RuntimeTimerPort>('runtime.timer'),
  }));
  container.register('cron.jobMutationWorkflow', (scope) => new CronJobMutationWorkflow({
    gateway: scope.resolve<GatewayCronPort>('gateway.runtime'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    jobs: scope.resolve<CronRuntimeJobPort>('cron.jobs'),
    scheduledAgentTriggerWorkflow: scope.resolve<ScheduledAgentTriggerWorkflow>('scheduledAgent.triggerWorkflow'),
    deliveryChannelProjection: scope.resolve<CronDeliveryChannelProjectionPort>('channels.deliveryProjection'),
  }));
  container.register('cron.operationsWorkflow', (scope) => new CronOperationsWorkflow({
    gateway: scope.resolve<GatewayCronPort>('gateway.runtime'),
    usageHistory: scope.resolve<TokenUsageHistoryRepository>('usage.tokenHistoryRepository'),
    jobs: scope.resolve<CronRuntimeJobPort>('cron.jobs'),
    jobMutationWorkflow: scope.resolve<CronJobMutationWorkflow>('cron.jobMutationWorkflow'),
    deliveryChannelProjection: scope.resolve<CronDeliveryChannelProjectionPort>('channels.deliveryProjection'),
    requestUsageHistoryRefresh: () => {
      scope.resolve<TokenUsageHistoryJobPort>('usage.tokenHistoryJobs').submitRefreshHistory();
    },
  }));
  container.register('cron.service', (scope) => new CronService({
    sessionHistory: scope.resolve<CronSessionHistoryService>('cron.sessionHistoryService'),
    operationsWorkflow: scope.resolve<CronOperationsWorkflow>('cron.operationsWorkflow'),
  }));
  container.register('file.runtimeWorkflow', (scope) => new WorkspaceFileRuntimeWorkflow({
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    systemEnvironment: scope.resolve<RuntimeSystemEnvironmentPort>('runtime.systemEnvironment'),
    runtimeDataStore: scope.resolve<FileRuntimeDataStorePort>('file.runtimeDataStore'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
    workspaceRoots: scope.resolve<OpenClawWorkspaceService>('openclaw.workspaceService'),
  }));
  container.register('file.service', (scope) => new FileService({
    runtimeWorkflow: scope.resolve<WorkspaceFileRuntimeWorkflow>('file.runtimeWorkflow'),
  }));
  container.register('platform.toolRuntimeWorkflow', (scope) => new PlatformToolRuntimeWorkflow({
    platformRuntime: scope.resolve<RuntimeHostPlatformFacade>('platform.facade'),
  }));
  container.register('platform.operationsWorkflow', (scope) => new PlatformRuntimeOperationsWorkflow({
    platformRuntime: scope.resolve<RuntimeHostPlatformFacade>('platform.facade'),
    jobs: scope.resolve<PlatformJobPort>('platform.jobs'),
    toolRuntimeWorkflow: scope.resolve<PlatformToolRuntimeWorkflow>('platform.toolRuntimeWorkflow'),
  }));
  container.register('platform.service', (scope) => new PlatformService({
    operationsWorkflow: scope.resolve<PlatformRuntimeOperationsWorkflow>('platform.operationsWorkflow'),
  }));
  container.register('platform.jobs', (scope): PlatformJobPort => createPlatformJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('security.policyStoreWorkflow', (scope) => new SecurityPolicyStoreWorkflow({
    storage: scope.resolve<SecurityPolicyStoragePort>('security.policyStorage'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('security.policyRepository', (scope) => new SecurityPolicyRepository(
    scope.resolve<SecurityPolicyStoreWorkflow>('security.policyStoreWorkflow'),
  ));
  container.register('security.pluginConfigApplier', (scope) => new SecurityPluginConfigApplier(
    scope.resolve<SecurityPluginConfigProjectionPort>('security.pluginConfigProjection'),
    scope.resolve<SecurityPolicyRepository>('security.policyRepository'),
  ));
  container.register('security.jobs', (scope): SecurityJobPort => createSecurityJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('security.emergencyResponseWorkflow', (scope) => new SecurityEmergencyResponseWorkflow({
    gateway: scope.resolve<GatewaySecurityPort>('gateway.runtime'),
    policyRepository: scope.resolve<SecurityPolicyRepository>('security.policyRepository'),
  }));
  container.register('security.policySyncWorkflow', (scope) => new SecurityPolicySyncWorkflow({
    gateway: scope.resolve<GatewaySecurityPort>('gateway.runtime'),
    policyRepository: scope.resolve<SecurityPolicyRepository>('security.policyRepository'),
    timer: scope.resolve<RuntimeTimerPort>('runtime.timer'),
  }));
  container.register('security.gatewayOperationsWorkflow', (scope) => new SecurityGatewayOperationsWorkflow({
    gateway: scope.resolve<GatewaySecurityPort>('gateway.runtime'),
  }));
  container.register('security.operationsWorkflow', (scope) => new SecurityOperationsWorkflow({
    policyRepository: scope.resolve<SecurityPolicyRepository>('security.policyRepository'),
    jobs: scope.resolve<SecurityJobPort>('security.jobs'),
    policySyncWorkflow: scope.resolve<SecurityPolicySyncWorkflow>('security.policySyncWorkflow'),
    emergencyResponseWorkflow: scope.resolve<SecurityEmergencyResponseWorkflow>('security.emergencyResponseWorkflow'),
    gatewayOperationsWorkflow: scope.resolve<SecurityGatewayOperationsWorkflow>('security.gatewayOperationsWorkflow'),
  }));
  container.register('usage.tokenHistoryWorkflow', (scope) => new TokenUsageHistoryWorkflow({
    runtimeData: scope.resolve<TokenUsageRuntimeDataPort>('usage.runtimeData'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    transcriptLayout: scope.resolve<TokenUsageTranscriptLayoutPort>('usage.transcriptLayout'),
  }));
  container.register('usage.tokenHistoryRepository', (scope) => new TokenUsageHistoryRepository(
    scope.resolve<TokenUsageHistoryWorkflow>('usage.tokenHistoryWorkflow'),
  ));
  container.register('usage.tokenHistoryJobs', (scope): TokenUsageHistoryJobPort => createTokenUsageHistoryJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('security.service', (scope) => new SecurityRuntimeService({
    operationsWorkflow: scope.resolve<SecurityOperationsWorkflow>('security.operationsWorkflow'),
  }));
  container.register('teamRuntime.openclawMaterialization', (scope) => new OpenClawTeamAgentMaterializationAdapter({
    gateway: scope.resolve<GatewayRuntimePort>('gateway.runtime'),
    capabilities: scope.resolve<GatewayPluginCapabilityPort>('gateway.capabilities'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    openClawConfigDir: scope.resolve<OpenClawWorkspaceService>('openclaw.workspaceService').getConfigDir(),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('teamRuntime.roleSessions', (scope) => {
    const sessionService = scope.resolve<SessionRuntimeService>(SESSION_RUNTIME_TOKEN);
    const endpointSessionMaterialization = new OpenClawTeamRoleSessionMaterializationAdapter({
      gateway: scope.resolve<GatewayRuntimePort>('gateway.runtime'),
    });
    return new SessionRuntimeTeamRoleSessionAdapter({
      createSession: (payload) => sessionService.createSession(payload),
      promptSession: (payload) => sessionService.promptSession(payload),
      abortSession: (payload) => sessionService.abortSession(payload),
      deleteSession: (payload) => sessionService.deleteSession(payload),
      getSessionWindow: (payload) => sessionService.getSessionWindow(payload),
      endpointSessionMaterialization,
    });
  });
  container.register('teamRuntime.jobs', (scope): TeamRuntimeJobPort => createTeamRuntimeJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('teamRuntime.webhookAuth', (scope) => new TeamRuntimeWebhookAuthService({
    environment: scope.resolve<RuntimeSystemEnvironmentPort>('runtime.systemEnvironment'),
    settingsRepository: scope.resolve('settings.repository'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
  }));
  container.register('teamRuntime.service', (scope) => new WorkerBackedTeamRuntimeService({
    workerScriptPath: path.join(__dirname, '../../application/team-runtime/infrastructure/worker/team-runtime-worker-entry.js'),
    config: {
      runtimeDataRootDir: scope.resolve<RuntimeDataRootPort>('runtimeHost.runtimeDataRoot').getRuntimeDataRootDir(),
    },
    agentMaterialization: scope.resolve<TeamAgentMaterializationPort>('teamRuntime.openclawMaterialization'),
    roleSessions: scope.resolve<SessionRuntimeTeamRoleSessionAdapter>('teamRuntime.roleSessions'),
    jobs: scope.resolve<TeamRuntimeJobPort>('teamRuntime.jobs'),
    skillsService: scope.resolve<SkillsService>('skills.service'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('task.runtimeWorkflow', (scope) => new TaskRuntimeWorkflow({
    gateway: scope.resolve<GatewayRuntimePort>('gateway.runtime'),
    capabilities: scope.resolve<GatewayPluginCapabilityPort>('gateway.capabilities'),
    workspace: scope.resolve<TaskWorkspacePort>('operations.taskWorkspace'),
    emitTaskSnapshot: (event) => {
      void scope.resolve<{ emit: (eventName: ParentGatewayForwardEventName, payload: unknown) => Promise<void> }>('runtimeHost.parentGatewayEvents').emit('task:snapshot', event).catch(() => undefined);
    },
  }));
  container.register('task.operationsWorkflow', (scope) => new TaskOperationsWorkflow({
    runtimeWorkflow: scope.resolve<TaskRuntimeWorkflow>('task.runtimeWorkflow'),
    backgroundTasks: scope.resolve<BackgroundTaskManager>('runtime.backgroundTasks'),
  }));
  container.register('task.service', (scope) => new TaskManagerService(
    scope.resolve<TaskOperationsWorkflow>('task.operationsWorkflow'),
  ));
  container.register('toolchainUv.installWorkflow', (scope) => new UvPythonInstallWorkflow({
    runtime: scope.resolve<ToolchainUvRuntimePort>('toolchainUv.runtime'),
    commandExecutor: scope.resolve<RuntimeCommandExecutorPort>('runtime.commandExecutor'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('toolchainUv.service', (scope) => new ToolchainUvService(
    scope.resolve<UvPythonInstallWorkflow>('toolchainUv.installWorkflow'),
    scope.resolve<ToolchainJobPort>('toolchain.jobs'),
  ));
  container.register('toolchain.jobs', (scope): ToolchainJobPort => createToolchainJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  registerOperationsCapabilityOperationRoutes(container);
  facades.registerContainerFacade('operations', CRON_SERVICE_TOKEN, container);
  facades.registerContainerFacade('operations', FILE_SERVICE_TOKEN, container);
  facades.registerContainerFacade('operations', LICENSE_SERVICE_TOKEN, container);
  facades.registerContainerFacade('operations', TOOLCHAIN_UV_SERVICE_TOKEN, container);
  facades.registerContainerFacade('operations', SECURITY_SERVICE_TOKEN, container);
  facades.registerContainerFacade('operations', TASK_SERVICE_TOKEN, container);
  facades.registerContainerFacade('operations', TEAM_RUNTIME_SERVICE_TOKEN, container);
  facades.registerContainerFacade('operations', TEAM_RUNTIME_WEBHOOK_AUTH_TOKEN, container);
  facades.registerContainerFacade('operations', PLATFORM_SERVICE_TOKEN, container);
}

function registerOperationsCapabilityOperationRoutes(container: RuntimeHostContainer): void {
  container.contribute('agentRuntime.capabilityOperationRoutes', (scope): readonly CapabilityOperationRoute[] => [
    ...createPluginRuntimeCapabilityOperationRoutes({
      pluginRuntimeService: scope.resolve<PluginRuntimeService>('plugins.runtimeService'),
    }),
    ...createCronSchedulerCapabilityOperationRoutes({
      cronService: scope.resolve<CronService>('cron.service'),
    }),
    ...createTaskControlCapabilityOperationRoutes({
      taskService: scope.resolve<TaskManagerService>('task.service'),
    }),
    ...createTeamRuntimeCapabilityOperationRoutes({
      teamRuntimeService: scope.resolve<TeamRuntimePort>('teamRuntime.service'),
    }),
    ...createToolInvokeCapabilityOperationRoutes({
      taskService: scope.resolve<TaskManagerService>('task.service'),
    }),
    ...createWorkspaceFileCapabilityOperationRoutes({
      fileService: scope.resolve<FileService>('file.service'),
    }),
    ...createSecurityRuntimeCapabilityOperationRoutes({
      securityService: scope.resolve<SecurityRuntimeService>('security.service'),
    }),
    ...createLicenseRuntimeCapabilityOperationRoutes({
      licenseService: scope.resolve<LicenseService>('license.service'),
    }),
    ...createPlatformRuntimeCapabilityOperationRoutes({
      platformService: scope.resolve<PlatformService>('platform.service'),
      toolchainUvService: scope.resolve<ToolchainUvService>('toolchainUv.service'),
    }),
  ]);
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
      type: DELETE_TEAM_MANAGED_AGENTS_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const teamId = typeof body.teamId === 'string' ? body.teamId : '';
        const endpoint = readJobPayloadRecord(body.endpoint) as RuntimeEndpointRef;
        const managedAgents = Array.isArray(body.managedAgents) ? body.managedAgents.map(readJobPayloadRecord) as RemoveTeamAgentsInput['managedAgents'] : [];
        if (!teamId) {
          throw new Error('teamId is required');
        }
        if (managedAgents.length === 0) {
          return { teamId, deletedAgentIds: [] };
        }
        if (!endpoint.kind) {
          throw new Error('endpoint is required');
        }
        await container.resolve<TeamAgentMaterializationPort>('teamRuntime.openclawMaterialization').removeTeamAgents({
          teamId,
          endpoint,
          managedAgents,
        } satisfies RemoveTeamAgentsInput);
        return { teamId, deletedAgentIds: managedAgents.filter((agent) => agent.lifecycle !== 'external').map((agent) => agent.agentId) };
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
        name: 'cron.jobs-refresh',
        start: () => {
          startCronJobsRefresh(container);
        },
      },
    ],
    cleanupTasks: [
      {
        name: 'team-runtime.worker',
        run: () => {
          closeTeamRuntimeWorker(container);
        },
      },
    ],
  });
}

function startCronJobsRefresh(container: RuntimeHostContainer): void {
  void container.resolve<CronService>('cron.service').listJobs();
}

function closeTeamRuntimeWorker(container: RuntimeHostContainer): void {
  void container.resolve<TeamRuntimePort>('teamRuntime.service').close?.();
}
