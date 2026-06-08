import { describe, expect, it, vi } from 'vitest';
import type { CapabilityOperationContext } from '../../runtime-host/application/capabilities/contracts/capability-router';
import { createLicenseRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/license/license-runtime-capability';
import { createRuntimeHostCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/runtime/runtime-host-capability';
import { createSecurityRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/security/security-runtime-capability';
import { createPluginRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/plugin/plugin-runtime-capability';
import { createPlatformRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/platform/platform-runtime-capability';
import { createTaskControlCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/task/task-control-capability';
import { createToolInvokeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/tool/tool-invoke-capability';
import { createCronSchedulerCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/scheduler/cron-scheduler-capability';
import { createChannelIntegrationCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/integration/channel-integration-capability';
import { createTeamRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/team/team-runtime-capability';
import { createOpenClawTestSessionIdentity, openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

const runtimeScope = {
  kind: 'runtime-instance' as const,
  endpoint: openClawTestRuntimeEndpoint,
};

function context(overrides: Partial<CapabilityOperationContext>): CapabilityOperationContext {
  const input = overrides.input ?? {};
  return {
    capabilityId: overrides.capabilityId ?? 'test.capability',
    operationId: overrides.operationId ?? 'test.operation',
    scope: overrides.scope ?? runtimeScope,
    target: overrides.target ?? null,
    input,
    domainInput: input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {},
  };
}

describe('non-provider capability target-input binding', () => {
  it('requires license.validate and license.clear to target license key subject', async () => {
    const licenseService = {
      validate: vi.fn(async () => ({ status: 200, data: { success: true } })),
      revalidate: vi.fn(async () => ({ status: 200, data: { success: true } })),
      clear: vi.fn(async () => ({ status: 200, data: { success: true } })),
    };
    const [validateRoute, revalidateRoute, clearRoute] = createLicenseRuntimeCapabilityOperationRoutes({ licenseService });

    expect(await validateRoute!.handle(context({
      capabilityId: 'license.runtime',
      operationId: 'license.validate',
      scope: { kind: 'app' },
      target: { kind: 'license', subject: 'gate' },
      input: { key: 'license-key' },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target subject must be key' },
    });

    expect(await clearRoute!.handle(context({
      capabilityId: 'license.runtime',
      operationId: 'license.clear',
      scope: { kind: 'app' },
      target: { kind: 'license', subject: 'gate' },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target subject must be key' },
    });
    expect(await revalidateRoute!.handle(context({
      capabilityId: 'license.runtime',
      operationId: 'license.revalidate',
      scope: { kind: 'app' },
      target: { kind: 'license', subject: 'gate' },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target subject must be key' },
    });

    expect(await validateRoute!.handle(context({
      capabilityId: 'license.runtime',
      operationId: 'license.validate',
      scope: { kind: 'app' },
      target: { kind: 'license', subject: 'key' },
      input: { key: 'license-key' },
    }))).toEqual({ status: 200, data: { success: true } });
    expect(await clearRoute!.handle(context({
      capabilityId: 'license.runtime',
      operationId: 'license.clear',
      scope: { kind: 'app' },
      target: { kind: 'license', subject: 'key' },
    }))).toEqual({ status: 200, data: { success: true } });
    expect(await revalidateRoute!.handle(context({
      capabilityId: 'license.runtime',
      operationId: 'license.revalidate',
      scope: { kind: 'app' },
      target: { kind: 'license', subject: 'key' },
    }))).toEqual({ status: 200, data: { success: true } });
    expect(licenseService.validate).toHaveBeenCalledTimes(1);
    expect(licenseService.revalidate).toHaveBeenCalledTimes(1);
    expect(licenseService.clear).toHaveBeenCalledTimes(1);
  });

  it('binds security remediation ids between target and input', async () => {
    const securityService = {
      writePolicy: vi.fn(),
      syncCurrentPolicyToGatewayIfRunning: vi.fn(),
      runQuickAudit: vi.fn(),
      runEmergencyResponse: vi.fn(),
      checkIntegrity: vi.fn(),
      rebaselineIntegrity: vi.fn(),
      scanSkillsFromPayload: vi.fn(),
      checkAdvisories: vi.fn(),
      previewRemediation: vi.fn(),
      applyRemediationFromPayload: vi.fn(() => ({ job: { id: 'apply-1' } })),
      rollbackRemediationFromPayload: vi.fn(() => ({ job: { id: 'rollback-1' } })),
    };
    const routes = createSecurityRuntimeCapabilityOperationRoutes({ securityService });
    const applyRoute = routes.find((route) => route.operationId === 'security.applyRemediation')!;
    const rollbackRoute = routes.find((route) => route.operationId === 'security.rollbackRemediation')!;

    expect(await applyRoute.handle(context({
      capabilityId: 'security.runtime',
      operationId: 'security.applyRemediation',
      target: { kind: 'security-remediation', remediationId: 'remediation-1' },
      input: { remediationId: 'remediation-2', actions: ['fix'] },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target remediationId must match input remediationId' },
    });
    expect(await applyRoute.handle(context({
      capabilityId: 'security.runtime',
      operationId: 'security.applyRemediation',
      target: { kind: 'security-remediation' },
      input: { actions: ['fix'] },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target remediationId and input remediationId are required' },
    });

    expect(await rollbackRoute.handle(context({
      capabilityId: 'security.runtime',
      operationId: 'security.rollbackRemediation',
      target: { kind: 'security-remediation', snapshotId: 'snapshot-1' },
      input: { snapshotId: 'snapshot-2' },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target snapshotId must match input snapshotId' },
    });
    expect(await rollbackRoute.handle(context({
      capabilityId: 'security.runtime',
      operationId: 'security.rollbackRemediation',
      target: { kind: 'security-remediation' },
      input: {},
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target snapshotId and input snapshotId are required' },
    });

    expect(await applyRoute.handle(context({
      capabilityId: 'security.runtime',
      operationId: 'security.applyRemediation',
      target: { kind: 'security-remediation', remediationId: 'remediation-1' },
      input: { remediationId: 'remediation-1', actions: ['fix'] },
    }))).toEqual({ status: 202, data: { job: { id: 'apply-1' } } });
    expect(await rollbackRoute.handle(context({
      capabilityId: 'security.runtime',
      operationId: 'security.rollbackRemediation',
      target: { kind: 'security-remediation', snapshotId: 'snapshot-1' },
      input: { snapshotId: 'snapshot-1' },
    }))).toEqual({ status: 202, data: { job: { id: 'rollback-1' } } });
    expect(securityService.applyRemediationFromPayload).toHaveBeenCalledTimes(1);
    expect(securityService.rollbackRemediationFromPayload).toHaveBeenCalledTimes(1);
  });

  it('rejects single-plugin target when plugin input mutates a different set', async () => {
    const pluginRuntimeService = {
      setEnabled: vi.fn(() => ({ status: 202, data: { job: { id: 'plugin-1' } } })),
    };
    const [route] = createPluginRuntimeCapabilityOperationRoutes({ pluginRuntimeService });

    expect(await route!.handle(context({
      capabilityId: 'plugin.runtime',
      operationId: 'plugins.setEnabled',
      target: { kind: 'plugin', pluginId: 'task-manager' },
      input: { pluginIds: ['task-manager', 'security-core'] },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target pluginId must match the single input pluginId' },
    });
    expect(await route!.handle(context({
      capabilityId: 'plugin.runtime',
      operationId: 'plugins.setEnabled',
      target: { kind: 'plugin' },
      input: { pluginIds: ['task-manager'] },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target pluginId is required' },
    });

    expect(await route!.handle(context({
      capabilityId: 'plugin.runtime',
      operationId: 'plugins.setEnabled',
      target: { kind: 'plugin', pluginId: 'task-manager' },
      input: { pluginIds: ['task-manager'] },
    }))).toEqual({ status: 202, data: { job: { id: 'plugin-1' } } });
    expect(pluginRuntimeService.setEnabled).toHaveBeenCalledTimes(1);
  });

  it('binds cron mutation targets to input job ids', async () => {
    const cronService = {
      createJob: vi.fn(),
      updateJob: vi.fn(() => ({ status: 202, data: { job: { id: 'cron-update' } } })),
      deleteJob: vi.fn(() => ({ status: 202, data: { job: { id: 'cron-delete' } } })),
      toggleJob: vi.fn(() => ({ status: 202, data: { job: { id: 'cron-toggle' } } })),
      trigger: vi.fn(() => ({ status: 202, data: { job: { id: 'cron-trigger' } } })),
    };
    const routes = createCronSchedulerCapabilityOperationRoutes({ cronService });
    const cases = [
      { operationId: 'cron.update', target: { kind: 'cron-job' as const, jobId: 'job-1' }, input: { jobId: 'job-2', updates: {} }, error: 'Capability target jobId must match input jobId' },
      { operationId: 'cron.delete', target: { kind: 'cron-job' as const, jobId: 'job-1' }, input: { jobId: 'job-2' }, error: 'Capability target jobId must match input jobId' },
      { operationId: 'cron.toggle', target: { kind: 'cron-job' as const, jobId: 'job-1' }, input: { id: 'job-2', enabled: true }, error: 'Capability target jobId must match input id' },
      { operationId: 'cron.trigger', target: { kind: 'cron-job' as const, jobId: 'job-1' }, input: { id: 'job-2' }, error: 'Capability target jobId must match input id' },
    ];

    for (const item of cases) {
      const route = routes.find((candidate) => candidate.operationId === item.operationId)!;
      expect(await route.handle(context({
        capabilityId: 'scheduler.cron',
        operationId: item.operationId,
        target: item.target,
        input: item.input,
      }))).toEqual({
        status: 400,
        data: { success: false, error: item.error },
      });
    }

    expect(cronService.updateJob).not.toHaveBeenCalled();
    expect(cronService.deleteJob).not.toHaveBeenCalled();
    expect(cronService.toggleJob).not.toHaveBeenCalled();
    expect(cronService.trigger).not.toHaveBeenCalled();
  });

  it('binds platform.abortRun target jobId to input runId', async () => {
    const platformService = {
      startRun: vi.fn(),
      abortRun: vi.fn(async () => ({ status: 200, data: { success: true } })),
      installNativeTool: vi.fn(),
      reconcileTools: vi.fn(),
      upsertPlatformTools: vi.fn(),
      setToolEnabled: vi.fn(),
    };
    const routes = createPlatformRuntimeCapabilityOperationRoutes({
      platformService,
      toolchainUvService: { install: vi.fn() },
    });
    const abortRoute = routes.find((route) => route.operationId === 'platform.abortRun')!;
    const installRoute = routes.find((route) => route.operationId === 'platform.installNativeTool')!;

    expect(await abortRoute.handle(context({
      capabilityId: 'platform.runtime',
      operationId: 'platform.abortRun',
      target: { kind: 'runtime-job', jobId: 'run-1' },
      input: { runId: 'run-2' },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target jobId must match input runId' },
    });

    expect(await abortRoute.handle(context({
      capabilityId: 'platform.runtime',
      operationId: 'platform.abortRun',
      target: { kind: 'runtime-job', jobId: 'run-1' },
      input: { runId: 'run-1' },
    }))).toEqual({ status: 200, data: { success: true } });
    expect(await installRoute.handle(context({
      capabilityId: 'platform.runtime',
      operationId: 'platform.installNativeTool',
      target: { kind: 'tool', toolName: 'tool-a' },
      input: { source: { spec: 'tool-b' } },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target toolName must match input tool id/source spec' },
    });
    expect(platformService.abortRun).toHaveBeenCalledTimes(1);
    expect(platformService.installNativeTool).not.toHaveBeenCalled();
  });

  it('binds team runtime target fields to input for high-risk operations', async () => {
    const teamSkillService = { invoke: vi.fn(() => ({ status: 200, data: { success: true } })) };
    const routes = createTeamRuntimeCapabilityOperationRoutes({ teamSkillService: teamSkillService as never });
    const cases = [
      { operationId: 'team.runCreate', target: { kind: 'team' as const, packagePath: '/pkg-1' }, input: { packagePath: '/pkg-2', idempotencyKey: 'create-1' }, error: 'Team runtime target packagePath must match input packagePath' },
      { operationId: 'team.stageComplete', target: { kind: 'team-stage' as const, runId: 'run-1', stageId: 'stage-1' }, input: { runId: 'run-1', stageId: 'stage-2' }, error: 'Team runtime target stageId must match input stageId' },
      { operationId: 'team.dispatchExecute', target: { kind: 'team-dispatch' as const, runId: 'run-1', dispatchId: 'dispatch-1' }, input: { runId: 'run-1', dispatchId: 'dispatch-2' }, error: 'Team runtime target dispatchId must match input dispatchId' },
      { operationId: 'team.approvalResolve', target: { kind: 'team-approval' as const, runId: 'run-1', approvalId: 'approval-1' }, input: { runId: 'run-1', approvalId: 'approval-2', decision: 'approve' }, error: 'Team runtime target approvalId must match input approvalId' },
      { operationId: 'team.gateEvaluate', target: { kind: 'team-run' as const, runId: 'run-1' }, input: { runId: 'run-1' }, error: 'Team runtime input gateType is required' },
    ];

    for (const item of cases) {
      const route = routes.find((candidate) => candidate.operationId === item.operationId)!;
      expect(await route.handle(context({
        capabilityId: 'team.runtime',
        operationId: item.operationId,
        target: item.target,
        input: item.input,
      }))).toEqual({
        status: 400,
        data: { success: false, error: item.error },
      });
    }
    expect(teamSkillService.invoke).not.toHaveBeenCalled();
  });

  it('binds task target taskId and owner to input', async () => {
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');
    const otherIdentity = createOpenClawTestSessionIdentity('agent:other:main');
    const taskService = {
      output: vi.fn(async () => ({ status: 200, data: { success: true, task: { id: 'job-1' } } })),
      stop: vi.fn(async () => ({ status: 200, data: { success: true } })),
    };
    const [outputRoute, stopRoute] = createTaskControlCapabilityOperationRoutes({ taskService });

    expect(await outputRoute!.handle(context({
      capabilityId: 'task.control',
      operationId: 'tasks.output',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'task', taskId: 'job-1', owner: { kind: 'session', identity: sessionIdentity } },
      input: { sessionIdentity, taskId: 'job-2' },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target taskId must match input taskId' },
    });

    expect(await stopRoute!.handle(context({
      capabilityId: 'task.control',
      operationId: 'tasks.stop',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'task', taskId: 'job-1', owner: { kind: 'session', identity: otherIdentity } },
      input: { sessionIdentity, taskId: 'job-1' },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target owner must match input owner' },
    });
    expect(await outputRoute!.handle(context({
      capabilityId: 'task.control',
      operationId: 'tasks.output',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'task', taskId: 'job-1' },
      input: { sessionIdentity, taskId: 'job-1' },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target owner is required' },
    });

    expect(await outputRoute!.handle(context({
      capabilityId: 'task.control',
      operationId: 'tasks.output',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'task', taskId: 'job-1', owner: { kind: 'session', identity: sessionIdentity } },
      input: { sessionIdentity, taskId: 'job-1' },
    }))).toEqual({ status: 200, data: { success: true, task: { id: 'job-1' } } });
    expect(taskService.output).toHaveBeenCalledTimes(1);
    expect(taskService.stop).not.toHaveBeenCalled();
  });

  it('binds runtimeHost.jobGet target jobId to input jobId before service call', async () => {
    const runtimeHostService = {
      prepareGatewayLaunch: vi.fn(),
      syncProviderAuthBootstrap: vi.fn(),
      gatewayLifecycle: vi.fn(),
      collectDiagnostics: vi.fn(),
      runtimeJob: vi.fn(() => ({ status: 200, data: { success: true, job: { id: 'job-1' } } })),
    };
    const gatewayService = {
      ready: vi.fn(),
      approvePendingControlUiPairingRequests: vi.fn(),
    };
    const route = createRuntimeHostCapabilityOperationRoutes({ runtimeHostService, gatewayService })
      .find((candidate) => candidate.operationId === 'runtimeHost.jobGet')!;

    expect(await route.handle(context({
      capabilityId: 'runtime.host',
      operationId: 'runtimeHost.jobGet',
      target: { kind: 'runtime-job', jobId: 'job-1' },
      input: { jobId: 'job-2' },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target jobId must match input jobId' },
    });
    expect(await route.handle(context({
      capabilityId: 'runtime.host',
      operationId: 'runtimeHost.jobGet',
      target: { kind: 'runtime-job' },
      input: { jobId: 'job-1' },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target jobId and input jobId are required' },
    });

    expect(await route.handle(context({
      capabilityId: 'runtime.host',
      operationId: 'runtimeHost.jobGet',
      target: { kind: 'runtime-job', jobId: 'job-1' },
      input: { jobId: 'job-1' },
    }))).toEqual({ status: 200, data: { success: true, job: { id: 'job-1' } } });
    expect(runtimeHostService.runtimeJob).toHaveBeenCalledTimes(1);
    expect(runtimeHostService.runtimeJob).toHaveBeenCalledWith({ jobId: 'job-1' });
  });

  it('binds tool.invoke target toolName and identity to input and session scope', async () => {
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');
    const otherIdentity = createOpenClawTestSessionIdentity('agent:other:main');
    const taskService = {
      invokeTool: vi.fn(async () => ({ status: 200, data: { success: true } })),
    };
    const [route] = createToolInvokeCapabilityOperationRoutes({ taskService: taskService as never });

    expect(await route!.handle(context({
      capabilityId: 'tool.invoke',
      operationId: 'tools.invoke',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'tool', toolName: 'TaskGet', identity: sessionIdentity },
      input: { method: 'TaskList', sessionIdentity },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target toolName must match input method' },
    });
    expect(await route!.handle(context({
      capabilityId: 'tool.invoke',
      operationId: 'tools.invoke',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'tool', toolName: 'TaskList', identity: otherIdentity },
      input: { method: 'TaskList', sessionIdentity: otherIdentity },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target identity must match request scope' },
    });
    expect(await route!.handle(context({
      capabilityId: 'tool.invoke',
      operationId: 'tools.invoke',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'tool', toolName: 'TaskList', identity: sessionIdentity },
      input: { method: 'TaskList', sessionIdentity: otherIdentity },
    }))).toEqual({
      status: 400,
      data: { success: false, error: 'Capability target identity must match input sessionIdentity' },
    });

    expect(await route!.handle(context({
      capabilityId: 'tool.invoke',
      operationId: 'tools.invoke',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'tool', toolName: 'TaskList', identity: sessionIdentity },
      input: { method: 'TaskList', sessionIdentity },
    }))).toEqual({ status: 200, data: { success: true } });
    expect(taskService.invokeTool).toHaveBeenCalledTimes(1);
  });

  it('binds channel operation target fields to input before service calls', async () => {
    const channelService = {
      probe: vi.fn(() => ({ status: 202, data: { success: true } })),
      activate: vi.fn(() => ({ status: 200, data: { success: true } })),
      cancelSession: vi.fn(() => ({ status: 200, data: { success: true } })),
      connect: vi.fn(() => ({ status: 200, data: { success: true } })),
      disconnect: vi.fn(() => ({ status: 200, data: { success: true } })),
      requestQr: vi.fn(() => ({ status: 200, data: { success: true } })),
      approvePairingRequest: vi.fn(() => ({ status: 200, data: { success: true } })),
      deleteConfig: vi.fn(() => ({ status: 202, data: { success: true } })),
    };
    const routes = createChannelIntegrationCapabilityOperationRoutes({ channelService });

    const cases = [
      { operationId: 'channels.activate', target: { kind: 'channel' as const, channelType: 'wecom' }, input: { channelType: 'feishu' }, error: 'Capability target channelType must match input channelType' },
      { operationId: 'channels.connect', target: { kind: 'channel' as const, channelType: 'wecom', accountId: 'main' }, input: { channelType: 'wecom', accountId: 'other' }, error: 'Capability target accountId must match input accountId' },
      { operationId: 'channels.disconnect', target: { kind: 'channel' as const, channelType: 'wecom' }, input: { channelType: 'wecom', accountId: 'main' }, error: 'Capability target accountId must match input accountId' },
      { operationId: 'channels.cancelSession', target: { kind: 'channel-pairing' as const, channelType: 'whatsapp', accountId: 'main' }, input: { channelType: 'whatsapp' }, error: 'Capability target accountId must match input accountId' },
      { operationId: 'channels.requestQr', target: { kind: 'channel-pairing' as const, channelType: 'whatsapp' }, input: { channelType: 'openclaw-weixin' }, error: 'Capability target channelType must match input channelType' },
      { operationId: 'channels.approvePairing', target: { kind: 'channel-pairing' as const, channelType: 'feishu', accountId: 'main', pairingId: 'code-1' }, input: { channelType: 'feishu', accountId: 'main', code: 'code-2' }, error: 'Capability target pairingId must match input code' },
      { operationId: 'channels.deleteConfig', target: { kind: 'channel' as const, channelType: 'wecom' }, input: { channelType: 'feishu' }, error: 'Capability target channelType must match input channelType' },
    ];

    for (const item of cases) {
      const route = routes.find((candidate) => candidate.operationId === item.operationId)!;
      expect(await route.handle(context({
        capabilityId: 'integration.channel',
        operationId: item.operationId,
        target: item.target,
        input: item.input,
      }))).toEqual({
        status: 400,
        data: { success: false, error: item.error },
      });
    }

    const approveRoute = routes.find((candidate) => candidate.operationId === 'channels.approvePairing')!;
    expect(await approveRoute.handle(context({
      capabilityId: 'integration.channel',
      operationId: 'channels.approvePairing',
      target: { kind: 'channel-pairing', channelType: 'feishu', accountId: 'main', pairingId: 'code-1' },
      input: { channelType: 'feishu', accountId: 'main', code: 'code-1' },
    }))).toEqual({ status: 200, data: { success: true } });
    expect(channelService.approvePairingRequest).toHaveBeenCalledWith('feishu', {
      channelType: 'feishu',
      accountId: 'main',
      code: 'code-1',
    });
    expect(channelService.activate).not.toHaveBeenCalled();
    expect(channelService.connect).not.toHaveBeenCalled();
    expect(channelService.disconnect).not.toHaveBeenCalled();
    expect(channelService.cancelSession).not.toHaveBeenCalled();
    expect(channelService.requestQr).not.toHaveBeenCalled();
    expect(channelService.deleteConfig).not.toHaveBeenCalled();
  });
});
