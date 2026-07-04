import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { buildRuntimeEndpointCapabilityDescriptors } from '../../runtime-host/application/agent-runtime/contracts/runtime-capability-descriptors';
import {
  runtimeInstanceScope,
  type CapabilityTarget,
  type RuntimeEndpointRef,
  type RuntimeScope,
  type SessionIdentity,
} from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { RuntimeEndpointProfile } from '../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';
import { OpenClawRuntimeAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { CapabilityRegistry } from '../../runtime-host/application/capabilities/contracts/capability-registry';
import type { CapabilityOperationRoute } from '../../runtime-host/application/capabilities/contracts/capability-router';
import type { CapabilityDescriptor, CapabilityOperationDescriptor } from '../../runtime-host/application/capabilities/contracts/capability-descriptor';
import { createAgentRunCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/agent-run-capability';
import { createAgentSkillConfigCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/agent-skill-config-capability';
import { createAgentToolConfigCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/agent-tool-config-capability';
import { createSubagentManagementCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/subagent-management-capability';
import { createSessionApprovalCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/approval/session-approval-capability';
import { createSessionModelSelectionCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/model/session-model-capability';
import { createModelProviderCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/model/model-provider-capability';
import { createChannelIntegrationCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/integration/channel-integration-capability';
import { createExternalConnectorCapabilityOperationRoutes } from '../../runtime-host/application/external-connectors/external-connector-capability';
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
import { createTaskControlCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/task/task-control-capability';
import { createTeamRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/team/team-runtime-capability';
import { createToolInvokeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/tool/tool-invoke-capability';
import { createWorkspaceFileCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/workspace/workspace-file-capability';

const nativeEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

const connectorEndpoint: RuntimeEndpointRef = {
  kind: 'protocol-connector',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
};

const hermesEndpoint: RuntimeEndpointRef = {
  ...connectorEndpoint,
  endpointId: 'hermes',
};

const nativeAgentScope: RuntimeScope = {
  kind: 'agent',
  endpoint: nativeEndpoint,
  agentId: 'default',
};

const connectorAgentScope: RuntimeScope = {
  kind: 'agent',
  endpoint: connectorEndpoint,
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

function operations(targetKind: CapabilityOperationDescriptor['targetKind'] = 'session'): CapabilityOperationDescriptor[] {
  return [{ id: 'sessions.prompt', title: 'Prompt session', targetKind }];
}

function endpointMetadata(scope: RuntimeScope): Partial<CapabilityDescriptor> {
  const endpointRef = 'endpoint' in scope ? scope.endpoint : scope.kind === 'session' ? scope.identity.endpoint : null;
  if (!endpointRef) {
    return {};
  }
  return endpointRef.kind === 'native-runtime'
    ? {
      runtimeAdapterId: endpointRef.runtimeAdapterId,
      runtimeInstanceId: endpointRef.runtimeInstanceId,
    }
    : {
      protocolId: endpointRef.protocolId,
      connectorId: endpointRef.connectorId,
      endpointId: endpointRef.endpointId,
    };
}

function createDescriptor(scope: RuntimeScope, id = 'session.prompt'): CapabilityDescriptor {
  const descriptorOperations = operations();
  return {
    id,
    kind: 'session',
    scopeKind: scope.kind,
    scope,
    targetKinds: Array.from(new Set(descriptorOperations.map((operation) => operation.targetKind))),
    ...endpointMetadata(scope),
    targetAgentIds: scope.kind === 'agent' ? [scope.agentId] : undefined,
    supportLevel: 'native',
    availability: 'available',
    operations: descriptorOperations,
    policyScope: id,
    ownerModuleId: 'owner',
    routeOwnerId: 'sessions',
  };
}

function createModelProviderRouteHarness() {
  const providerAccountsService = {
    list: vi.fn(async () => ({})),
    get: vi.fn(async () => ({})),
    getApiKey: vi.fn(async () => ({})),
    hasApiKey: vi.fn(async () => ({})),
    validate: vi.fn(async () => ({})),
    create: vi.fn(() => ({ status: 202, data: {} })),
    update: vi.fn(() => ({ status: 202, data: {} })),
    delete: vi.fn(() => ({ status: 202, data: {} })),
    startOAuth: vi.fn(() => ({ status: 200, data: {} })),
    cancelOAuth: vi.fn(() => ({ status: 200, data: {} })),
    submitOAuth: vi.fn(() => ({ status: 200, data: {} })),
    completeBrowser: vi.fn(() => ({ status: 200, data: {} })),
    completeDevice: vi.fn(() => ({ status: 200, data: {} })),
  };
  const providerModelsService = {
    readAll: vi.fn(async () => ({})),
    readSelectable: vi.fn(async () => ({})),
    read: vi.fn(async () => ({})),
    replace: vi.fn(() => ({ status: 200, data: {} })),
  };
  const capabilityRoutingService = {
    read: vi.fn(async () => ({})),
    write: vi.fn(() => ({ status: 200, data: {} })),
  };
  return {
    routes: createModelProviderCapabilityOperationRoutes({
      providerAccountsService,
      providerModelsService,
      capabilityRoutingService,
    }),
    services: {
      providerAccountsService,
      providerModelsService,
      capabilityRoutingService,
    },
  };
}

function route(routes: readonly CapabilityOperationRoute[], operationId: string): CapabilityOperationRoute {
  const found = routes.find((candidate) => candidate.operationId === operationId);
  if (!found) throw new Error(`Missing route: ${operationId}`);
  return found;
}

function context(target: any, domainInput: Record<string, unknown>) {
  return {
    capabilityId: 'model.provider',
    operationId: '',
    scope: nativeAgentScope,
    target,
    input: domainInput,
    domainInput,
  };
}

const sessionIdentity: SessionIdentity = {
  endpoint: nativeEndpoint,
  agentId: 'default',
  sessionKey: 'agent:default:main',
};

const otherSessionIdentity: SessionIdentity = {
  ...sessionIdentity,
  sessionKey: 'agent:default:other',
};

const sessionTarget: CapabilityTarget = {
  kind: 'session',
  identity: sessionIdentity,
};

const approvalTarget: CapabilityTarget = {
  kind: 'approval',
  identity: sessionIdentity,
  approvalId: 'approval-target',
};

function createSessionCapabilityRouteHarness() {
  const commandService = {
    loadSession: vi.fn(async () => ({ status: 200, data: {} })),
    abortSession: vi.fn(async () => ({ status: 200, data: {} })),
    deleteSession: vi.fn(async () => ({ status: 200, data: {} })),
    renameSession: vi.fn(async () => ({ status: 200, data: {} })),
    listPendingApprovals: vi.fn(async () => ({ status: 200, data: {} })),
    resolveApproval: vi.fn(async () => ({ status: 200, data: {} })),
  };
  const promptService = {
    promptSession: vi.fn(async () => ({ status: 200, data: {} })),
  };
  return {
    routes: [
      ...createSessionPromptCapabilityOperationRoutes({
        commandService: commandService as never,
        promptService: promptService as never,
      }),
      ...createSessionApprovalCapabilityOperationRoutes({ commandService: commandService as never }),
      ...createSessionManagementCapabilityOperationRoutes({ commandService: commandService as never }),
    ],
    services: {
      commandService,
      promptService,
    },
  };
}

function createOperationRoutes(): readonly CapabilityOperationRoute[] {
  const empty = {} as never;
  return [
    ...createSessionPromptCapabilityOperationRoutes({
      commandService: empty,
      promptService: empty,
      fileSystem: empty,
      gateway: empty,
    }),
    ...createSessionApprovalCapabilityOperationRoutes({ commandService: empty }),
    ...createSessionManagementCapabilityOperationRoutes({ commandService: empty }),
    ...createSessionModelSelectionCapabilityOperationRoutes({ commandService: empty }),
    ...createChannelIntegrationCapabilityOperationRoutes({ channelService: empty }),
    ...createExternalConnectorCapabilityOperationRoutes({ externalConnectorService: empty }),
    ...createPlatformRuntimeCapabilityOperationRoutes({
      platformService: empty,
      toolchainUvService: empty,
    }),
    ...createModelProviderCapabilityOperationRoutes({
      providerAccountsService: empty,
      providerModelsService: empty,
      capabilityRoutingService: empty,
    }),
    ...createPluginRuntimeCapabilityOperationRoutes({ pluginRuntimeService: empty }),
    ...createCronSchedulerCapabilityOperationRoutes({ cronService: empty }),
    ...createSecurityRuntimeCapabilityOperationRoutes({ securityService: empty }),
    ...createSettingsRuntimeCapabilityOperationRoutes({ settingsService: empty }),
    ...createLicenseRuntimeCapabilityOperationRoutes({ licenseService: empty }),
    ...createRuntimeHostCapabilityOperationRoutes({ runtimeHostService: empty, gatewayService: empty }),
    ...createSkillManagementCapabilityOperationRoutes({
      skillsService: empty,
      clawHubService: empty,
    }),
    ...createSubagentManagementCapabilityOperationRoutes({ subagentService: empty }),
    ...createAgentSkillConfigCapabilityOperationRoutes({ agentSkillConfigService: empty }),
    ...createAgentToolConfigCapabilityOperationRoutes({ agentToolConfigService: empty }),
    ...createTaskControlCapabilityOperationRoutes({ taskService: empty }),
    ...createTeamRuntimeCapabilityOperationRoutes({ teamSkillService: empty }),
    ...createToolInvokeCapabilityOperationRoutes({ taskService: empty }),
    ...createWorkspaceFileCapabilityOperationRoutes({ fileService: empty }),
    ...createAgentRunCapabilityOperationRoutes({ gateway: empty }),
  ];
}

describe('capability registry', () => {
  it('rejects descriptors without policy and owner metadata', () => {
    const registry = new CapabilityRegistry();
    const descriptor = createDescriptor(nativeAgentScope);
    delete (descriptor as Partial<CapabilityDescriptor>).ownerModuleId;

    expect(() => registry.register(descriptor)).toThrow('Capability descriptor ownerModuleId is required');
  });

  it('rejects descriptors whose scopeKind does not match the scope', () => {
    const registry = new CapabilityRegistry();

    expect(() => registry.register({
      ...createDescriptor(nativeAgentScope),
      scopeKind: 'session',
    })).toThrow('Capability descriptor scopeKind does not match scope kind');
  });

  it('rejects descriptors that declare operations outside targetKinds', () => {
    const registry = new CapabilityRegistry();

    expect(() => registry.register({
      ...createDescriptor(nativeAgentScope),
      targetKinds: ['agent'],
    })).toThrow('Capability operation targetKind is not declared: sessions.prompt');
  });

  it('every registered endpoint capability has policy, owner, scope and target metadata', () => {
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
      expect(capability.scopeKind).toBe(capability.scope.kind);
      expect(capability.targetKinds.length).toBeGreaterThan(0);
      expect(capability.operations.length).toBeGreaterThan(0);
      for (const operation of capability.operations) {
        expect(capability.targetKinds).toContain(operation.targetKind);
      }
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
      expect.objectContaining({ id: 'integration.channel', scopeKind: 'runtime-instance', ownerModuleId: 'integration', routeOwnerId: 'openclaw' }),
      expect.objectContaining({ id: 'model.provider', scopeKind: 'runtime-instance', ownerModuleId: 'model', routeOwnerId: 'openclaw' }),
      expect.objectContaining({ id: 'settings.runtime', scopeKind: 'app', ownerModuleId: 'settings', routeOwnerId: 'openclaw' }),
      expect.objectContaining({ id: 'agent.skill-config', scopeKind: 'agent', ownerModuleId: 'agent', routeOwnerId: 'openclaw' }),
      expect.objectContaining({ id: 'agent.tool-config', scopeKind: 'agent', ownerModuleId: 'agent', routeOwnerId: 'openclaw' }),
      expect.objectContaining({ id: 'license.runtime', scopeKind: 'app', ownerModuleId: 'license', routeOwnerId: 'operations' }),
      expect.objectContaining({ id: 'scheduler.cron', scopeKind: 'runtime-instance', ownerModuleId: 'scheduler', routeOwnerId: 'operations' }),
      expect.objectContaining({ id: 'workspace.file', scopeKind: 'workspace', ownerModuleId: 'workspace', routeOwnerId: 'operations' }),
    ]));
  });

  it('every registered endpoint capability has a contributed operation executor', () => {
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
    const routeKeys = new Set(createOperationRoutes().map((route) => `${route.capabilityId}:${route.operationId}`));

    for (const capability of registry.listCapabilities()) {
      for (const operation of capability.operations) {
        expect(routeKeys).toContain(`${capability.id}:${operation.id}`);
      }
    }
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
        scopeKind: 'runtime-instance',
        scope: expect.objectContaining({
          kind: 'runtime-instance',
          endpoint: nativeEndpoint,
        }),
        supportLevel: 'native',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        targetKinds: ['runtime-endpoint'],
      }),
      expect.objectContaining({
        id: 'session.prompt',
        kind: 'session',
        scopeKind: 'agent',
        scope: expect.objectContaining({
          kind: 'agent',
          endpoint: nativeEndpoint,
          agentId: 'default',
        }),
        supportLevel: 'native',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        targetAgentIds: ['default'],
      }),
    ]));
    expect(registry.listCapabilities().some((descriptor) => descriptor.scope.kind !== 'app' && 'endpoint' in descriptor.scope && descriptor.scope.endpoint.kind === 'protocol-connector')).toBe(false);
    expect(() => registry.getCapability({
      id: 'session.prompt',
      scope: {
        kind: 'agent',
        endpoint: hermesEndpoint,
        agentId: 'default',
      },
    })).toThrow('Connector runtime endpoint not registered: acp:acp:hermes');
  });

  it('registers descriptors built from explicit runtime endpoint scopes', () => {
    const registry = new CapabilityRegistry();
    const descriptors = buildRuntimeEndpointCapabilityDescriptors({
      endpoint,
      endpointRef: connectorEndpoint,
      scope: runtimeInstanceScope(connectorEndpoint),
      supportLevel: 'native',
      ownerModuleId: 'acp',
      routeOwnerId: 'sessions',
    });

    registry.registerMany(descriptors);

    expect(registry.list()).toHaveLength(1);
    expect(registry.get({
      id: 'session.management',
      scope: runtimeInstanceScope(connectorEndpoint),
    })).toBe(descriptors.find((descriptor) => descriptor.id === 'session.management'));
  });

  it('removes descriptors by runtime endpoint scope', () => {
    const registry = new CapabilityRegistry();
    const promptDescriptor = createDescriptor(connectorAgentScope);
    const managementDescriptor = createDescriptor(connectorAgentScope, 'session.management');
    const otherEndpointDescriptor = createDescriptor({
      ...connectorAgentScope,
      endpoint: hermesEndpoint,
    });

    registry.register(promptDescriptor);
    registry.register(managementDescriptor);
    registry.register(otherEndpointDescriptor);

    registry.removeForRuntimeEndpointScope({ kind: 'runtime-instance', endpoint: connectorEndpoint });

    expect(registry.list()).toEqual([otherEndpointDescriptor]);
  });

  it('indexes descriptors by capability id and full scope', () => {
    const registry = new CapabilityRegistry();
    const defaultDescriptor = createDescriptor(nativeAgentScope);
    const reviewerScope: RuntimeScope = {
      ...nativeAgentScope,
      agentId: 'reviewer',
    };
    const reviewerDescriptor = createDescriptor(reviewerScope);

    registry.register(defaultDescriptor);
    registry.register(reviewerDescriptor);

    expect(registry.listByCapability('session.prompt')).toHaveLength(2);
    expect(registry.get({
      id: 'session.prompt',
      scope: nativeAgentScope,
    })).toBe(defaultDescriptor);
    expect(registry.get({
      id: 'session.prompt',
      scope: reviewerScope,
    })).toBe(reviewerDescriptor);
  });

  it('rejects mismatched session capability targets before invoking services', async () => {
    const { routes, services } = createSessionCapabilityRouteHarness();
    const cases = [
      ['sessions.load', sessionTarget, { sessionKey: otherSessionIdentity.sessionKey }, services.commandService.loadSession],
      ['sessions.prompt', sessionTarget, { sessionIdentity: otherSessionIdentity, message: 'hello' }, services.promptService.promptSession],
      ['sessions.sendWithMedia', sessionTarget, { sessionKey: otherSessionIdentity.sessionKey, text: 'hello' }, services.promptService.promptSession],
      ['sessions.abort', sessionTarget, { sessionKey: otherSessionIdentity.sessionKey }, services.commandService.abortSession],
      ['sessions.window', sessionTarget, { sessionIdentity: otherSessionIdentity, mode: 'latest' }, services.commandService.loadSession],
      ['sessions.delete', sessionTarget, { sessionKey: otherSessionIdentity.sessionKey }, services.commandService.deleteSession],
      ['sessions.rename', sessionTarget, { sessionIdentity: otherSessionIdentity, label: 'renamed' }, services.commandService.renameSession],
      ['approvals.list', sessionTarget, { sessionIdentity: otherSessionIdentity }, services.commandService.listPendingApprovals],
      ['approvals.resolve', approvalTarget, { id: 'approval-input', decision: 'allow-once' }, services.commandService.resolveApproval],
      ['approvals.resolve', approvalTarget, { sessionKey: otherSessionIdentity.sessionKey, decision: 'allow-once' }, services.commandService.resolveApproval],
    ] as const;

    for (const [operationId, target, input, service] of cases) {
      const response = await route(routes, operationId).handle({
        capabilityId: operationId.startsWith('approvals.') ? 'session.approval' : 'session.prompt',
        operationId,
        scope: nativeAgentScope,
        target,
        input,
        domainInput: input,
      });
      expect(response.status, operationId).toBe(400);
      expect(service, operationId).not.toHaveBeenCalled();
    }
  });

  it('injects exact target identity into accepted session capability inputs', async () => {
    const { routes, services } = createSessionCapabilityRouteHarness();

    await route(routes, 'sessions.prompt').handle({
      capabilityId: 'session.prompt',
      operationId: 'sessions.prompt',
      scope: nativeAgentScope,
      target: sessionTarget,
      input: { message: 'hello' },
      domainInput: { message: 'hello' },
    });
    await route(routes, 'approvals.resolve').handle({
      capabilityId: 'session.approval',
      operationId: 'approvals.resolve',
      scope: nativeAgentScope,
      target: approvalTarget,
      input: { decision: 'allow-once' },
      domainInput: { decision: 'allow-once' },
    });

    expect(services.promptService.promptSession).toHaveBeenCalledWith({
      message: 'hello',
      sessionKey: sessionIdentity.sessionKey,
      sessionIdentity,
    });
    expect(services.commandService.resolveApproval).toHaveBeenCalledWith({
      decision: 'allow-once',
      id: approvalTarget.approvalId,
      sessionKey: sessionIdentity.sessionKey,
      sessionIdentity,
    });
  });

  it('rejects mismatched model provider target bindings before invoking services', async () => {
    const { routes, services } = createModelProviderRouteHarness();
    const cases = [
      ['providers.getAccount', { kind: 'provider-account', accountId: 'other' }, { accountId: 'openai-main' }, services.providerAccountsService.get],
      ['providers.getApiKey', { kind: 'provider-credential', accountId: 'openai-main' }, { accountId: 'openai-main', vendorId: 'openai' }, services.providerAccountsService.getApiKey],
      ['providers.getApiKey', { kind: 'provider-credential', accountId: 'openai-main', vendorId: 'anthropic' }, { accountId: 'openai-main', vendorId: 'openai' }, services.providerAccountsService.getApiKey],
      ['providers.validate', { kind: 'provider-credential', accountId: 'openai-main', vendorId: 'anthropic' }, { accountId: 'openai-main', vendorId: 'openai', apiKey: 'sk-test' }, services.providerAccountsService.validate],
      ['providers.createAccount', { kind: 'provider-account', accountId: 'openai-main', vendorId: 'anthropic' }, { account: { id: 'openai-main', vendorId: 'openai' }, apiKey: 'sk-test' }, services.providerAccountsService.create],
      ['providers.updateAccount', { kind: 'provider-account' }, { accountId: 'openai-main', updates: { label: 'OpenAI Main' } }, services.providerAccountsService.update],
      ['providers.deleteAccount', { kind: 'provider-account', accountId: 'other' }, { accountId: 'openai-main' }, services.providerAccountsService.delete],
      ['providers.oauthStart', { kind: 'provider-oauth', flowId: 'flow-1', accountId: 'openai-main', vendorId: 'anthropic' }, { provider: 'openai', flowId: 'flow-1', accountId: 'openai-main' }, services.providerAccountsService.startOAuth],
      ['providers.oauthSubmit', { kind: 'provider-oauth', flowId: 'flow-1', accountId: 'openai-main', vendorId: 'anthropic' }, { code: 'code', flowId: 'flow-1', accountId: 'openai-main', vendorId: 'openai' }, services.providerAccountsService.submitOAuth],
      ['providers.oauthCompleteBrowser', { kind: 'provider-oauth', flowId: 'flow-1', accountId: 'other', vendorId: 'openai' }, { providerType: 'openai', flowId: 'flow-1', accountId: 'openai-main' }, services.providerAccountsService.completeBrowser],
      ['providers.oauthCompleteDevice', { kind: 'provider-oauth', flowId: 'flow-1', accountId: 'minimax-main', vendorId: 'qwen-portal' }, { providerType: 'minimax-portal', flowId: 'flow-1', accountId: 'minimax-main' }, services.providerAccountsService.completeDevice],
      ['providerModels.get', { kind: 'provider-credential', accountId: 'other', vendorId: 'openai' }, { credentialId: 'openai-main', vendorId: 'openai' }, services.providerModelsService.read],
      ['providerModels.replace', { kind: 'provider-credential', accountId: 'openai-main' }, { credentialId: 'openai-main', vendorId: 'openai', models: [] }, services.providerModelsService.replace],
      ['capabilityRouting.write', { kind: 'capability-route', capabilityId: 'other.capability' }, { chat: { primary: { credentialId: 'openai-main', modelId: 'gpt-5' }, fallbacks: [] } }, services.capabilityRoutingService.write],
    ] as const;

    for (const [operationId, target, input, service] of cases) {
      const response = await route(routes, operationId).handle(context(target, input));
      expect(response.status, operationId).toBe(400);
      expect(service, operationId).not.toHaveBeenCalled();
    }
  });

  it('allows model provider handlers when target bindings match input business ids', async () => {
    const { routes, services } = createModelProviderRouteHarness();
    const cases = [
      ['providers.getAccount', { kind: 'provider-account', accountId: 'openai-main' }, { accountId: 'openai-main' }, services.providerAccountsService.get, ['openai-main']],
      ['providers.getApiKey', { kind: 'provider-credential', accountId: 'openai-main', vendorId: 'openai' }, { accountId: 'openai-main', vendorId: 'openai' }, services.providerAccountsService.getApiKey, ['openai-main']],
      ['providers.validate', { kind: 'provider-credential', accountId: 'openai', vendorId: 'openai' }, { vendorId: 'openai', apiKey: 'sk-test' }, services.providerAccountsService.validate, [{ vendorId: 'openai', apiKey: 'sk-test' }]],
      ['providers.createAccount', { kind: 'provider-account', accountId: 'openai-main', vendorId: 'openai' }, { account: { id: 'openai-main', vendorId: 'openai' }, apiKey: 'sk-test' }, services.providerAccountsService.create, [{ account: { id: 'openai-main', vendorId: 'openai' }, apiKey: 'sk-test' }]],
      ['providers.updateAccount', { kind: 'provider-account', accountId: 'openai-main' }, { accountId: 'openai-main', updates: { label: 'OpenAI Main' } }, services.providerAccountsService.update, ['openai-main', { accountId: 'openai-main', updates: { label: 'OpenAI Main' } }]],
      ['providers.deleteAccount', { kind: 'provider-account', accountId: 'openai-main' }, { accountId: 'openai-main', apiKeyOnly: true }, services.providerAccountsService.delete, ['openai-main', true]],
      ['providers.oauthStart', { kind: 'provider-oauth', flowId: 'flow-1', accountId: 'openai-main', vendorId: 'openai' }, { provider: 'openai', flowId: 'flow-1', accountId: 'openai-main' }, services.providerAccountsService.startOAuth, [{ provider: 'openai', flowId: 'flow-1', accountId: 'openai-main' }]],
      ['providers.oauthSubmit', { kind: 'provider-oauth', flowId: 'flow-1', accountId: 'openai-main', vendorId: 'openai' }, { code: 'code', flowId: 'flow-1', accountId: 'openai-main', vendorId: 'openai' }, services.providerAccountsService.submitOAuth, [{ code: 'code', flowId: 'flow-1', accountId: 'openai-main', vendorId: 'openai' }]],
      ['providers.oauthCompleteBrowser', { kind: 'provider-oauth', flowId: 'flow-1', accountId: 'openai-main', vendorId: 'openai' }, { providerType: 'openai', flowId: 'flow-1', accountId: 'openai-main' }, services.providerAccountsService.completeBrowser, [{ providerType: 'openai', flowId: 'flow-1', accountId: 'openai-main' }]],
      ['providers.oauthCompleteDevice', { kind: 'provider-oauth', flowId: 'flow-1', accountId: 'minimax-main', vendorId: 'minimax-portal' }, { providerType: 'minimax-portal', flowId: 'flow-1', accountId: 'minimax-main' }, services.providerAccountsService.completeDevice, [{ providerType: 'minimax-portal', flowId: 'flow-1', accountId: 'minimax-main' }]],
      ['providerModels.get', { kind: 'provider-credential', accountId: 'openai-main', vendorId: 'openai' }, { credentialId: 'openai-main', vendorId: 'openai' }, services.providerModelsService.read, ['openai-main']],
      ['providerModels.replace', { kind: 'provider-credential', accountId: 'openai-main', vendorId: 'openai' }, { credentialId: 'openai-main', vendorId: 'openai', models: [] }, services.providerModelsService.replace, ['openai-main', { credentialId: 'openai-main', vendorId: 'openai', models: [] }]],
      ['capabilityRouting.write', { kind: 'capability-route', capabilityId: 'model.provider' }, { chat: { primary: { credentialId: 'openai-main', modelId: 'gpt-5' }, fallbacks: [] } }, services.capabilityRoutingService.write, [{ chat: { primary: { credentialId: 'openai-main', modelId: 'gpt-5' }, fallbacks: [] } }]],
    ] as const;

    for (const [operationId, target, input, service, args] of cases) {
      const response = await route(routes, operationId).handle(context(target, input));
      expect(response.status, operationId).not.toBe(400);
      expect(service, operationId).toHaveBeenCalledWith(...args);
    }
  });
});
