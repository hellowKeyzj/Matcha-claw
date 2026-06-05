import type { CapabilityDescriptor } from '../../../capabilities/contracts/capability-descriptor';
import type { GatewayChatPort, GatewayRpcPort } from '../../../gateway/gateway-runtime-port';
import type {
  RuntimeAdapter,
  RuntimeEndpointProfile,
  RuntimeSessionTransport,
} from '../../../agent-runtime/contracts/runtime-endpoint-types';
import { OPENCLAW_RUNTIME_ADAPTER_ID, OPENCLAW_RUNTIME_INSTANCE_ID } from './openclaw-runtime-identity';
import { buildRuntimeEndpointCapabilityDescriptors } from '../../../agent-runtime/contracts/runtime-capability-descriptors';
import { SUBAGENT_MANAGEMENT_CAPABILITY_ID, subagentManagementCapabilityOperations } from '../../../capabilities/agent/subagent-management-capability';
import { CHANNEL_INTEGRATION_CAPABILITY_ID, channelIntegrationCapabilityOperations } from '../../../capabilities/integration/channel-integration-capability';
import { LICENSE_RUNTIME_CAPABILITY_ID, licenseRuntimeCapabilityOperations } from '../../../capabilities/license/license-runtime-capability';
import { MODEL_PROVIDER_CAPABILITY_ID, modelProviderCapabilityOperations } from '../../../capabilities/model/model-provider-capability';
import { PLATFORM_RUNTIME_CAPABILITY_ID, platformRuntimeCapabilityOperations } from '../../../capabilities/platform/platform-runtime-capability';
import { PLUGIN_RUNTIME_CAPABILITY_ID, pluginRuntimeCapabilityOperations } from '../../../capabilities/plugin/plugin-runtime-capability';
import { RUNTIME_HOST_CAPABILITY_ID, runtimeHostCapabilityOperations } from '../../../capabilities/runtime/runtime-host-capability';
import { SCHEDULER_CRON_CAPABILITY_ID, cronSchedulerCapabilityOperations } from '../../../capabilities/scheduler/cron-scheduler-capability';
import { SECURITY_RUNTIME_CAPABILITY_ID, securityRuntimeCapabilityOperations } from '../../../capabilities/security/security-runtime-capability';
import { SETTINGS_RUNTIME_CAPABILITY_ID, settingsRuntimeCapabilityOperations } from '../../../capabilities/settings/settings-runtime-capability';
import { SESSION_PROMPT_CAPABILITY_ID } from '../../../capabilities/session/session-prompt-capability';
import { SKILL_MANAGEMENT_CAPABILITY_ID, skillManagementCapabilityOperations } from '../../../capabilities/skill/skill-management-capability';
import { MULTI_AGENT_TASK_CAPABILITY_ID, multiAgentTaskCapabilityOperations } from '../../../capabilities/task/multi-agent-task-capability';
import { TASK_CONTROL_CAPABILITY_ID, taskControlCapabilityOperations } from '../../../capabilities/task/task-control-capability';
import { TEAM_COORDINATION_CAPABILITY_ID, teamCoordinationCapabilityOperations } from '../../../capabilities/team/team-coordination-capability';
import { WORKSPACE_FILE_CAPABILITY_ID, workspaceFileCapabilityOperations } from '../../../capabilities/workspace/workspace-file-capability';
import { OpenClawV4ProtocolAdapter } from './openclaw-v4-protocol-adapter';
import { openClawRuntimeEndpointProfile } from './openclaw-profile';
import { OpenClawRuntimeTransport } from './openclaw-transport';
import { OpenClawApprovalAdapter } from './openclaw-approval-adapter';

const CAPABILITY_OWNERS: Record<string, { ownerModuleId: string; routeOwnerId: string }> = {
  [CHANNEL_INTEGRATION_CAPABILITY_ID]: { ownerModuleId: 'integration', routeOwnerId: 'openclaw' },
  [PLATFORM_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'platform', routeOwnerId: 'operations' },
  [MODEL_PROVIDER_CAPABILITY_ID]: { ownerModuleId: 'model', routeOwnerId: 'openclaw' },
  [LICENSE_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'license', routeOwnerId: 'operations' },
  [RUNTIME_HOST_CAPABILITY_ID]: { ownerModuleId: 'runtime', routeOwnerId: 'runtime' },
  [SUBAGENT_MANAGEMENT_CAPABILITY_ID]: { ownerModuleId: 'agent', routeOwnerId: 'openclaw' },
  [PLUGIN_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'plugin', routeOwnerId: 'runtime' },
  [SCHEDULER_CRON_CAPABILITY_ID]: { ownerModuleId: 'scheduler', routeOwnerId: 'operations' },
  [SECURITY_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'security', routeOwnerId: 'operations' },
  [SETTINGS_RUNTIME_CAPABILITY_ID]: { ownerModuleId: 'settings', routeOwnerId: 'openclaw' },
  [SKILL_MANAGEMENT_CAPABILITY_ID]: { ownerModuleId: 'skill', routeOwnerId: 'openclaw' },
  [TASK_CONTROL_CAPABILITY_ID]: { ownerModuleId: 'task', routeOwnerId: 'operations' },
  [TEAM_COORDINATION_CAPABILITY_ID]: { ownerModuleId: 'team', routeOwnerId: 'operations' },
  [MULTI_AGENT_TASK_CAPABILITY_ID]: { ownerModuleId: 'workflow', routeOwnerId: 'operations' },
  [WORKSPACE_FILE_CAPABILITY_ID]: { ownerModuleId: 'workspace', routeOwnerId: 'operations' },
};

function capabilityOwner(capabilityId: string): Pick<CapabilityDescriptor, 'ownerModuleId' | 'routeOwnerId'> {
  const owner = CAPABILITY_OWNERS[capabilityId];
  if (!owner) {
    throw new Error(`OpenClaw capability owner not registered: ${capabilityId}`);
  }
  return owner;
}

export class OpenClawRuntimeAdapter implements RuntimeAdapter {
  readonly runtimeAdapterId = OPENCLAW_RUNTIME_ADAPTER_ID;
  readonly protocol = new OpenClawV4ProtocolAdapter();
  readonly endpoints = [openClawRuntimeEndpointProfile];
  readonly approvalNotifications = new OpenClawApprovalAdapter();
  readonly capabilities = openClawRuntimeEndpointProfile.agentIds.flatMap((agentId) => [
    ...buildRuntimeEndpointCapabilityDescriptors({
      endpoint: openClawRuntimeEndpointProfile,
      supportLevel: 'native',
      address: {
        kind: 'native-runtime',
        capabilityId: SESSION_PROMPT_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      ownerModuleId: OPENCLAW_RUNTIME_ADAPTER_ID,
      routeOwnerId: 'sessions',
    }),
    {
      id: CHANNEL_INTEGRATION_CAPABILITY_ID,
      kind: 'integration-channel',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: channelIntegrationCapabilityOperations,
      policyScope: CHANNEL_INTEGRATION_CAPABILITY_ID,
      ...capabilityOwner(CHANNEL_INTEGRATION_CAPABILITY_ID),
    },
    {
      id: PLATFORM_RUNTIME_CAPABILITY_ID,
      kind: 'platform-runtime',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: PLATFORM_RUNTIME_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: platformRuntimeCapabilityOperations,
      policyScope: PLATFORM_RUNTIME_CAPABILITY_ID,
      ...capabilityOwner(PLATFORM_RUNTIME_CAPABILITY_ID),
    },
    {
      id: MODEL_PROVIDER_CAPABILITY_ID,
      kind: 'model-provider',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: modelProviderCapabilityOperations,
      policyScope: MODEL_PROVIDER_CAPABILITY_ID,
      ...capabilityOwner(MODEL_PROVIDER_CAPABILITY_ID),
    },
    {
      id: LICENSE_RUNTIME_CAPABILITY_ID,
      kind: 'license-runtime',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: LICENSE_RUNTIME_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: licenseRuntimeCapabilityOperations,
      policyScope: LICENSE_RUNTIME_CAPABILITY_ID,
      ...capabilityOwner(LICENSE_RUNTIME_CAPABILITY_ID),
    },
    {
      id: RUNTIME_HOST_CAPABILITY_ID,
      kind: 'runtime-host',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: RUNTIME_HOST_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: runtimeHostCapabilityOperations,
      policyScope: RUNTIME_HOST_CAPABILITY_ID,
      ...capabilityOwner(RUNTIME_HOST_CAPABILITY_ID),
    },
    {
      id: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      kind: 'subagent-management',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: subagentManagementCapabilityOperations,
      policyScope: SUBAGENT_MANAGEMENT_CAPABILITY_ID,
      ...capabilityOwner(SUBAGENT_MANAGEMENT_CAPABILITY_ID),
    },
    {
      id: PLUGIN_RUNTIME_CAPABILITY_ID,
      kind: 'plugin-runtime',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: PLUGIN_RUNTIME_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: pluginRuntimeCapabilityOperations,
      policyScope: PLUGIN_RUNTIME_CAPABILITY_ID,
      ...capabilityOwner(PLUGIN_RUNTIME_CAPABILITY_ID),
    },
    {
      id: SCHEDULER_CRON_CAPABILITY_ID,
      kind: 'scheduler-cron',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: SCHEDULER_CRON_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: cronSchedulerCapabilityOperations,
      policyScope: SCHEDULER_CRON_CAPABILITY_ID,
      ...capabilityOwner(SCHEDULER_CRON_CAPABILITY_ID),
    },
    {
      id: SECURITY_RUNTIME_CAPABILITY_ID,
      kind: 'security-runtime',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: securityRuntimeCapabilityOperations,
      policyScope: SECURITY_RUNTIME_CAPABILITY_ID,
      ...capabilityOwner(SECURITY_RUNTIME_CAPABILITY_ID),
    },
    {
      id: SETTINGS_RUNTIME_CAPABILITY_ID,
      kind: 'settings-runtime',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: SETTINGS_RUNTIME_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: settingsRuntimeCapabilityOperations,
      policyScope: SETTINGS_RUNTIME_CAPABILITY_ID,
      ...capabilityOwner(SETTINGS_RUNTIME_CAPABILITY_ID),
    },
    {
      id: SKILL_MANAGEMENT_CAPABILITY_ID,
      kind: 'skill-management',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: skillManagementCapabilityOperations,
      policyScope: SKILL_MANAGEMENT_CAPABILITY_ID,
      ...capabilityOwner(SKILL_MANAGEMENT_CAPABILITY_ID),
    },
    {
      id: TASK_CONTROL_CAPABILITY_ID,
      kind: 'task-control',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: TASK_CONTROL_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: taskControlCapabilityOperations,
      policyScope: TASK_CONTROL_CAPABILITY_ID,
      ...capabilityOwner(TASK_CONTROL_CAPABILITY_ID),
    },
    {
      id: TEAM_COORDINATION_CAPABILITY_ID,
      kind: 'team-coordination',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: TEAM_COORDINATION_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: teamCoordinationCapabilityOperations,
      policyScope: TEAM_COORDINATION_CAPABILITY_ID,
      ...capabilityOwner(TEAM_COORDINATION_CAPABILITY_ID),
    },
    {
      id: MULTI_AGENT_TASK_CAPABILITY_ID,
      kind: 'multi-agent-task',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: MULTI_AGENT_TASK_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: multiAgentTaskCapabilityOperations,
      policyScope: MULTI_AGENT_TASK_CAPABILITY_ID,
      ...capabilityOwner(MULTI_AGENT_TASK_CAPABILITY_ID),
    },
    {
      id: WORKSPACE_FILE_CAPABILITY_ID,
      kind: 'workspace-file',
      address: {
        kind: 'native-runtime' as const,
        capabilityId: WORKSPACE_FILE_CAPABILITY_ID,
        runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
        runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
        agentId,
      },
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
      targetAgentIds: [agentId],
      supportLevel: 'native' as const,
      availability: 'available' as const,
      operations: workspaceFileCapabilityOperations,
      policyScope: WORKSPACE_FILE_CAPABILITY_ID,
      ...capabilityOwner(WORKSPACE_FILE_CAPABILITY_ID),
    },
  ]);

  createTransport(
    _endpoint: RuntimeEndpointProfile,
    runtimePorts: { gateway: GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'> },
  ): RuntimeSessionTransport {
    return new OpenClawRuntimeTransport(runtimePorts.gateway);
  }
}
