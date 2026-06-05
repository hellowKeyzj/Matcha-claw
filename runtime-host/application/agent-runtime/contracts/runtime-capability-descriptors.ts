import type { RuntimeAddress } from './runtime-address';
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
  address: RuntimeAddress;
  supportLevel: CapabilityDescriptor['supportLevel'];
  availability?: CapabilityDescriptor['availability'];
  ownerModuleId: string;
  routeOwnerId?: string;
}): CapabilityDescriptor[] {
  const descriptors: CapabilityDescriptor[] = [];
  if (input.endpoint.capabilities.chat) {
    descriptors.push(createCapabilityDescriptor(input, SESSION_PROMPT_CAPABILITY_ID, 'session', sessionPromptCapabilityOperations));
    descriptors.push(createCapabilityDescriptor(input, SESSION_MANAGEMENT_CAPABILITY_ID, 'session-management', sessionManagementCapabilityOperations));
    descriptors.push(createCapabilityDescriptor(input, AGENT_RUN_CAPABILITY_ID, 'agent-run', agentRunCapabilityOperations));
  }
  if (input.endpoint.capabilities.approvals) {
    descriptors.push(createCapabilityDescriptor(input, SESSION_APPROVAL_CAPABILITY_ID, 'approval', sessionApprovalCapabilityOperations));
  }
  if (input.endpoint.capabilities.tools) {
    descriptors.push(createCapabilityDescriptor(input, TOOL_INVOKE_CAPABILITY_ID, 'tool', toolInvokeCapabilityOperations));
  }
  if (input.endpoint.capabilities.modelSelection) {
    descriptors.push(createCapabilityDescriptor(input, SESSION_MODEL_SELECTION_CAPABILITY_ID, 'session-model-selection', sessionModelSelectionCapabilityOperations));
  }
  return descriptors;
}

function createCapabilityDescriptor(
  input: {
    address: RuntimeAddress;
    supportLevel: CapabilityDescriptor['supportLevel'];
    availability?: CapabilityDescriptor['availability'];
  },
  id: string,
  kind: string,
  operations: CapabilityOperationDescriptor[],
): CapabilityDescriptor {
  const address = {
    ...input.address,
    capabilityId: id,
  };
  return {
    id,
    kind,
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
    supportLevel: input.supportLevel,
    availability: input.availability ?? 'available',
    operations,
    policyScope: id,
    ownerModuleId: input.ownerModuleId,
    routeOwnerId: input.routeOwnerId ?? input.ownerModuleId,
  };
}
