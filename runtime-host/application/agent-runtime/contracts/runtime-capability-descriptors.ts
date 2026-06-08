import {
  agentScope,
  connectorRuntimeEndpoint,
  nativeRuntimeEndpoint,
  type RuntimeEndpointRef,
  type RuntimeScope,
} from './runtime-address';
import type { RuntimeEndpointProfile } from './runtime-endpoint-types';
import type { CapabilityDescriptor, CapabilityOperationDescriptor } from '../../capabilities/contracts/capability-descriptor';
import { AGENT_RUN_CAPABILITY_ID, agentRunCapabilityOperations } from '../../capabilities/agent/agent-run-capability';
import { SESSION_APPROVAL_CAPABILITY_ID, sessionApprovalCapabilityOperations } from '../../capabilities/approval/session-approval-capability';
import { SESSION_MODEL_SELECTION_CAPABILITY_ID, sessionModelSelectionCapabilityOperations } from '../../capabilities/model/session-model-capability';
import { SESSION_MANAGEMENT_CAPABILITY_ID, sessionManagementCapabilityOperations } from '../../capabilities/session/session-management-capability';
import { SESSION_PROMPT_CAPABILITY_ID, sessionPromptCapabilityOperations } from '../../capabilities/session/session-prompt-capability';
import { TOOL_INVOKE_CAPABILITY_ID, toolInvokeCapabilityOperations } from '../../capabilities/tool/tool-invoke-capability';

export function buildRuntimeEndpointCapabilityDescriptors(input: {
  endpoint: RuntimeEndpointProfile;
  endpointRef?: RuntimeEndpointRef;
  agentId?: string;
  scope?: RuntimeScope;
  supportLevel: CapabilityDescriptor['supportLevel'];
  availability?: CapabilityDescriptor['availability'];
  ownerModuleId: string;
  routeOwnerId?: string;
}): CapabilityDescriptor[] {
  const scope = input.scope ?? agentScope(input.endpointRef ?? endpointRefForProfile(input.endpoint), readAgentId(input));
  const descriptors: CapabilityDescriptor[] = [];
  if (input.endpoint.capabilities.chat) {
    descriptors.push(...buildChatDescriptors(input, scope));
  }
  if (input.endpoint.capabilities.tools && (scope.kind === 'agent' || scope.kind === 'session')) {
    descriptors.push(createCapabilityDescriptor(input, scope, TOOL_INVOKE_CAPABILITY_ID, 'tool', toolInvokeCapabilityOperations));
  }
  if (input.endpoint.capabilities.approvals && scope.kind === 'session') {
    descriptors.push(createCapabilityDescriptor(input, scope, SESSION_APPROVAL_CAPABILITY_ID, 'approval', sessionApprovalCapabilityOperations));
  }
  if (input.endpoint.capabilities.modelSelection && scope.kind === 'session') {
    descriptors.push(createCapabilityDescriptor(input, scope, SESSION_MODEL_SELECTION_CAPABILITY_ID, 'session-model-selection', sessionModelSelectionCapabilityOperations));
  }
  return descriptors;
}

function buildChatDescriptors(
  input: {
    supportLevel: CapabilityDescriptor['supportLevel'];
    availability?: CapabilityDescriptor['availability'];
    ownerModuleId: string;
    routeOwnerId?: string;
  },
  scope: RuntimeScope,
): CapabilityDescriptor[] {
  if (scope.kind === 'runtime-instance') {
    return [
      createCapabilityDescriptor(input, scope, SESSION_MANAGEMENT_CAPABILITY_ID, 'session-management', filterOperations(sessionManagementCapabilityOperations, ['sessions.list'])),
    ];
  }
  if (scope.kind === 'agent') {
    return [
      createCapabilityDescriptor(input, scope, SESSION_PROMPT_CAPABILITY_ID, 'session', filterOperations(sessionPromptCapabilityOperations, ['sessions.create'])),
      createCapabilityDescriptor(input, scope, AGENT_RUN_CAPABILITY_ID, 'agent-run', agentRunCapabilityOperations),
    ];
  }
  if (scope.kind === 'session') {
    return [
      createCapabilityDescriptor(input, scope, SESSION_PROMPT_CAPABILITY_ID, 'session', filterOperations(sessionPromptCapabilityOperations, [
        'sessions.prompt',
        'sessions.sendWithMedia',
        'sessions.abort',
        'sessions.load',
      ])),
      createCapabilityDescriptor(input, scope, SESSION_MANAGEMENT_CAPABILITY_ID, 'session-management', filterOperations(sessionManagementCapabilityOperations, [
        'sessions.window',
        'sessions.delete',
        'sessions.rename',
        'sessions.archive',
        'sessions.unarchive',
        'sessions.updateStatus',
        'sessions.switch',
        'sessions.resume',
        'sessions.state',
      ])),
    ];
  }
  return [];
}

function createCapabilityDescriptor(
  input: {
    supportLevel: CapabilityDescriptor['supportLevel'];
    availability?: CapabilityDescriptor['availability'];
    ownerModuleId: string;
    routeOwnerId?: string;
  },
  scope: RuntimeScope,
  id: string,
  kind: string,
  operations: CapabilityOperationDescriptor[],
): CapabilityDescriptor {
  return {
    id,
    kind,
    scopeKind: scope.kind,
    scope,
    targetKinds: uniqueTargetKinds(operations),
    ...endpointMetadata(scope),
    ...targetAgentMetadata(scope),
    supportLevel: input.supportLevel,
    availability: input.availability ?? 'available',
    operations,
    policyScope: id,
    ownerModuleId: input.ownerModuleId,
    routeOwnerId: input.routeOwnerId ?? input.ownerModuleId,
  };
}

function endpointRefForProfile(endpoint: RuntimeEndpointProfile): RuntimeEndpointRef {
  if (endpoint.runtimeAdapterId && endpoint.runtimeInstanceId) {
    return nativeRuntimeEndpoint({
      runtimeAdapterId: endpoint.runtimeAdapterId,
      runtimeInstanceId: endpoint.runtimeInstanceId,
    });
  }
  if (endpoint.connectorId) {
    return connectorRuntimeEndpoint({
      protocolId: endpoint.protocolId,
      connectorId: endpoint.connectorId,
      endpointId: endpoint.id,
    });
  }
  throw new Error(`Runtime endpoint cannot be referenced: ${endpoint.id}`);
}

function readAgentId(input: { agentId?: string }): string {
  const agentId = input.agentId?.trim();
  if (!agentId) {
    throw new Error('Runtime endpoint capability descriptor requires agentId for agent scope');
  }
  return agentId;
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

function filterOperations(
  operations: readonly CapabilityOperationDescriptor[],
  operationIds: readonly string[],
): CapabilityOperationDescriptor[] {
  const allowed = new Set(operationIds);
  return operations.filter((operation) => allowed.has(operation.id));
}

function uniqueTargetKinds(operations: readonly CapabilityOperationDescriptor[]): CapabilityDescriptor['targetKinds'] {
  return Array.from(new Set(operations.map((operation) => operation.targetKind)));
}
