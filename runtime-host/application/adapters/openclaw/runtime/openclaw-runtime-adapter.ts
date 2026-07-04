import type { CapabilityDescriptor, CapabilityOperationDescriptor } from '../../../capabilities/contracts/capability-descriptor';
import type { GatewayChatPort, GatewayRpcPort } from '../../../gateway/gateway-runtime-port';
import type {
  RuntimeAdapter,
  RuntimeEndpointProfile,
  RuntimeSessionTransport,
} from '../../../agent-runtime/contracts/runtime-endpoint-types';
import {
  appScope,
  nativeRuntimeEndpoint,
  runtimeInstanceScope,
  type RuntimeEndpointRef,
  type RuntimeScope,
} from '../../../agent-runtime/contracts/runtime-address';
import { OPENCLAW_RUNTIME_ADAPTER_ID, OPENCLAW_RUNTIME_INSTANCE_ID } from './openclaw-runtime-identity';
import { buildRuntimeEndpointCapabilityDescriptors } from '../../../agent-runtime/contracts/runtime-capability-descriptors';
import { AGENT_SKILL_CONFIG_CAPABILITY_ID, agentSkillConfigCapabilityOperations } from '../../../capabilities/agent/agent-skill-config-capability';
import { AGENT_TOOL_CONFIG_CAPABILITY_ID, agentToolConfigCapabilityOperations } from '../../../capabilities/agent/agent-tool-config-capability';
import { SUBAGENT_MANAGEMENT_CAPABILITY_ID, subagentManagementCapabilityOperations } from '../../../capabilities/agent/subagent-management-capability';
import { CHANNEL_INTEGRATION_CAPABILITY_ID, channelIntegrationCapabilityOperations } from '../../../capabilities/integration/channel-integration-capability';
import { EXTERNAL_CONNECTOR_CAPABILITY_ID, externalConnectorCapabilityOperations } from '../../../external-connectors/external-connector-capability';
import { LICENSE_RUNTIME_CAPABILITY_ID, licenseRuntimeCapabilityOperations } from '../../../capabilities/license/license-runtime-capability';
import { MODEL_PROVIDER_CAPABILITY_ID, modelProviderCapabilityOperations } from '../../../capabilities/model/model-provider-capability';
import { PLATFORM_RUNTIME_CAPABILITY_ID, platformRuntimeCapabilityOperations } from '../../../capabilities/platform/platform-runtime-capability';
import { PLUGIN_RUNTIME_CAPABILITY_ID, pluginRuntimeCapabilityOperations } from '../../../capabilities/plugin/plugin-runtime-capability';
import { RUNTIME_HOST_CAPABILITY_ID, runtimeHostCapabilityOperations } from '../../../capabilities/runtime/runtime-host-capability';
import { SCHEDULER_CRON_CAPABILITY_ID, cronSchedulerCapabilityOperations } from '../../../capabilities/scheduler/cron-scheduler-capability';
import { SECURITY_RUNTIME_CAPABILITY_ID, securityRuntimeCapabilityOperations } from '../../../capabilities/security/security-runtime-capability';
import { SETTINGS_RUNTIME_CAPABILITY_ID, settingsRuntimeCapabilityOperations } from '../../../capabilities/settings/settings-runtime-capability';
import { SKILL_MANAGEMENT_CAPABILITY_ID, skillManagementCapabilityOperations } from '../../../capabilities/skill/skill-management-capability';
import { TASK_CONTROL_CAPABILITY_ID, taskControlCapabilityOperations } from '../../../capabilities/task/task-control-capability';
import { TEAM_RUNTIME_CAPABILITY_ID, teamRuntimeCapabilityOperations } from '../../../capabilities/team/team-runtime-capability';
import { WORKSPACE_FILE_CAPABILITY_ID, workspaceFileCapabilityOperations } from '../../../capabilities/workspace/workspace-file-capability';
import { OpenClawV4ProtocolAdapter } from './openclaw-v4-protocol-adapter';
import { openClawRuntimeEndpointProfile } from './openclaw-profile';
import { OpenClawRuntimeTransport } from './openclaw-transport';
import { OpenClawApprovalAdapter } from './openclaw-approval-adapter';

const CAPABILITY_OWNERS: Record<string, { ownerModuleId: string; routeOwnerId: string }> = {
  [CHANNEL_INTEGRATION_CAPABILITY_ID]: { ownerModuleId: 'integration', routeOwnerId: 'openclaw' },
  [EXTERNAL_CONNECTOR_CAPABILITY_ID]: { ownerModuleId: 'external-connectors', routeOwnerId: 'operations' },
  [PLATFORM_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'platform', routeOwnerId: 'operations' },
  [MODEL_PROVIDER_CAPABILITY_ID]: { ownerModuleId: 'model', routeOwnerId: 'openclaw' },
  [LICENSE_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'license', routeOwnerId: 'operations' },
  [RUNTIME_HOST_CAPABILITY_ID]: { ownerModuleId: 'runtime', routeOwnerId: 'runtime' },
  [AGENT_SKILL_CONFIG_CAPABILITY_ID]: { ownerModuleId: 'agent', routeOwnerId: 'openclaw' },
  [AGENT_TOOL_CONFIG_CAPABILITY_ID]: { ownerModuleId: 'agent', routeOwnerId: 'openclaw' },
  [SUBAGENT_MANAGEMENT_CAPABILITY_ID]: { ownerModuleId: 'agent', routeOwnerId: 'openclaw' },
  [PLUGIN_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'plugin', routeOwnerId: 'runtime' },
  [SCHEDULER_CRON_CAPABILITY_ID]: { ownerModuleId: 'scheduler', routeOwnerId: 'operations' },
  [SECURITY_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'security', routeOwnerId: 'operations' },
  [SETTINGS_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'settings', routeOwnerId: 'openclaw' },
  [SKILL_MANAGEMENT_CAPABILITY_ID]: { ownerModuleId: 'skill', routeOwnerId: 'openclaw' },
  [TASK_CONTROL_CAPABILITY_ID]: { ownerModuleId: 'task', routeOwnerId: 'operations' },
  [TEAM_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'team', routeOwnerId: 'operations' },
  [WORKSPACE_FILE_CAPABILITY_ID]: { ownerModuleId: 'workspace', routeOwnerId: 'operations' },
};

const openClawEndpointRef = nativeRuntimeEndpoint({
  runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
  runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
});

function capabilityOwner(capabilityId: string): Pick<CapabilityDescriptor, 'ownerModuleId' | 'routeOwnerId'> {
  const owner = CAPABILITY_OWNERS[capabilityId];
  if (!owner) {
    throw new Error(`OpenClaw capability owner not registered: ${capabilityId}`);
  }
  return owner;
}

function createScopedCapabilityDescriptor(input: {
  id: string;
  kind: string;
  scope: RuntimeScope;
  operations: readonly CapabilityOperationDescriptor[];
}): CapabilityDescriptor {
  return {
    id: input.id,
    kind: input.kind,
    scopeKind: input.scope.kind,
    scope: input.scope,
    targetKinds: Array.from(new Set(input.operations.map((operation) => operation.targetKind))),
    ...endpointMetadata(input.scope),
    ...targetAgentMetadata(input.scope),
    supportLevel: 'native',
    availability: 'available',
    operations: [...input.operations],
    policyScope: input.id,
    ...capabilityOwner(input.id),
  };
}

function endpointMetadata(scope: RuntimeScope): Partial<CapabilityDescriptor> {
  const endpoint = 'endpoint' in scope ? scope.endpoint : scope.kind === 'session' ? scope.identity.endpoint : null;
  if (!endpoint) {
    return {};
  }
  return endpoint.kind === 'native-runtime'
    ? {
      runtimeAdapterId: endpoint.runtimeAdapterId,
      runtimeInstanceId: endpoint.runtimeInstanceId,
    }
    : {
      protocolId: endpoint.protocolId,
      connectorId: endpoint.connectorId,
      endpointId: endpoint.endpointId,
    };
}

function targetAgentMetadata(scope: RuntimeScope): Partial<CapabilityDescriptor> {
  if (scope.kind === 'agent') {
    return { targetAgentIds: [scope.agentId] };
  }
  if (scope.kind === 'session') {
    return { targetAgentIds: [scope.identity.agentId] };
  }
  return {};
}

function buildAppCapabilities(): CapabilityDescriptor[] {
  const scope = appScope();
  return [
    createScopedCapabilityDescriptor({
      id: SETTINGS_RUNTIME_CAPABILITY_ID,
      kind: 'settings-runtime',
      scope,
      operations: settingsRuntimeCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: LICENSE_RUNTIME_CAPABILITY_ID,
      kind: 'license-runtime',
      scope,
      operations: licenseRuntimeCapabilityOperations,
    }),
  ];
}

function buildRuntimeInstanceCapabilities(endpoint: RuntimeEndpointProfile, endpointRef: RuntimeEndpointRef): CapabilityDescriptor[] {
  const runtimeScope = runtimeInstanceScope(endpointRef);
  const workspaceScope: RuntimeScope = { kind: 'workspace', endpoint: endpointRef };
  return [
    ...buildRuntimeEndpointCapabilityDescriptors({
      endpoint,
      endpointRef,
      scope: runtimeScope,
      supportLevel: 'native',
      ownerModuleId: OPENCLAW_RUNTIME_ADAPTER_ID,
      routeOwnerId: 'sessions',
    }),
    createScopedCapabilityDescriptor({
      id: CHANNEL_INTEGRATION_CAPABILITY_ID,
      kind: 'integration-channel',
      scope: runtimeScope,
      operations: channelIntegrationCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: PLATFORM_RUNTIME_CAPABILITY_ID,
      kind: 'platform-runtime',
      scope: runtimeScope,
      operations: platformRuntimeCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: EXTERNAL_CONNECTOR_CAPABILITY_ID,
      kind: 'external-connector',
      scope: runtimeScope,
      operations: externalConnectorCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: MODEL_PROVIDER_CAPABILITY_ID,
      kind: 'model-provider',
      scope: runtimeScope,
      operations: modelProviderCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: RUNTIME_HOST_CAPABILITY_ID,
      kind: 'runtime-host',
      scope: runtimeScope,
      operations: runtimeHostCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: PLUGIN_RUNTIME_CAPABILITY_ID,
      kind: 'plugin-runtime',
      scope: runtimeScope,
      operations: pluginRuntimeCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: SCHEDULER_CRON_CAPABILITY_ID,
      kind: 'scheduler-cron',
      scope: runtimeScope,
      operations: cronSchedulerCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: SECURITY_RUNTIME_CAPABILITY_ID,
      kind: 'security-runtime',
      scope: runtimeScope,
      operations: securityRuntimeCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: SKILL_MANAGEMENT_CAPABILITY_ID,
      kind: 'skill-management',
      scope: runtimeScope,
      operations: skillManagementCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: TASK_CONTROL_CAPABILITY_ID,
      kind: 'task-control',
      scope: runtimeScope,
      operations: taskControlCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: TEAM_RUNTIME_CAPABILITY_ID,
      kind: 'team-runtime',
      scope: runtimeScope,
      operations: teamRuntimeCapabilityOperations,
    }),
    createScopedCapabilityDescriptor({
      id: WORKSPACE_FILE_CAPABILITY_ID,
      kind: 'workspace-file',
      scope: workspaceScope,
      operations: workspaceFileCapabilityOperations,
    }),
  ];
}

function buildAgentScopedCapabilities(endpoint: RuntimeEndpointProfile, endpointRef: RuntimeEndpointRef): CapabilityDescriptor[] {
  const descriptors: CapabilityDescriptor[] = [];
  for (const agentId of endpoint.agentIds) {
    descriptors.push(
      ...buildRuntimeEndpointCapabilityDescriptors({
        endpoint,
        endpointRef,
        agentId,
        supportLevel: 'native',
        ownerModuleId: OPENCLAW_RUNTIME_ADAPTER_ID,
        routeOwnerId: 'sessions',
      }),
      createScopedCapabilityDescriptor({
        id: AGENT_SKILL_CONFIG_CAPABILITY_ID,
        kind: 'agent-skill-config',
        scope: { kind: 'agent', endpoint: endpointRef, agentId },
        operations: agentSkillConfigCapabilityOperations,
      }),
      createScopedCapabilityDescriptor({
        id: AGENT_TOOL_CONFIG_CAPABILITY_ID,
        kind: 'agent-tool-config',
        scope: { kind: 'agent', endpoint: endpointRef, agentId },
        operations: agentToolConfigCapabilityOperations,
      }),
      createScopedCapabilityDescriptor({
        id: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
        kind: 'subagent-management',
        scope: { kind: 'agent', endpoint: endpointRef, agentId },
        operations: subagentManagementCapabilityOperations,
      }),
    );
  }
  return descriptors;
}

export class OpenClawRuntimeAdapter implements RuntimeAdapter {
  readonly runtimeAdapterId = OPENCLAW_RUNTIME_ADAPTER_ID;
  readonly protocol = new OpenClawV4ProtocolAdapter();
  readonly endpoints = [openClawRuntimeEndpointProfile];
  readonly approvalNotifications = new OpenClawApprovalAdapter();
  readonly capabilities = [
    ...buildAppCapabilities(),
    ...buildRuntimeInstanceCapabilities(openClawRuntimeEndpointProfile, openClawEndpointRef),
    ...buildAgentScopedCapabilities(openClawRuntimeEndpointProfile, openClawEndpointRef),
  ];

  createTransport(
    _endpoint: RuntimeEndpointProfile,
    runtimePorts: { gateway: GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'> },
  ): RuntimeSessionTransport {
    return new OpenClawRuntimeTransport(runtimePorts.gateway);
  }
}
