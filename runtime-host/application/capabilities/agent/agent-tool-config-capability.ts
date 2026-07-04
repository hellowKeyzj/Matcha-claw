import { badRequest, type ApplicationResponse } from '../../common/application-response';
import type { AgentToolConfigService } from '../../subagents/agent-tool-config-service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationContext, CapabilityOperationRoute } from '../contracts/capability-router';

export const AGENT_TOOL_CONFIG_CAPABILITY_ID = 'agent.tool-config';

export const agentToolConfigCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'agentToolConfig.get', title: 'Get agent tool configuration', targetKind: 'subagent' },
  { id: 'agentToolConfig.set', title: 'Set agent tool configuration', targetKind: 'subagent' },
] as const;

type AgentToolConfigOperation = (input: Record<string, unknown>) => Promise<ApplicationResponse>;

function readInputString(input: Record<string, unknown>, key: 'agentId' | 'subagentId'): string {
  return typeof input[key] === 'string' ? input[key].trim() : '';
}

function handleSubagentTarget(
  context: CapabilityOperationContext,
  operation: AgentToolConfigOperation,
): Promise<ApplicationResponse> | ApplicationResponse {
  if (context.target?.kind !== 'subagent') {
    return badRequest('subagent target is required');
  }
  const targetSubagentId = typeof context.target.subagentId === 'string' ? context.target.subagentId.trim() : '';
  if (!targetSubagentId) {
    return badRequest('subagent target is required');
  }
  const requestedAgentId = readInputString(context.domainInput, 'agentId');
  if (requestedAgentId && requestedAgentId !== targetSubagentId) {
    return badRequest('agentId must match subagent target');
  }
  const requestedSubagentId = readInputString(context.domainInput, 'subagentId');
  if (requestedSubagentId && requestedSubagentId !== targetSubagentId) {
    return badRequest('subagentId must match subagent target');
  }
  return operation({
    ...context.domainInput,
    agentId: targetSubagentId,
    subagentId: targetSubagentId,
  });
}

export function createAgentToolConfigCapabilityOperationRoutes(deps: {
  agentToolConfigService: Pick<AgentToolConfigService, 'getConfig' | 'setConfig'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: AGENT_TOOL_CONFIG_CAPABILITY_ID,
      operationId: 'agentToolConfig.get',
      handle: (context) => handleSubagentTarget(context, (input) => deps.agentToolConfigService.getConfig(input)),
    },
    {
      capabilityId: AGENT_TOOL_CONFIG_CAPABILITY_ID,
      operationId: 'agentToolConfig.set',
      handle: (context) => handleSubagentTarget(context, (input) => deps.agentToolConfigService.setConfig(input)),
    },
  ];
}
