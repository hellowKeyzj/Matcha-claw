import { badRequest, type ApplicationResponse } from '../../common/application-response';
import type { AgentSkillConfigService } from '../../subagents/agent-skill-config-service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationContext, CapabilityOperationRoute } from '../contracts/capability-router';

export const AGENT_SKILL_CONFIG_CAPABILITY_ID = 'agent.skill-config';

export const agentSkillConfigCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'agentSkillConfig.get', title: 'Get agent skill configuration', targetKind: 'subagent' },
  { id: 'agentSkillConfig.set', title: 'Set agent skill configuration', targetKind: 'subagent' },
] as const;

type AgentSkillConfigOperation = (input: Record<string, unknown>) => Promise<ApplicationResponse>;

function readInputString(input: Record<string, unknown>, key: 'agentId' | 'subagentId'): string {
  return typeof input[key] === 'string' ? input[key].trim() : '';
}

function handleSubagentTarget(
  context: CapabilityOperationContext,
  operation: AgentSkillConfigOperation,
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

export function createAgentSkillConfigCapabilityOperationRoutes(deps: {
  agentSkillConfigService: Pick<AgentSkillConfigService, 'getConfig' | 'setConfig'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: AGENT_SKILL_CONFIG_CAPABILITY_ID,
      operationId: 'agentSkillConfig.get',
      handle: (context) => handleSubagentTarget(context, (input) => deps.agentSkillConfigService.getConfig(input)),
    },
    {
      capabilityId: AGENT_SKILL_CONFIG_CAPABILITY_ID,
      operationId: 'agentSkillConfig.set',
      handle: (context) => handleSubagentTarget(context, (input) => deps.agentSkillConfigService.setConfig(input)),
    },
  ];
}
