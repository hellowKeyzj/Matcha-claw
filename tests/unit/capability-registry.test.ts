import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { buildRuntimeEndpointCapabilityDescriptors } from '../../runtime-host/application/agent-runtime/contracts/runtime-capability-descriptors';
import type { RuntimeAddress } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { RuntimeEndpointProfile } from '../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';
import { OpenClawRuntimeAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { CapabilityRegistry } from '../../runtime-host/application/capabilities/contracts/capability-registry';
import { CapabilityRouter, type CapabilityOperationRoute } from '../../runtime-host/application/capabilities/contracts/capability-router';
import type { CapabilityDescriptor } from '../../runtime-host/application/capabilities/contracts/capability-descriptor';
import { createAgentRunCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/agent-run-capability';
import { createSubagentManagementCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/subagent-management-capability';
import { createSessionApprovalCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/approval/session-approval-capability';
import { createSessionModelSelectionCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/model/session-model-capability';
import { createModelProviderCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/model/model-provider-capability';
import { createChannelIntegrationCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/integration/channel-integration-capability';
import { createLicenseRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/license/license-runtime-capability';
import { createPlatformRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/platform/platform-runtime-capability';
import { createPluginRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/plugin/plugin-runtime-capability';
import { createRuntimeHostCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/runtime/runtime-host-capability';
import { createCronSchedulerCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/scheduler/cron-scheduler-capability';
import { createSecurityRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/security/security-runtime-capability';
import { createSettingsRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/settings/settings-runtime-capability';
import { createSessionManagementCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/session/session-management-capability';
import { createSessionPromptCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/session/session-prompt-capability';
import { createSkillManagementCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/skill/skill-management-capability';
import { createMultiAgentTaskCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/task/multi-agent-task-capability';
import { createTaskControlCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/task/task-control-capability';
import { createTeamCoordinationCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/team/team-coordination-capability';
import { createToolInvokeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/tool/tool-invoke-capability';
import { createWorkspaceFileCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/workspace/workspace-file-capability';

const nativeAddress: RuntimeAddress = {
  kind: 'native-runtime',
  capabilityId: 'session.prompt',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  agentId: 'default',
};

const connectorAddress: RuntimeAddress = {
  kind: 'protocol-connector',
  capabilityId: 'session.prompt',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
  agentId: 'default',
};

const endpoint: RuntimeEndpointProfile = {
  id: 'claude-code',
  protocolId: 'acp',
  connectorId: 'acp',
  displayName: 'Claude Code',
  agentIds: ['default'],
  capabilities: {
    chat: true,
    streaming: false,
    tools: false,
    approvals: false,
    replay: false,
    modelSelection: false,
  },
};

function createDescriptor(address: RuntimeAddress): CapabilityDescriptor {
  return {
    id: address.capabilityId,
    kind: 'session',
    address,
    ...(address.kind === 'native-runtime'
      ? {
        runtimeAdapterId: address.runtimeAdapterId,
        runtimeInstanceId: address.runtimeInstanceId,
      }
      : {
        protocolId: address.protocolId,
        connectorId: address.connectorId,
        endpointId: address.endpointId,
      }),
    targetAgentIds: [address.agentId],
    ...(address.modelProviderId ? { modelProviderId: address.modelProviderId } : {}),
    supportLevel: 'native',
    availability: 'available',
    operations: [{ id: 'sessions.prompt', title: 'Prompt session' }],
    policyScope: address.capabilityId,
    ownerModuleId: address.kind === 'native-runtime' ? address.runtimeAdapterId : address.connectorId,
    routeOwnerId: 'sessions',
  };
}

describe('capability registry', () => {
  it('rejects descriptors without policy and owner metadata', () => {
    const registry = new CapabilityRegistry();
    const descriptor = createDescriptor(nativeAddress);
    delete (descriptor as Partial<CapabilityDescriptor>).ownerModuleId;

    expect(() => registry.register(descriptor)).toThrow('Capability descriptor ownerModuleId is required');
  });

  it('every registered endpoint capability has policy and owner metadata', () => {
    const registry = new AgentRuntimeRegistry({
      gateway: () => ({
        chatSend: async () => ({ success: true }),
        gatewayRpc: async () => ({}),
      }),
    });
    registry.register({
      runtimeAdapters: [new OpenClawRuntimeAdapter()],
      protocolConnectors: [createTestAcpClientConnector()],
    });

    for (const capability of registry.listCapabilities()) {
      expect(capability.policyScope).toBeTruthy();
      expect(capability.ownerModuleId).toBeTruthy();
      expect(capability.routeOwnerId).toBeTruthy();
      expect(capability.operations.length).toBeGreaterThan(0);
    }
  });

  it('keeps OpenClaw capability ownership at capability-module granularity', () => {
    const registry = new AgentRuntimeRegistry({
      gateway: () => ({
        chatSend: async () => ({ success: true }),
        gatewayRpc: async () => ({}),
      }),
    });
    registry.register({ runtimeAdapters: [new OpenClawRuntimeAdapter()] });

    expect(registry.listCapabilities()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'integration.channel', ownerModuleId: 'integration', routeOwnerId: 'openclaw' }),
      expect.objectContaining({ id: 'model.provider', ownerModuleId: 'model', routeOwnerId: 'openclaw' }),
      expect.objectContaining({ id: 'scheduler.cron', ownerModuleId: 'scheduler', routeOwnerId: 'operations' }),
      expect.objectContaining({ id: 'workspace.file', ownerModuleId: 'workspace', routeOwnerId: 'operations' }),
      expect.objectContaining({ id: 'multi-agent.task', ownerModuleId: 'workflow', routeOwnerId: 'operations' }),
    ]));
  });

  it('every registered endpoint capability has a contributed operation executor', async () => {
    const registry = new AgentRuntimeRegistry({
      gateway: () => ({
        chatSend: async () => ({ success: true }),
        gatewayRpc: async () => ({}),
      }),
    });
    registry.register({
      runtimeAdapters: [new OpenClawRuntimeAdapter()],
      protocolConnectors: [createTestAcpClientConnector()],
    });
    const commandService = {
      createSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      listSessions: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      loadSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      abortSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      listPendingApprovals: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      resolveApproval: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      patchSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      getSessionWindow: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      deleteSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      renameSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      archiveSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      unarchiveSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      updateSessionStatus: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      switchSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      resumeSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      getSessionStateSnapshot: vi.fn(async () => ({ status: 200, data: { ok: true } })),
    };
    const promptService = {
      promptSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
    };
    const taskService = {
      invokeTool: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      output: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      stop: vi.fn(async () => ({ status: 200, data: { ok: true } })),
    };
    const cronService = {
      createJob: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      updateJob: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      deleteJob: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      toggleJob: vi.fn(() => ({ status: 200, data: { ok: true } })),
      trigger: vi.fn(() => ({ status: 200, data: { ok: true } })),
    };
    const channelService = {
      probe: vi.fn(() => ({ status: 200, data: { ok: true } })),
      activate: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      cancelSession: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      connect: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      disconnect: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      requestQr: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      approvePairingRequest: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      deleteConfig: vi.fn(() => ({ status: 200, data: { ok: true } })),
    };
    const pluginRuntimeService = {
      setEnabled: vi.fn(() => ({ status: 200, data: { ok: true } })),
    };
    const platformService = {
      startRun: vi.fn(async () => ({ success: true, runId: 'run-1' })),
      abortRun: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      installNativeTool: vi.fn(async () => ({ status: 202, data: { success: true, job: { id: 'job-1' } } })),
      reconcileTools: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
      upsertPlatformTools: vi.fn(async () => ({ success: true })),
      setToolEnabled: vi.fn(async () => ({ status: 200, data: { ok: true } })),
    };
    const toolchainUvService = {
      install: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
    };
    const providerAccountsService = {
      list: vi.fn(() => ({ statuses: [], credentials: [], vendors: [] })),
      get: vi.fn(() => null),
      getApiKey: vi.fn(() => ({ apiKey: null })),
      hasApiKey: vi.fn(() => ({ hasKey: false })),
      validate: vi.fn(() => ({ valid: true })),
      create: vi.fn(() => ({ status: 202, data: { success: true, job: { id: 'job-1' } } })),
      update: vi.fn(() => ({ status: 202, data: { success: true, job: { id: 'job-1' } } })),
      delete: vi.fn(() => ({ status: 202, data: { success: true, job: { id: 'job-1' } } })),
      startOAuth: vi.fn(async () => ({ status: 200, data: { success: true } })),
      cancelOAuth: vi.fn(async () => ({ status: 200, data: { success: true } })),
      submitOAuth: vi.fn(async () => ({ status: 200, data: { success: true } })),
      completeBrowser: vi.fn(async () => ({ status: 200, data: { success: true } })),
      completeDevice: vi.fn(async () => ({ status: 200, data: { success: true } })),
    };
    const providerModelsService = {
      readAll: vi.fn(async () => []),
      readSelectable: vi.fn(async () => ({ models: [] })),
      read: vi.fn(async () => ({ models: [] })),
      replace: vi.fn(async () => ({ status: 200, data: { success: true } })),
    };
    const capabilityRoutingService = {
      read: vi.fn(async () => ({})),
      write: vi.fn(async () => ({ status: 200, data: { success: true } })),
    };
    const securityService = {
      writePolicy: vi.fn(async () => ({ status: 202, data: { success: true, sync: { job: { id: 'job-1' } } } })),
      syncCurrentPolicyToGatewayIfRunning: vi.fn(() => ({ status: 202, data: { success: true, job: { id: 'job-1' } } })),
      runQuickAudit: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
      runEmergencyResponse: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
      checkIntegrity: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
      rebaselineIntegrity: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
      scanSkillsFromPayload: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
      checkAdvisories: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
      previewRemediation: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
      applyRemediationFromPayload: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
      rollbackRemediationFromPayload: vi.fn(() => ({ success: true, job: { id: 'job-1' } })),
    };
    const settingsService = {
      patch: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      reset: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      setValue: vi.fn(async () => ({ status: 200, data: { ok: true } })),
    };
    const licenseService = {
      validate: vi.fn(async () => ({ status: 200, data: { valid: true, code: 'valid' } })),
      revalidate: vi.fn(async () => ({ status: 200, data: { valid: true, code: 'valid' } })),
      clear: vi.fn(async () => ({ status: 200, data: { success: true } })),
    };
    const runtimeHostService = {
      prepareGatewayLaunch: vi.fn(async () => ({ status: 202, data: { success: true, job: { id: 'job-1' } } })),
      syncProviderAuthBootstrap: vi.fn(() => ({ status: 202, data: { success: true, job: { id: 'job-1' } } })),
      gatewayLifecycle: vi.fn(() => ({ status: 200, data: { success: true, job: { id: 'job-1' } } })),
      collectDiagnostics: vi.fn(async () => ({ status: 202, data: { success: true, job: { id: 'job-1' } } })),
    };
    const skillsService = {
      updateConfig: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      updateState: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      updateBatchState: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      refreshStatus: vi.fn(async () => ({ success: true, skills: [] })),
      importLocal: vi.fn(() => ({ status: 200, data: { ok: true } })),
      exportBundles: vi.fn(async () => []),
      importBundles: vi.fn(async () => ({ status: 200, data: { ok: true } })),
    };
    const subagentService = {
      setConfig: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      createAgent: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      updateAgent: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      deleteAgent: vi.fn(async () => ({ status: 200, data: { ok: true } })),
      setAgentFile: vi.fn(async () => ({ status: 200, data: { ok: true } })),
    };
    const clawHubService = {
      login: vi.fn(async () => ({ success: true })),
      openReadme: vi.fn(async () => ({ success: true })),
      openPath: vi.fn(async () => ({ success: true })),
      install: vi.fn(() => ({ success: true, job: { id: 'job-1', type: 'clawhub.install' } })),
      uninstall: vi.fn(() => ({ success: true, job: { id: 'job-1', type: 'clawhub.uninstall' } })),
    };
    const teamRuntimeService = {
      init: vi.fn(async () => ({ ok: true })),
      snapshot: vi.fn(async () => ({ ok: true })),
      planUpsert: vi.fn(async () => ({ ok: true })),
      claimNext: vi.fn(async () => ({ ok: true })),
      heartbeat: vi.fn(async () => ({ ok: true })),
      taskUpdate: vi.fn(async () => ({ ok: true })),
      mailboxPost: vi.fn(async () => ({ ok: true })),
      mailboxPull: vi.fn(async () => ({ ok: true })),
      releaseClaim: vi.fn(async () => ({ ok: true })),
      reset: vi.fn(async () => ({ ok: true })),
      listTasks: vi.fn(async () => ({ ok: true })),
    };
    const gatewayService = {
      gatewayRpc: vi.fn(async () => ({ ok: true })),
      chatSend: vi.fn(async () => ({ ok: true })),
    };
    const fileSystem = {
      exists: vi.fn(async () => false),
      readBinaryFile: vi.fn(async () => new Uint8Array()),
    };
    const fileService = {
      readText: vi.fn(async () => ({ ok: true, content: 'demo' })),
      readBinary: vi.fn(async () => ({ ok: true, data: 'ZGVtbw==' })),
      stat: vi.fn(async () => ({ ok: true, entry: { path: '/tmp/demo.txt', name: 'demo.txt', isDir: false, size: 4, mtimeMs: 0 } })),
      listDir: vi.fn(async () => ({ ok: true, entries: [] })),
      writeText: vi.fn(async () => ({ ok: true, path: '/tmp/export.json' })),
      stagePaths: vi.fn(async () => [{ id: 'file-1', fileName: 'demo.txt', mimeType: 'text/plain', fileSize: 4, stagedPath: '/tmp/demo.txt', preview: null }]),
      stageBuffer: vi.fn(async () => ({ id: 'file-1', fileName: 'demo.txt', mimeType: 'text/plain', fileSize: 4, stagedPath: '/tmp/demo.txt', preview: null })),
    };
    const routes: readonly CapabilityOperationRoute[] = [
      ...createSessionPromptCapabilityOperationRoutes({
        commandService: commandService as never,
        promptService: promptService as never,
        fileSystem: fileSystem as never,
        gateway: gatewayService as never,
      }),
      ...createSessionApprovalCapabilityOperationRoutes({ commandService: commandService as never }),
      ...createSessionManagementCapabilityOperationRoutes({ commandService: commandService as never }),
      ...createSessionModelSelectionCapabilityOperationRoutes({ commandService: commandService as never }),
      ...createChannelIntegrationCapabilityOperationRoutes({ channelService: channelService as never }),
      ...createPlatformRuntimeCapabilityOperationRoutes({
        platformService: platformService as never,
        toolchainUvService: toolchainUvService as never,
      }),
      ...createModelProviderCapabilityOperationRoutes({
        providerAccountsService: providerAccountsService as never,
        providerModelsService: providerModelsService as never,
        capabilityRoutingService: capabilityRoutingService as never,
      }),
      ...createPluginRuntimeCapabilityOperationRoutes({ pluginRuntimeService: pluginRuntimeService as never }),
      ...createCronSchedulerCapabilityOperationRoutes({ cronService: cronService as never }),
      ...createSecurityRuntimeCapabilityOperationRoutes({ securityService: securityService as never }),
      ...createSettingsRuntimeCapabilityOperationRoutes({ settingsService: settingsService as never }),
      ...createLicenseRuntimeCapabilityOperationRoutes({ licenseService: licenseService as never }),
      ...createRuntimeHostCapabilityOperationRoutes({ runtimeHostService: runtimeHostService as never }),
      ...createSkillManagementCapabilityOperationRoutes({
        skillsService: skillsService as never,
        clawHubService: clawHubService as never,
      }),
      ...createSubagentManagementCapabilityOperationRoutes({ subagentService: subagentService as never }),
      ...createTaskControlCapabilityOperationRoutes({ taskService: taskService as never }),
      ...createTeamCoordinationCapabilityOperationRoutes({ teamRuntimeService: teamRuntimeService as never }),
      ...createMultiAgentTaskCapabilityOperationRoutes({ multiAgentTaskWorkflow: { start: vi.fn(async () => ({ status: 200, data: { ok: true } })) } as never }),
      ...createToolInvokeCapabilityOperationRoutes({ taskService: taskService as never }),
      ...createWorkspaceFileCapabilityOperationRoutes({ fileService: fileService as never }),
      ...createAgentRunCapabilityOperationRoutes({ gateway: gatewayService as never }),
    ];
    const router = new CapabilityRouter({
      getCapability: (input) => registry.getCapability(input),
      operations: routes,
    });

    function createOperationInput(operationId: string): Record<string, unknown> {
      if (operationId === 'agent.wait') {
        return { runId: 'run-1' };
      }
      if (operationId === 'sessions.sendWithMedia') {
        return { sessionKey: 'agent:main:main', message: 'hello', idempotencyKey: 'idem-1' };
      }
      if (operationId === 'files.writeText') {
        return { path: '/tmp/export.json', content: '{}' };
      }
      if (operationId === 'files.stagePaths') {
        return { filePaths: ['/tmp/demo.txt'] };
      }
      if (operationId === 'files.stageBuffer') {
        return { base64: 'ZGVtbw==', fileName: 'demo.txt', mimeType: 'text/plain' };
      }
      if (operationId === 'plugins.setEnabled') {
        return { pluginIds: ['task-manager'] };
      }
      if (operationId.startsWith('platform.') || operationId.startsWith('toolchain.')) {
        return { req: { toolId: 'tool.echo', args: {} }, runId: 'run-1', source: { id: 'native.tool', command: 'tool' }, tools: [{ id: 'tool.echo', source: 'platform' }], toolId: 'tool.echo', enabled: true };
      }
      if (operationId.startsWith('providers.') || operationId === 'providerModels.replace' || operationId.startsWith('capabilityRouting.')) {
        return { accountId: 'openai-main', credentialId: 'openai-main', account: { id: 'openai-main', vendorId: 'openai' }, updates: { label: 'OpenAI' }, apiKey: 'sk-test', provider: 'openai', code: 'oauth-code', models: [{ modelId: 'gpt-5.4', capabilities: ['chat'] }], chat: { primary: { credentialId: 'openai-main', modelId: 'gpt-5.4' }, fallbacks: [] } };
      }
      if (operationId.startsWith('cron.')) {
        return { jobId: 'cron-1', updates: { name: 'daily' }, id: 'cron-1', name: 'daily', agentId: 'agent-1', message: 'hello', schedule: '0 9 * * *' };
      }
      if (operationId.startsWith('channels.')) {
        return { channelType: 'feishu', channelId: 'feishu-main', code: 'PAIR-1' };
      }
      if (operationId.startsWith('security.')) {
        return { preset: 'strict', scanPath: 'skills', feedUrl: 'https://example.test/feed.json', actions: ['action-1'], snapshotId: 'snapshot-1' };
      }
      if (operationId.startsWith('settings.')) {
        return { key: 'theme', value: 'dark', theme: 'dark' };
      }
      if (operationId.startsWith('license.')) {
        return { key: 'MATCHACLAW-ABCD-1234-EFGH-5678' };
      }
      if (operationId.startsWith('runtimeHost.') || operationId === 'diagnostics.collect') {
        return { gatewayToken: 'token-1', proxyEnabled: false, state: 'running' };
      }
      if (operationId.startsWith('skills.') || operationId.startsWith('clawhub.')) {
        return { skillKey: 'skill-1', skillKeys: ['skill-1'], enabled: true, sourcePath: '/tmp/skill', skillBundles: [{ skillKey: 'skill-1', files: [{ path: 'SKILL.md', content: '---\nname: Skill\ndescription: Skill\n---\n' }] }], slug: 'skill-1' };
      }
      if (operationId.startsWith('subagents.')) {
        return { raw: '{}', baseHash: 'hash-1', name: 'writer', workspace: '/tmp/writer', agentId: 'writer', content: 'rules' };
      }
      if (operationId === 'tasks.output' || operationId === 'tasks.stop') {
        return { taskId: 'task-1' };
      }
      if (operationId === 'multiAgentTask.start') {
        return {
          teamId: 'team-1',
          leadAgentId: 'lead-1',
          agents: [{ agentId: 'agent-1', sessionKey: 'session-1' }],
          tasks: [{ taskId: 'task-1', instruction: 'do task' }],
        };
      }
      if (operationId.startsWith('team.')) {
        return { teamId: 'team-1', leadAgentId: 'lead-1', tasks: [], agentId: 'agent-1', sessionKey: 'session-1', taskId: 'task-1', status: 'done', message: { msgId: 'msg-1', fromAgentId: 'agent-1', content: 'hello' } };
      }
      return {};
    }

    for (const capability of registry.listCapabilities()) {
      for (const operation of capability.operations) {
        const response = await router.execute({
          id: capability.id,
          operationId: operation.id,
          address: capability.address,
          input: {
            ...createOperationInput(operation.id),
            runtimeAddress: capability.address,
          },
        });
        expect([200, 202]).toContain(response.status);
      }
    }

    const approvalCapability = registry.listCapabilities().find((capability) => capability.id === 'session.approval');
    if (!approvalCapability) {
      throw new Error('Expected session.approval capability');
    }
    expect(commandService.listPendingApprovals).toHaveBeenCalledWith({
      runtimeAddress: approvalCapability.address,
    });
  });

  it('publishes native runtime capabilities without publishing unconnected connector capabilities', () => {
    const registry = new AgentRuntimeRegistry({
      gateway: () => ({
        chatSend: async () => ({ success: true }),
        gatewayRpc: async () => ({}),
      }),
    });
    registry.register({
      runtimeAdapters: [new OpenClawRuntimeAdapter()],
      protocolConnectors: [createTestAcpClientConnector()],
    });

    expect(registry.listCapabilities()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'session.management',
        kind: 'session-management',
        supportLevel: 'native',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        targetAgentIds: ['default'],
        address: expect.objectContaining({
          kind: 'native-runtime',
          capabilityId: 'session.management',
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'local',
          agentId: 'default',
        }),
      }),
      expect.objectContaining({
        id: 'session.prompt',
        kind: 'session',
        supportLevel: 'native',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        targetAgentIds: ['default'],
        address: expect.objectContaining({
          kind: 'native-runtime',
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'local',
          agentId: 'default',
        }),
      }),
    ]));
    expect(registry.listCapabilities().some((descriptor) => descriptor.address.kind === 'protocol-connector')).toBe(false);
    expect(() => registry.getCapability({
      id: 'session.prompt',
      address: {
        kind: 'protocol-connector',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'hermes',
        agentId: 'default',
      },
    })).toThrow('Connector runtime endpoint not registered: acp:acp:hermes');
  });

  it('registers descriptors built from explicit runtime endpoint addresses', () => {
    const registry = new CapabilityRegistry();
    const descriptors = buildRuntimeEndpointCapabilityDescriptors({
      endpoint,
      supportLevel: 'native',
      address: connectorAddress,
      ownerModuleId: 'acp',
      routeOwnerId: 'sessions',
    });

    registry.registerMany(descriptors);

    expect(registry.list()).toHaveLength(3);
    expect(registry.get({
      id: 'session.prompt',
      address: connectorAddress,
    })).toBe(descriptors.find((descriptor) => descriptor.id === 'session.prompt'));
    expect(registry.get({
      id: 'session.management',
      address: {
        ...connectorAddress,
        capabilityId: 'session.management',
      },
    })).toBe(descriptors.find((descriptor) => descriptor.id === 'session.management'));
  });

  it('rejects descriptors whose id does not match the RuntimeAddress capability', () => {
    const registry = new CapabilityRegistry();

    expect(() => registry.register({
      ...createDescriptor(nativeAddress),
      id: 'tool.invoke',
    })).toThrow('Capability descriptor id does not match RuntimeAddress capabilityId');
  });

  it('rejects descriptors whose target agents do not include the RuntimeAddress agent', () => {
    const registry = new CapabilityRegistry();

    expect(() => registry.register({
      ...createDescriptor(nativeAddress),
      targetAgentIds: ['reviewer'],
    })).toThrow('Capability descriptor targetAgentIds must include RuntimeAddress agentId');
  });

  it('rejects native runtime descriptors with connector fields', () => {
    const registry = new CapabilityRegistry();

    expect(() => registry.register({
      ...createDescriptor(nativeAddress),
      protocolId: 'acp',
    })).toThrow('Capability descriptor protocolId is not allowed for native-runtime');
    expect(() => registry.register({
      ...createDescriptor(nativeAddress),
      connectorId: 'acp',
    })).toThrow('Capability descriptor connectorId is not allowed for native-runtime');
    expect(() => registry.register({
      ...createDescriptor(nativeAddress),
      endpointId: 'claude-code',
    })).toThrow('Capability descriptor endpointId is not allowed for native-runtime');
  });

  it('rejects connector runtime descriptors with native fields', () => {
    const registry = new CapabilityRegistry();

    expect(() => registry.register({
      ...createDescriptor(connectorAddress),
      runtimeAdapterId: 'openclaw',
    })).toThrow('Capability descriptor runtimeAdapterId is not allowed for protocol-connector');
    expect(() => registry.register({
      ...createDescriptor(connectorAddress),
      runtimeInstanceId: 'local',
    })).toThrow('Capability descriptor runtimeInstanceId is not allowed for protocol-connector');
  });

  it('rejects descriptors whose runtime fields do not exactly match the RuntimeAddress', () => {
    const registry = new CapabilityRegistry();

    expect(() => registry.register({
      ...createDescriptor(nativeAddress),
      runtimeInstanceId: 'remote',
    })).toThrow('Capability descriptor runtimeInstanceId does not match RuntimeAddress');
    expect(() => registry.register({
      ...createDescriptor(connectorAddress),
      endpointId: 'hermes',
    })).toThrow('Capability descriptor endpointId does not match RuntimeAddress');
  });

  it('removes descriptors by runtime endpoint scope', () => {
    const registry = new CapabilityRegistry();
    const promptDescriptor = createDescriptor(connectorAddress);
    const managementDescriptor = createDescriptor({
      ...connectorAddress,
      capabilityId: 'session.management',
    });
    const otherEndpointDescriptor = createDescriptor({
      ...connectorAddress,
      endpointId: 'hermes',
    });

    registry.register(promptDescriptor);
    registry.register(managementDescriptor);
    registry.register(otherEndpointDescriptor);

    registry.removeForRuntimeEndpointScope(connectorAddress);

    expect(registry.list()).toEqual([otherEndpointDescriptor]);
  });

  it('indexes model-scoped descriptors by full RuntimeAddress', () => {
    const registry = new CapabilityRegistry();
    const anthropicDescriptor = createDescriptor({
      ...nativeAddress,
      modelProviderId: 'anthropic',
    });
    const openaiDescriptor = createDescriptor({
      ...nativeAddress,
      modelProviderId: 'openai',
    });

    registry.register(anthropicDescriptor);
    registry.register(openaiDescriptor);

    expect(registry.listByCapability('session.prompt')).toHaveLength(2);
    expect(registry.get({
      id: 'session.prompt',
      address: anthropicDescriptor.address,
    })).toBe(anthropicDescriptor);
    expect(registry.get({
      id: 'session.prompt',
      address: openaiDescriptor.address,
    })).toBe(openaiDescriptor);
  });

  it('rejects descriptors whose model provider does not exactly match the RuntimeAddress', () => {
    const registry = new CapabilityRegistry();
    const modelScopedAddress = {
      ...nativeAddress,
      modelProviderId: 'anthropic',
    };
    const { modelProviderId: _missingModelProviderId, ...missingModelProviderDescriptor } = createDescriptor(modelScopedAddress);

    expect(() => registry.register(missingModelProviderDescriptor)).toThrow('Capability descriptor modelProviderId does not match RuntimeAddress');
    expect(() => registry.register({
      ...createDescriptor(modelScopedAddress),
      modelProviderId: 'openai',
    })).toThrow('Capability descriptor modelProviderId does not match RuntimeAddress');
  });
});
